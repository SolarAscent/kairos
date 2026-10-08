import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase } from "@life/db";
import { migrate } from "../../packages/db/dist/migrations.js";
import { purgeExpiredData, runRetentionLoop } from "../../apps/worker/dist/retention.js";
import { OutboxWorker } from "../../apps/worker/dist/worker.js";
import { MockModelProvider } from "@life/agent-core";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
const schema = "retention_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(testUrl);
const scoped = new URL(testUrl);
scoped.searchParams.set("options", `-c search_path=${schema}`);
const { pool } = createDatabase(scoped.toString());
const now = new Date("2027-10-08T04:00:00Z");
const cutoff = new Date(now.getTime() - 365 * 86_400_000);
const fresh = new Date(now.getTime() - 86_400_000);
const originalEnv = { ...process.env };
let app: Awaited<ReturnType<typeof createApiApp>>;

async function user(active = fresh) {
  const id = randomUUID();
  await pool.query("INSERT INTO users(id,created_at,last_active_at) VALUES($1,$2,$3)", [
    id,
    cutoff,
    active,
  ]);
  return id;
}
async function capture(userId: string, date = cutoff, type = "TEXT") {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO captures(id,user_id,capture_type,source_channel,text_content,created_at)
    VALUES($1,$2,$3,'TEST','我想去图书馆读书',$4)`,
    [id, userId, type, date],
  );
  return id;
}
async function object(userId: string, date = fresh, captureId?: string) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO life_objects(id,user_id,title,kind,created_at) VALUES($1,$2,'private','DESIRE',$3)",
    [id, userId, date],
  );
  await pool.query(
    "INSERT INTO life_object_projection(life_object_id,user_id,search_text,projection_version) VALUES($1,$2,'private','test')",
    [id, userId],
  );
  await pool.query(
    `INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,data,confidence,origin_type,origin_id)
    VALUES($1,$2,$3,'PLACE','place','{"address":"private"}',1,'EXTRACTED',$4)`,
    [randomUUID(), userId, id, captureId ?? null],
  );
  if (captureId)
    await pool.query(
      `INSERT INTO life_object_sources(id,user_id,life_object_id,source_type,source_id,confidence,evidence)
    VALUES($1,$2,$3,'CAPTURE',$4,1,'{"text":"private"}')`,
      [randomUUID(), userId, id, captureId],
    );
  return id;
}
async function session(userId: string, objectId?: string, date = fresh) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO decision_sessions(id,user_id,scoring_version,question_policy_version,context_summary,created_at,expires_at)
    VALUES($1,$2,'test','test','{"region":"private"}',$3,$4)`,
    [id, userId, date, now],
  );
  if (objectId)
    await pool.query(
      `INSERT INTO action_candidates(id,user_id,decision_session_id,target_life_object_id,action_type,
    action_payload,value_score,fit_score,friction_score,urgency_score,uncertainty_score,total_score,hard_filter_status,generator_version,scoring_version)
    VALUES($1,$2,$3,$4,'VISIT','{"address":"private"}',1,1,1,1,1,1,'PASS','test','test')`,
      [randomUUID(), userId, id, objectId],
    );
  return id;
}
async function queued(userId: string, id: string, date = fresh) {
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,created_at)
    VALUES($1,'CAPTURE',$2,'CAPTURE_CREATED',$3,$4)`,
    [eventId, id, { captureId: id, userId }, date],
  );
  return eventId;
}
async function count(table: string, where = "true", args: unknown[] = []) {
  return Number(
    (await pool.query(`SELECT count(*) AS count FROM ${table} WHERE ${where}`, args)).rows[0].count,
  );
}

beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
  await migrate(pool);
  Object.assign(process.env, {
    DATABASE_URL: scoped.toString(),
    JWT_SECRET: "retention-test-only-secret-at-least-32-bytes",
    WECHAT_MOCK_LOGIN: "true",
    NODE_ENV: "test",
  });
  app = await createApiApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 30_000);
beforeEach(async () => {
  await pool.query("TRUNCATE users,outbox_events,audit_events CASCADE");
});
afterAll(async () => {
  if (app) await app.close();
  await pool.end();
  await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe("365-day physical retention", () => {
  it("backfills existing account activity without resetting historical clocks on migration", async () => {
    const legacySchema = schema + "_legacy";
    const legacyUrl = new URL(testUrl!);
    legacyUrl.searchParams.set("options", `-c search_path=${legacySchema}`);
    const legacy = createDatabase(legacyUrl.toString());
    await admin.pool.query(`CREATE SCHEMA "${legacySchema}"`);
    try {
      await legacy.pool.query(
        await readFile(
          new URL("../../packages/db/migrations/0001_initial.sql", import.meta.url),
          "utf8",
        ),
      );
      await legacy.pool.query(
        "CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
      );
      await legacy.pool.query("INSERT INTO schema_migrations(name) VALUES('0001_initial.sql')");
      const inactive = randomUUID(),
        active = randomUUID();
      for (const id of [inactive, active])
        await legacy.pool.query("INSERT INTO users(id,created_at,updated_at) VALUES($1,$2,$2)", [
          id,
          cutoff,
        ]);
      await legacy.pool.query(
        `INSERT INTO auth_sessions(id,user_id,refresh_token_hash,created_at,last_seen_at,expires_at)
        VALUES($1,$2,'synthetic',$3,$4,$5)`,
        [randomUUID(), active, cutoff, fresh, now],
      );
      await migrate(legacy.pool);
      const rows = (await legacy.pool.query("SELECT id,last_active_at FROM users")).rows;
      expect(rows.find((row) => row.id === inactive).last_active_at).toEqual(cutoff);
      expect(rows.find((row) => row.id === active).last_active_at).toEqual(fresh);
    } finally {
      await legacy.pool.end();
      await admin.pool.query(`DROP SCHEMA "${legacySchema}" CASCADE`);
    }
  });
  it("drains a backlog in bounded batches without touching live records", async () => {
    const owner = await user();
    await pool.query(
      `INSERT INTO captures(id,user_id,capture_type,source_channel,text_content,created_at)
      SELECT gen_random_uuid(),$1,'TEXT','TEST','expired',$2 FROM generate_series(1,201)`,
      [owner, cutoff],
    );
    const live = await capture(owner, fresh);
    expect((await purgeExpiredData(pool, now)).captures).toBe(100);
    expect((await purgeExpiredData(pool, now)).captures).toBe(100);
    expect((await purgeExpiredData(pool, now)).captures).toBe(1);
    expect(await count("captures")).toBe(1);
    expect(await count("captures", "id=$1", [live])).toBe(1);
  });
  it("deletes original images, transcripts and every derived copy; keeps another user's live records", async () => {
    const owner = await user(),
      other = await user();
    const old = await capture(owner, cutoff, "IMAGE");
    const linked = await object(owner, fresh, old);
    const decision = await session(owner, linked);
    await session(owner); // Context copies can exist without a candidate FK.
    const candidate = (
      await pool.query("SELECT id FROM action_candidates WHERE decision_session_id=$1", [decision])
    ).rows[0].id;
    const recommendation = randomUUID(),
      feedback = randomUUID();
    await pool.query(
      `INSERT INTO recommendations(id,user_id,decision_session_id,action_candidate_id,headline,execution_type,execution_payload,copy_version)
      VALUES($1,$2,$3,$4,'private','INTERNAL','{"address":"private"}','test')`,
      [recommendation, owner, decision, candidate],
    );
    await pool.query(
      `INSERT INTO feedback_events(id,user_id,recommendation_id,decision_session_id,event_type,client_event_id,metadata)
      VALUES($1,$2,$3,$4,'ACCEPT',$5,'{"private":"data"}')`,
      [feedback, owner, recommendation, decision, randomUUID()],
    );
    await pool.query(
      `INSERT INTO preference_signals(id,user_id,dimension,value,polarity,strength,confidence,source_type,source_id,occurred_at)
      VALUES($1,$2,'activity','{"private":"data"}',1,1,1,'ACCEPT',$3,$4)`,
      [randomUUID(), owner, feedback, fresh],
    );
    await pool.query(
      'INSERT INTO preference_state(user_id,profile) VALUES($1,\'{"private":"data"}\')',
      [owner],
    );
    await pool.query(
      `INSERT INTO clarification_requests(id,user_id,scope_type,decision_session_id,question_key,question_text,options,sequence,status)
      VALUES($1,$2,'DECISION',$3,'test','private','[]',1,'ANSWERED')`,
      [randomUUID(), owner, decision],
    );
    const otherCapture = await capture(other, fresh);
    const otherObject = await object(other, fresh, otherCapture);
    await session(other, otherObject);
    for (const type of ["IMAGE", "TRANSCRIPT"])
      await pool.query(
        `INSERT INTO capture_assets(id,user_id,capture_id,asset_type,storage_key,mime_type,size_bytes,sha256)
      VALUES($1,$2,$3,$4,'private','image/png',1,'synthetic')`,
        [randomUUID(), owner, old, type],
      );
    await queued(owner, old);
    await pool.query(
      `INSERT INTO agent_runs(id,user_id,purpose,entity_type,entity_id,pipeline_version,status,trace_id)
      VALUES($1,$2,'CAPTURE_PARSE','CAPTURE',$3,'test','SUCCEEDED',$4)`,
      [old, owner, old, randomUUID()],
    );
    await pool.query(
      `INSERT INTO model_calls(id,agent_run_id,provider,model,prompt_name,prompt_version,schema_version,input_hash,status,structured_output,latency_ms)
      VALUES($1,$2,'mock','mock','parse','test','test','synthetic','SUCCEEDED','{"private":"data"}',1)`,
      [randomUUID(), old],
    );
    await pool.query(
      `INSERT INTO audit_events(id,actor_type,action,target_type,target_id,metadata,trace_id)
      VALUES($1,'WORKER','PARSED','CAPTURE',$2,$3,$4)`,
      [randomUUID(), old, { objectIds: [linked] }, randomUUID()],
    );
    const key = randomUUID(),
      liveKey = randomUUID();
    for (const [k, response] of [
      [key, { sessionId: decision }],
      [liveKey, { captureId: otherCapture }],
    ])
      await pool.query(
        `INSERT INTO idempotency_keys(user_id,route,idempotency_key,request_hash,response_body,expires_at)
        VALUES($1,'/test',$2,'synthetic',$3,$4)`,
        [owner, k, response, new Date(now.getTime() + 86400000)],
      );
    await purgeExpiredData(pool, now);
    for (const table of [
      "capture_assets",
      "life_object_facets",
      "life_object_sources",
      "life_object_projection",
      "decision_sessions",
      "action_candidates",
      "recommendations",
      "feedback_events",
      "preference_signals",
      "preference_state",
      "clarification_requests",
      "agent_runs",
    ])
      expect(await count(table, "user_id=$1", [owner]), table).toBe(0);
    for (const table of ["model_calls", "outbox_events", "audit_events"])
      expect(await count(table), table).toBe(0);
    expect(await count("captures", "id=$1", [old])).toBe(0);
    expect(await count("idempotency_keys", "idempotency_key=$1", [key])).toBe(0);
    expect(await count("idempotency_keys", "idempotency_key=$1", [liveKey])).toBe(1);
    expect(await count("captures", "id=$1", [otherCapture])).toBe(1);
    expect(await count("life_objects", "id=$1", [otherObject])).toBe(1);
  });
  it("uses creation time, including the exact 365-day boundary; edits do not extend it", async () => {
    const owner = await user();
    const old = await capture(owner, cutoff);
    const live = await capture(owner, new Date(cutoff.getTime() + 1));
    const oldObject = await object(owner, cutoff);
    await pool.query("UPDATE captures SET updated_at=$1 WHERE id=$2", [now, old]);
    await purgeExpiredData(pool, now);
    expect(await count("captures", "id=$1", [old])).toBe(0);
    expect(await count("life_objects", "id=$1", [oldObject])).toBe(0);
    expect(await count("captures", "id=$1", [live])).toBe(1);
    expect(Object.values(await purgeExpiredData(pool, now)).every((n) => n === 0)).toBe(true);
  });
  it("purges accounts after inactivity and removes queue/audit rows lacking user FKs", async () => {
    const inactive = await user(cutoff),
      active = await user(fresh);
    const pending = await capture(inactive, fresh);
    await object(inactive, fresh, pending);
    await queued(inactive, pending);
    await pool.query(
      `INSERT INTO user_identities(id,user_id,provider,provider_subject) VALUES($1,$2,'WECHAT','synthetic')`,
      [randomUUID(), inactive],
    );
    await pool.query(
      `INSERT INTO audit_events(id,actor_type,actor_id,action,target_type,target_id,metadata,trace_id)
      VALUES($1,'USER',$2,'TEST','USER',$2,'{}',$3)`,
      [randomUUID(), inactive, randomUUID()],
    );
    await purgeExpiredData(pool, now);
    for (const table of ["user_identities", "captures", "life_objects"])
      expect(await count(table, "user_id=$1", [inactive])).toBe(0);
    expect(await count("outbox_events")).toBe(0);
    expect(await count("audit_events")).toBe(0);
    expect(await count("users", "id=$1", [inactive])).toBe(0);
    expect(await count("users", "id=$1", [active])).toBe(1);
  });
  it("purges precise snapshots at two hours and honors shorter asset/cache deadlines", async () => {
    const owner = await user(),
      source = await capture(owner, fresh),
      decision = await session(owner);
    const snapshot = randomUUID();
    await pool.query(
      `INSERT INTO context_snapshots(id,user_id,decision_session_id,context,contains_precise_location,created_at)
      VALUES($1,$2,$3,'{"latitude":1,"longitude":2}',true,$4)`,
      [snapshot, owner, decision, new Date(now.getTime() - 7200000)],
    );
    await pool.query(
      `INSERT INTO capture_assets(id,user_id,capture_id,asset_type,storage_key,mime_type,size_bytes,sha256,retain_until)
      VALUES($1,$2,$3,'IMAGE','private','image/png',1,'synthetic',$4)`,
      [randomUUID(), owner, source, now],
    );
    await purgeExpiredData(pool, now);
    expect(await count("context_snapshots")).toBe(0);
    expect(await count("capture_assets")).toBe(0);
    expect(await count("captures")).toBe(1);
  });
  it("fences a model response already in flight so it cannot recreate expired data", async () => {
    const owner = await user(),
      old = await capture(owner);
    await queued(owner, old);
    const model = new MockModelProvider();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new OutboxWorker(pool, {
      providerName: model.providerName,
      modelName: model.modelName,
      parseCapture: async (input) => {
        entered();
        await gate;
        return model.parseCapture(input);
      },
    });
    const processing = worker.processNext();
    try {
      await ready;
      await purgeExpiredData(pool, now);
    } finally {
      release();
      await processing;
    }
    expect(await count("captures")).toBe(0);
    expect(await count("life_objects")).toBe(0);
    expect(await count("agent_runs")).toBe(0);
    expect(await count("outbox_events")).toBe(0);
  });
  it("serializes janitors and rolls back all deletes if a later statement fails", async () => {
    const owner = await user(),
      old = await capture(owner);
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(4812042027)");
      expect(await purgeExpiredData(pool, now)).toEqual({});
      expect(await count("captures", "id=$1", [old])).toBe(1);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    await pool.query("ALTER TABLE audit_events RENAME TO audit_events_hidden");
    try {
      await expect(purgeExpiredData(pool, now)).rejects.toThrow();
    } finally {
      await pool.query("ALTER TABLE audit_events_hidden RENAME TO audit_events");
    }
    expect(await count("captures", "id=$1", [old])).toBe(1);
  });
  it("records successful login, authenticated use and refresh; maintenance wakes on shutdown", async () => {
    const login = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/wechat/login",
        payload: { code: randomUUID() },
      })
    ).json().data;
    const oldDate = new Date(Date.now() - 400 * 86400000);
    await pool.query("UPDATE users SET last_active_at=$1 WHERE id=$2", [oldDate, login.userId]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/context",
          headers: { authorization: `Bearer ${login.accessToken}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await pool.query("SELECT last_active_at FROM users WHERE id=$1", [login.userId])
      ).rows[0].last_active_at.getTime(),
    ).toBeGreaterThan(oldDate.getTime());
    await pool.query("UPDATE users SET last_active_at=$1 WHERE id=$2", [oldDate, login.userId]);
    const refresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: login.refreshToken },
    });
    expect(refresh.statusCode).toBe(201);
    expect(
      (
        await pool.query("SELECT last_active_at FROM users WHERE id=$1", [login.userId])
      ).rows[0].last_active_at.getTime(),
    ).toBeGreaterThan(oldDate.getTime());
    const abort = new AbortController();
    const loop = runRetentionLoop(pool, abort.signal);
    abort.abort();
    await loop;
  });
});
