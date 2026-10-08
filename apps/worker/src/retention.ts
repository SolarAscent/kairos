import type { Pool, PoolClient } from "pg";

export const RETENTION_DAYS = 365;
export const RETENTION_INTERVAL_MS = 60_000;
const DAY_MS = 86_400_000;
const BATCH_SIZE = 100;

// All dynamic identifiers below come from this module, never from user input.
async function ids(client: PoolClient, query: string, values: unknown[]) {
  return (await client.query<{ id: string }>(query, values)).rows.map((row) => row.id);
}

/** Physically remove expired data, including copies without foreign keys.
 * Each bounded pass commits atomically. A failed pass leaves all data intact.
 */
export async function purgeExpiredData(pool: Pool, now?: Date) {
  const client = await pool.connect();
  const counts: Record<string, number> = {};
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='15s'");
    const locked = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(4812042027) AS locked",
    );
    if (!locked.rows[0]!.locked) {
      await client.query("COMMIT");
      return counts;
    }
    const at = now ?? (await client.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now;
    const cutoff = new Date(at.getTime() - RETENTION_DAYS * DAY_MS);
    const remove = async (name: string, query: string, values: unknown[]) => {
      counts[name] = (counts[name] ?? 0) + ((await client.query(query, values)).rowCount ?? 0);
    };

    const captureIds = await ids(
      client,
      "SELECT id FROM captures WHERE created_at <= $1 ORDER BY created_at,id LIMIT $2",
      [cutoff, BATCH_SIZE],
    );
    // Match the worker's event-before-entity lock order. Deleting its lease fences
    // any model request already in flight, so a late reply cannot recreate data.
    await remove("outbox", "DELETE FROM outbox_events WHERE aggregate_id=ANY($1::uuid[])", [
      captureIds,
    ]);
    const objectIds = await ids(
      client,
      `SELECT DISTINCT o.id FROM life_objects o
      WHERE o.id IN (SELECT id FROM life_objects WHERE created_at <= $1 ORDER BY created_at,id LIMIT $3)
        OR EXISTS (SELECT 1 FROM life_object_sources s WHERE s.life_object_id=o.id AND s.user_id=o.user_id
          AND s.source_type='CAPTURE' AND s.source_id=ANY($2::uuid[]))
        OR EXISTS (SELECT 1 FROM life_object_facets f WHERE f.life_object_id=o.id AND f.user_id=o.user_id
          AND f.origin_id=ANY($2::uuid[]))`,
      [cutoff, captureIds, BATCH_SIZE],
    );
    await remove("outbox", "DELETE FROM outbox_events WHERE aggregate_id=ANY($1::uuid[])", [
      objectIds,
    ]);
    const sessionIds = await ids(
      client,
      `SELECT DISTINCT s.id FROM decision_sessions s
      WHERE s.id IN (SELECT id FROM decision_sessions WHERE created_at <= $1 ORDER BY created_at,id LIMIT $3)
        OR s.user_id IN (SELECT user_id FROM captures WHERE id=ANY($4::uuid[])
          UNION SELECT user_id FROM life_objects WHERE id=ANY($2::uuid[]))
        OR EXISTS (SELECT 1 FROM action_candidates a WHERE a.decision_session_id=s.id
          AND a.user_id=s.user_id AND a.target_life_object_id=ANY($2::uuid[]))`,
      [cutoff, objectIds, BATCH_SIZE, captureIds],
    );
    const feedbackIds = await ids(
      client,
      "SELECT id FROM feedback_events WHERE decision_session_id=ANY($1::uuid[])",
      [sessionIds],
    );
    const affectedIds = [...captureIds, ...objectIds, ...sessionIds, ...feedbackIds];
    await remove("outbox", "DELETE FROM outbox_events WHERE aggregate_id=ANY($1::uuid[])", [
      affectedIds,
    ]);
    // Inferred preferences must not outlive the feedback or object they describe.
    const affectedUsers = (
      await client.query<{ user_id: string }>(
        `DELETE FROM preference_signals
      WHERE source_id=ANY($1::uuid[]) OR value->>'lifeObjectId'=ANY($2::text[])
        OR created_at <= $3 OR expires_at <= $4 RETURNING user_id`,
        [affectedIds, objectIds, cutoff, at],
      )
    ).rows.map((row) => row.user_id);
    await remove(
      "preference_state",
      `DELETE FROM preference_state
      WHERE user_id=ANY($1::uuid[]) OR rebuilt_at <= $2`,
      [affectedUsers, cutoff],
    );
    await remove("agent_runs", "DELETE FROM agent_runs WHERE entity_id=ANY($1::uuid[])", [
      affectedIds,
    ]);
    await remove(
      "audit",
      `DELETE FROM audit_events a WHERE target_id=ANY($1::uuid[])
      OR EXISTS (SELECT 1 FROM unnest($1::text[]) expired(id)
        WHERE position(expired.id IN a.metadata::text)>0)`,
      [affectedIds],
    );
    // Cached responses are another copy. Preserve unrelated live idempotency keys.
    await remove(
      "idempotency",
      `DELETE FROM idempotency_keys k WHERE EXISTS (
      SELECT 1 FROM unnest($1::text[]) expired(id) WHERE position(expired.id IN k.response_body::text)>0)`,
      [affectedIds],
    );
    await remove("sessions", "DELETE FROM decision_sessions WHERE id=ANY($1::uuid[])", [
      sessionIds,
    ]);
    await remove("objects", "DELETE FROM life_objects WHERE id=ANY($1::uuid[])", [objectIds]);
    await remove(
      "sources",
      "DELETE FROM life_object_sources WHERE source_type='CAPTURE' AND source_id=ANY($1::uuid[])",
      [captureIds],
    );
    await remove("captures", "DELETE FROM captures WHERE id=ANY($1::uuid[])", [captureIds]);
    // Images/transcripts are stored in capture_assets and cascade with captures.
    await remove(
      "assets",
      `DELETE FROM capture_assets WHERE id IN (
      SELECT id FROM capture_assets WHERE retain_until <= $1 OR created_at <= $2 LIMIT $3)`,
      [at, cutoff, BATCH_SIZE],
    );
    await remove(
      "snapshots",
      `DELETE FROM context_snapshots WHERE id IN (
      SELECT id FROM context_snapshots WHERE purge_at <= $1 OR created_at <= $2
        OR (contains_precise_location AND created_at <= $3) LIMIT $4)`,
      [at, cutoff, new Date(at.getTime() - 2 * 3_600_000), BATCH_SIZE],
    );
    for (const [table, column] of [
      ["agent_runs", "started_at"],
      ["model_calls", "created_at"],
      ["audit_events", "created_at"],
      ["outbox_events", "created_at"],
      ["user_settings", "updated_at"],
    ]) {
      const key = table === "user_settings" ? "user_id" : "id";
      await remove(
        table!,
        `DELETE FROM ${table} WHERE ${key} IN (
        SELECT ${key} FROM ${table} WHERE ${column} <= $1 LIMIT $2)`,
        [cutoff, BATCH_SIZE],
      );
    }
    await remove(
      "idempotency",
      `DELETE FROM idempotency_keys WHERE (user_id,route,idempotency_key) IN (
      SELECT user_id,route,idempotency_key FROM idempotency_keys WHERE expires_at <= $1 OR created_at <= $2 LIMIT $3)`,
      [at, cutoff, BATCH_SIZE],
    );
    await remove(
      "auth_sessions",
      `DELETE FROM auth_sessions WHERE id IN (
      SELECT id FROM auth_sessions WHERE expires_at <= $1 OR revoked_at IS NOT NULL OR created_at <= $2 LIMIT $3)`,
      [at, cutoff, BATCH_SIZE],
    );

    // Active identity/settings are needed for service; remove the whole account
    // after 365 days without successful login, refresh, or authenticated use.
    const userIds = await ids(
      client,
      `SELECT id FROM users WHERE last_active_at <= $1
      ORDER BY last_active_at,id FOR UPDATE SKIP LOCKED LIMIT $2`,
      [cutoff, BATCH_SIZE],
    );
    await remove(
      "outbox",
      `DELETE FROM outbox_events WHERE payload->>'userId'=ANY($1::text[])
      OR aggregate_id IN (SELECT id FROM captures WHERE user_id=ANY($1::uuid[])
        UNION ALL SELECT id FROM life_objects WHERE user_id=ANY($1::uuid[])
        UNION ALL SELECT id FROM feedback_events WHERE user_id=ANY($1::uuid[])
        UNION ALL SELECT id FROM decision_sessions WHERE user_id=ANY($1::uuid[]))`,
      [userIds],
    );
    await remove(
      "audit",
      `DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[])
      OR target_id=ANY($1::uuid[]) OR target_id IN (
        SELECT id FROM captures WHERE user_id=ANY($1::uuid[])
        UNION ALL SELECT id FROM life_objects WHERE user_id=ANY($1::uuid[])
        UNION ALL SELECT id FROM feedback_events WHERE user_id=ANY($1::uuid[])
        UNION ALL SELECT id FROM decision_sessions WHERE user_id=ANY($1::uuid[]))`,
      [userIds],
    );
    await remove("users", "DELETE FROM users WHERE id=ANY($1::uuid[]) AND last_active_at <= $2", [
      userIds,
      cutoff,
    ]);
    await client.query("COMMIT");
    return counts;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Awaited maintenance: no overlapping timer jobs, bounded shutdown delay. */
export async function runRetentionLoop(pool: Pool, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const counts = await purgeExpiredData(pool);
      if (Object.values(counts).some((count) => count > 0)) {
        console.log(JSON.stringify({ level: "info", event: "retention_purged", counts }));
        // Drain an overdue backlog in bounded transactions before sleeping.
        continue;
      }
    } catch {
      // No record contents, coordinates, identifiers, or database error details.
      console.error(JSON.stringify({ level: "error", code: "RETENTION_PURGE_FAILED" }));
    }
    if (!signal.aborted)
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", wake);
          resolve();
        };
        const timer = setTimeout(wake, RETENTION_INTERVAL_MS);
        signal.addEventListener("abort", wake, { once: true });
        if (signal.aborted) wake();
      });
  }
}
