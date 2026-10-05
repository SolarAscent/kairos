import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@life/db";
import {
  facetTypeSchema,
  lifeDeckResponseSchema,
  lifeStacksResponseSchema,
  lifeRatingAcceptedSchema,
  lifeDeletedSchema,
} from "@life/contracts";
import { migrate } from "../../packages/db/dist/migrations.js";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";
import { PreferenceReader } from "../../apps/api/dist/feedback/preference-reader.js";
import { ActionPlanService } from "../../apps/api/dist/planning/action-plan.service.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
const schema = "life_prefs_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(testUrl),
  url = new URL(testUrl);
url.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(url.toString()),
  pool = source.pool;
let app: Awaited<ReturnType<typeof createApiApp>>,
  token = "",
  otherToken = "",
  userId = "",
  otherUserId = "";
async function req(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: object,
  bearer = token,
  key = randomUUID(),
) {
  return app.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${bearer}`,
      "x-idempotency-key": key,
      ...(method === "DELETE" ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { payload: body } : method === "DELETE" ? { payload: {} } : {}),
  });
}
async function object(kind = "MEDIA", status = "ACTIVE", owner = userId, importance = 0.5) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO life_objects(id,user_id,title,kind,status,importance_score,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'2026-09-01T00:00:00.123456Z')`,
    [id, owner, "Probe " + id, kind, status, importance],
  );
  return id;
}
beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = "life-preference-test-secret-over-32-characters";
  process.env.WECHAT_MOCK_LOGIN = "true";
  process.env.NODE_ENV = "test";
  app = await createApiApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  for (const other of [false, true]) {
    const response = await req("POST", "/v1/auth/wechat/login", { code: randomUUID() });
    expect(response.statusCode).toBe(201);
    const login = response.json().data;
    if (other) {
      otherToken = login.accessToken;
      otherUserId = login.userId;
    } else {
      token = login.accessToken;
      userId = login.userId;
    }
  }
}, 30000);
afterAll(async () => {
  if (app) await app.close();
  await pool.end();
  await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
});

describe("owner-scoped life votes and category decks", () => {
  it("sets, changes and withdraws votes idempotently without accumulating duplicate clicks", async () => {
    const id = await object(),
      key = randomUUID();
    expect(
      (await req("POST", `/v1/life/${id}/rating`, { rating: "LIKE" }, otherToken)).statusCode,
    ).toBe(404);
    const liked = await req("POST", `/v1/life/${id}/rating`, { rating: "LIKE" }, token, key);
    expect(liked.statusCode).toBe(201);
    expect(lifeRatingAcceptedSchema.parse(liked.json().data).rating).toBe("LIKE");
    expect(
      (await req("POST", `/v1/life/${id}/rating`, { rating: "LIKE" }, token, key)).json().data
        .replayed,
    ).toBe(true);
    expect(
      (await req("POST", `/v1/life/${id}/rating`, { rating: "DISLIKE" }, token, key)).statusCode,
    ).toBe(409);
    await req("POST", `/v1/life/${id}/rating`, { rating: "LIKE" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM preference_signals WHERE value->>'lifeObjectId'=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
    await req("POST", `/v1/life/${id}/rating`, { rating: "DISLIKE" });
    const prefs = new PreferenceReader(source.db);
    expect(
      (await prefs.read(userId, [{ id, kind: "MEDIA" }])).get(id)?.preferenceScore,
    ).toBeLessThan(-0.5);
    await req("POST", `/v1/life/${id}/rating`, { rating: "NONE" });
    expect((await prefs.read(userId, [{ id, kind: "MEDIA" }])).get(id)?.myRating).toBe("NONE");
    expect((await prefs.read(otherUserId, [{ id, kind: "MEDIA" }])).has(id)).toBe(false);
    expect((await req("POST", `/v1/life/${id}/rating`, { rating: "LOVE" })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/life/${id}/rating`,
          payload: { rating: "LIKE" },
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("covers every visible category and keeps the first-page preference snapshot after a changed vote", async () => {
    const kinds = facetTypeSchema.options.filter((kind) => kind !== "MEDIA");
    for (const kind of kinds) await object(kind);
    const ids = await Promise.all(Array.from({ length: 31 }, () => object()));
    const resolved = await object("MEDIA", "RESOLVED"),
      archived = await object("MEDIA", "ARCHIVED");
    await req("POST", `/v1/life/${ids[0]}/rating`, { rating: "LIKE" });
    const first = lifeDeckResponseSchema.parse(
      (await req("POST", "/v1/life/deck", { kind: "MEDIA", limit: 5 })).json().data,
    );
    expect(first.items[0]?.id).toBe(ids[0]);
    expect(first.items[0]?.myRating).toBe("LIKE");
    expect(first.nextCursor).not.toBeNull();
    await req("POST", `/v1/life/${ids[0]}/rating`, { rating: "DISLIKE" });
    await req("POST", `/v1/life/${ids[30]}/rating`, { rating: "LIKE" });
    const all = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = lifeDeckResponseSchema.parse(
        (await req("POST", "/v1/life/deck", { kind: "MEDIA", limit: 5, cursor })).json().data,
      );
      expect(page.asOf).toBe(first.asOf);
      all.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    for (const id of [...ids, resolved]) expect(all.some((item) => item.id === id)).toBe(true);
    expect(all.some((item) => item.id === archived)).toBe(false);
    const stacksResponse = await req("GET", "/v1/life/stacks");
    expect(stacksResponse.statusCode).toBe(200);
    const stacks = lifeStacksResponseSchema.parse(stacksResponse.json().data);
    expect(stacks.map((group) => group.kind).sort()).toEqual([...facetTypeSchema.options].sort());
    expect(stacks.find((group) => group.kind === "MEDIA")?.items.length).toBe(10);
    expect(
      (await req("POST", "/v1/life/deck", { kind: "EVENT", cursor: first.nextCursor })).statusCode,
    ).toBe(400);
    const search = await req("POST", "/v1/life/search", {
      section: "RECENT",
      kind: "MEDIA",
      limit: 50,
    });
    expect(
      search.json().data.items.find((item: { id: string }) => item.id === ids[0]).myRating,
    ).toBe("DISLIKE");
  });

  it("uses importance only after learned preference and pages a thousand objects without a candidate truncation", async () => {
    const medium = await object("COLLECTION", "ACTIVE", userId, 0.3);
    const important = await object("COLLECTION", "ACTIVE", userId, 0.9);
    await req("POST", `/v1/life/${medium}/rating`, { rating: "LIKE" });
    const initial = await req("POST", "/v1/life/deck", { kind: "COLLECTION" });
    expect(
      initial
        .json()
        .data.items.slice(0, 2)
        .map((item: { id: string }) => item.id),
    ).toEqual([medium, important]);
    await pool.query(
      `INSERT INTO life_objects(id,user_id,title,kind,created_at)
      SELECT gen_random_uuid(),$1,'Perf probe '||s,'COLLECTION','2026-09-01T00:00:00.123456Z'
      FROM generate_series(1,1000) s`,
      [userId],
    );
    const start = performance.now();
    const stacks = await req("GET", "/v1/life/stacks");
    const stacksMs = performance.now() - start;
    expect(stacks.statusCode).toBe(200);
    expect(stacksMs).toBeLessThan(2000);
    let cursor: string | null = null,
      count = 0;
    const seen = new Set<string>();
    do {
      const page = await req("POST", "/v1/life/deck", {
        kind: "COLLECTION",
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.statusCode).toBe(200);
      for (const item of page.json().data.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
        count++;
      }
      cursor = page.json().data.nextCursor;
    } while (cursor);
    expect(count).toBe(1003);
    console.info(
      JSON.stringify({
        probe: "life-deck-1000",
        stacksMs: Math.round(stacksMs),
        pages: Math.ceil(count / 50),
      }),
    );
  });

  it("soft deletes any object, cancels its active plan and pending question, and does not learn dislike", async () => {
    const id = await object(),
      sessionId = randomUUID(),
      candidateId = randomUUID(),
      recommendationId = randomUUID();
    await pool.query(
      `INSERT INTO decision_sessions(id,user_id,status,scoring_version,question_policy_version,context_summary,expires_at)
      VALUES($1,$2,'RECOMMENDED','test','test','{}',now()+interval '1 day')`,
      [sessionId, userId],
    );
    await pool.query(
      `INSERT INTO action_candidates(id,user_id,decision_session_id,target_life_object_id,action_type,action_payload,
      value_score,fit_score,friction_score,urgency_score,uncertainty_score,total_score,hard_filter_status,generator_version,scoring_version)
      VALUES($1,$2,$3,$4,'VIEW_CONTENT','{}',0.5,0.5,0.1,0.1,0.1,0.5,'PASS','test','test')`,
      [candidateId, userId, sessionId, id],
    );
    await pool.query(
      `INSERT INTO recommendations(id,user_id,decision_session_id,action_candidate_id,headline,execution_type,execution_payload,copy_version)
      VALUES($1,$2,$3,$4,'probe','VIEW_CONTENT','{}','test')`,
      [recommendationId, userId, sessionId, candidateId],
    );
    await pool.query(
      `INSERT INTO feedback_events(id,user_id,recommendation_id,decision_session_id,event_type,client_event_id)
      VALUES($1,$2,$3,$4,'ACCEPT',$5)`,
      [randomUUID(), userId, recommendationId, sessionId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO clarification_requests(id,user_id,decision_session_id,scope_type,question_key,question_text,options,sequence,status)
      VALUES($1,$2,$3,'NOW','AVAILABLE_TIME','probe','[]',1,'PENDING')`,
      [randomUUID(), userId, sessionId],
    );
    const otherId = await object(),
      otherSession = randomUUID(),
      otherCandidate = randomUUID(),
      otherRecommendation = randomUUID();
    await pool.query(
      `INSERT INTO decision_sessions(id,user_id,status,scoring_version,question_policy_version,context_summary,expires_at)
      VALUES($1,$2,'RECOMMENDED','test','test','{}',now()+interval '1 day')`,
      [otherSession, userId],
    );
    for (const [candidate, target] of [
      [otherCandidate, otherId],
      [randomUUID(), id],
    ]) {
      await pool.query(
        `INSERT INTO action_candidates(id,user_id,decision_session_id,target_life_object_id,action_type,action_payload,
        value_score,fit_score,friction_score,urgency_score,uncertainty_score,total_score,hard_filter_status,generator_version,scoring_version)
        VALUES($1,$2,$3,$4,'VIEW_CONTENT','{}',0.5,0.5,0.1,0.1,0.1,0.5,'PASS','test','test')`,
        [candidate, userId, otherSession, target],
      );
    }
    await pool.query(
      `INSERT INTO recommendations(id,user_id,decision_session_id,action_candidate_id,headline,execution_type,execution_payload,copy_version)
      VALUES($1,$2,$3,$4,'other active plan','VIEW_CONTENT','{}','test')`,
      [otherRecommendation, userId, otherSession, otherCandidate],
    );
    await pool.query(
      `INSERT INTO feedback_events(id,user_id,recommendation_id,decision_session_id,event_type,client_event_id)
      VALUES($1,$2,$3,$4,'ACCEPT',$5)`,
      [randomUUID(), userId, otherRecommendation, otherSession, randomUUID()],
    );
    expect((await req("DELETE", `/v1/life/${id}`, undefined, otherToken)).statusCode).toBe(404);
    const key = randomUUID(),
      deleted = await req("DELETE", `/v1/life/${id}`, undefined, token, key);
    expect(deleted.statusCode).toBe(200);
    expect(lifeDeletedSchema.parse(deleted.json().data).deleted).toBe(true);
    expect(
      (await req("DELETE", `/v1/life/${id}`, undefined, token, key)).json().data.replayed,
    ).toBe(true);
    expect((await req("DELETE", `/v1/life/${id}`)).statusCode).toBe(200);
    const state = await pool.query(
      "SELECT status,deleted_at,object_version FROM life_objects WHERE id=$1",
      [id],
    );
    expect(state.rows[0].status).toBe("DELETED");
    expect(state.rows[0].object_version).toBe(2);
    expect(
      (await pool.query("SELECT status FROM decision_sessions WHERE id=$1", [sessionId])).rows[0]
        .status,
    ).toBe("CLOSED");
    expect(
      (
        await pool.query("SELECT status FROM clarification_requests WHERE decision_session_id=$1", [
          sessionId,
        ])
      ).rows[0].status,
    ).toBe("CANCELLED");
    expect(
      (await new ActionPlanService().progress(source.db, userId, recommendationId)).state,
    ).toBe("CANCELLED");
    expect(
      (await pool.query("SELECT status FROM decision_sessions WHERE id=$1", [otherSession])).rows[0]
        .status,
    ).toBe("RECOMMENDED");
    expect(
      (await new ActionPlanService().progress(source.db, userId, otherRecommendation)).state,
    ).toBe("ACTIVE");
    expect(
      (
        await pool.query("SELECT hard_filter_status,rank FROM action_candidates WHERE id=$1", [
          candidateId,
        ])
      ).rows[0],
    ).toMatchObject({ hard_filter_status: "FILTERED", rank: null });
    expect(
      (await new PreferenceReader(source.db).read(userId, [{ id, kind: "MEDIA" }])).has(id),
    ).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM preference_signals WHERE value->>'lifeObjectId'=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await req("POST", `/v1/life/${id}/rating`, { rating: "LIKE" })).statusCode).toBe(404);
  });
});
