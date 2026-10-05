import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@life/db";
import { nowResponseSchema, type NowResponse } from "@life/contracts";
import { migrate } from "../../packages/db/dist/migrations.js";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl)
  throw new Error("TEST_DATABASE_URL must identify a disposable local PostgreSQL database.");
const schema = "now_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(testUrl);
const scopedUrl = new URL(testUrl);
scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(scopedUrl.toString());
const pool = source.pool;
const originalEnv = { ...process.env };
let app: Awaited<ReturnType<typeof createApiApp>>;
let otherToken: string;

type Seed = {
  kind?: string;
  importance: number;
  duration?: number;
  minCost?: number;
  maxCost?: number;
};
async function request(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: object,
  key = randomUUID(),
) {
  return app.inject({
    method,
    url: path,
    headers: { authorization: `Bearer ${token}`, "x-idempotency-key": key },
    ...(body ? { payload: body } : {}),
  });
}
async function owner(seeds: Seed[]) {
  const login = (await request("POST", "/v1/auth/wechat/login", "", { code: randomUUID() })).json()
    .data;
  const objectIds: string[] = [];
  for (const [index, item] of seeds.entries()) {
    const id = randomUUID();
    objectIds.push(id);
    await pool.query(
      "INSERT INTO life_objects(id,user_id,title,kind,importance_score,created_at) VALUES($1,$2,$3,$4,$5,date_trunc('second',now()))",
      [id, login.userId, `候选${index + 1}`, item.kind ?? "DESIRE", item.importance],
    );
    await pool.query(
      "INSERT INTO life_object_projection(life_object_id,user_id,display_kind,cost_min_minor,cost_max_minor,duration_min_seconds,search_text,projection_version) VALUES($1,$2,$3,$4,$5,$6,'test candidate','now-test')",
      [
        id,
        login.userId,
        item.kind ?? "DESIRE",
        item.minCost ?? 0,
        item.maxCost ?? 0,
        item.duration ?? (item.kind === "PLACE" ? 600 : null),
      ],
    );
    if (item.kind === "PLACE")
      await pool.query(
        "UPDATE life_object_projection SET latitude=23.01,longitude=113.01,coordinate_system='GCJ02' WHERE life_object_id=$1",
        [id],
      );
  }
  return { token: login.accessToken as string, userId: login.userId as string, objectIds };
}
async function begin(token: string, body: object = {}) {
  const supplied = body as { context?: object };
  const response = await request("POST", "/v1/now/sessions", token, {
    ...body,
    context: {
      location: { latitude: 23, longitude: 113, coordinateSystem: "GCJ02", source: "DEVICE" },
      ...supplied.context,
    },
  });
  expect(response.statusCode).toBe(201);
  return nowResponseSchema.parse(response.json().data);
}
async function answer(token: string, state: NowResponse, optionId: string, key = randomUUID()) {
  return request(
    "POST",
    `/v1/now/sessions/${state.sessionId}/answers`,
    token,
    { questionId: state.question!.id, optionId },
    key,
  );
}

beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
  Object.assign(process.env, {
    DATABASE_URL: scopedUrl.toString(),
    JWT_SECRET: "now-test-only-secret-at-least-32-bytes",
    WECHAT_MOCK_LOGIN: "true",
    NODE_ENV: "test",
  });
  app = await createApiApp({
    locationProvider: {
      configured: true,
      geocode: async () => ({ ok: false, reason: "AMBIGUOUS_ADDRESS" }),
      route: async () => ({
        ok: true,
        value: {
          durationSeconds: 0,
          distanceMeters: 0,
          mode: "walking",
          provider: "TENCENT",
          observedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        },
      }),
    },
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  otherToken = (await owner([])).token;
}, 30000);
afterAll(async () => {
  if (app) await app.close();
  await pool.end();
  await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe("persisted adaptive Now sessions", () => {
  it("recommends with sufficient context and never interrogates a lone place", async () => {
    const user = await owner([{ kind: "PLACE", importance: 0.9 }]);
    const state = await begin(user.token);
    expect(state.status).toBe("RECOMMENDED");
    expect(state.question).toBeNull();
    expect(
      (
        await pool.query("SELECT * FROM clarification_requests WHERE decision_session_id=$1", [
          state.sessionId,
        ])
      ).rowCount,
    ).toBe(0);
    const empty = await begin(otherToken);
    expect(empty.status).toBe("QUIET");
  });
  it("persists the question, isolates users, resolves in one answer and deduplicates retries", async () => {
    const user = await owner([
      { importance: 0.8, duration: 3600 },
      { importance: 0.6, duration: 900 },
    ]);
    const state = await begin(user.token);
    expect(state.status).toBe("NEEDS_ANSWER");
    expect(state.question?.key).toBe("AVAILABLE_TIME");
    expect(state.recommendation).toBeNull();
    const restored = await request("GET", `/v1/now/sessions/${state.sessionId}`, user.token);
    expect(nowResponseSchema.parse(restored.json().data)).toEqual(state);
    expect(
      (await request("GET", `/v1/now/sessions/${state.sessionId}`, otherToken)).statusCode,
    ).toBe(404);
    expect((await answer(otherToken, state, "TIME_30")).statusCode).toBe(404);
    expect((await answer(user.token, state, "unoffered")).statusCode).toBe(400);
    const key = randomUUID();
    const submitted = await answer(user.token, state, "TIME_30", key);
    expect(submitted.statusCode).toBe(201);
    const result = nowResponseSchema.parse(submitted.json().data);
    expect(result.status).toBe("RECOMMENDED");
    expect(result.question).toBeNull();
    expect(result.recommendation?.targetLifeObjectId).toBe(user.objectIds[1]);
    const replay = nowResponseSchema.parse(
      (await answer(user.token, state, "TIME_30", key)).json().data,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.recommendation?.id).toBe(result.recommendation?.id);
    expect((await answer(user.token, state, "TIME_30")).statusCode).toBe(201);
    expect((await answer(user.token, state, "TIME_60")).statusCode).toBe(409);
    expect((await answer(user.token, state, "TIME_60", key)).statusCode).toBe(409);
    expect(
      (
        await pool.query("SELECT * FROM recommendations WHERE decision_session_id=$1", [
          state.sessionId,
        ])
      ).rowCount,
    ).toBe(1);
    const questions = (
      await pool.query("SELECT * FROM clarification_requests WHERE decision_session_id=$1", [
        state.sessionId,
      ])
    ).rows;
    expect(questions).toHaveLength(1);
    expect(questions[0].scope_type).toBe("DECISION");
    expect(questions[0].status).toBe("ANSWERED");
    expect(
      (
        await pool.query("SELECT * FROM context_snapshots WHERE decision_session_id=$1", [
          state.sessionId,
        ])
      ).rowCount,
    ).toBe(2);
    expect(
      (await pool.query("SELECT * FROM preference_signals WHERE user_id=$1", [user.userId]))
        .rowCount,
    ).toBe(0);
  });
  it("serializes different request keys and stops at two questions even when a third could change ranking", async () => {
    const user = await owner([
      { kind: "PLACE", importance: 1, duration: 3600, minCost: 5000, maxCost: 5000 },
      { importance: 0.2, duration: 900 },
      { importance: 0.1, duration: 900, minCost: 5000, maxCost: 5000 },
    ]);
    const first = await begin(user.token);
    expect(first.question?.key).toBe("AVAILABLE_TIME");
    const replies = await Promise.all([
      answer(user.token, first, "TIME_60"),
      answer(user.token, first, "TIME_60"),
    ]);
    replies.forEach((reply) => expect(reply.statusCode).toBe(201));
    const second = nowResponseSchema.parse(replies[0]!.json().data);
    expect(second.question?.key).toBe("BUDGET");
    expect(second.question?.sequence).toBe(2);
    expect(replies[1]!.json().data.question.id).toBe(second.question?.id);
    const key = randomUUID();
    const finished = await Promise.all([
      answer(user.token, second, "BUDGET_100", key),
      answer(user.token, second, "BUDGET_100", key),
    ]);
    finished.forEach((reply) => expect(reply.statusCode).toBe(201));
    const final = nowResponseSchema.parse(finished[0]!.json().data);
    expect(final.status).toBe("RECOMMENDED");
    expect(final.question).toBeNull();
    expect(final.recommendation?.targetLifeObjectId).toBe(user.objectIds[0]);
    expect(
      (
        await pool.query("SELECT * FROM clarification_requests WHERE decision_session_id=$1", [
          first.sessionId,
        ])
      ).rowCount,
    ).toBe(2);
    expect(
      (
        await pool.query("SELECT * FROM recommendations WHERE decision_session_id=$1", [
          first.sessionId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query("SELECT context_summary FROM decision_sessions WHERE id=$1", [
          first.sessionId,
        ])
      ).rows[0].context_summary,
    ).toMatchObject({ availableMinutes: 60, budgetMinor: 10000 });
  });
  it("makes a skip terminal, rejects expired answers and preserves original exclusions", async () => {
    const user = await owner([
      { importance: 0.8, duration: 3600 },
      { importance: 0.6, duration: 900 },
    ]);
    const state = await begin(user.token);
    const skipped = nowResponseSchema.parse((await answer(user.token, state, "SKIP")).json().data);
    expect(skipped.status).toBe("RECOMMENDED");
    expect(skipped.question).toBeNull();
    const excluded = await begin(user.token, { excludeObjectIds: [user.objectIds[0]] });
    expect(excluded.status).toBe("RECOMMENDED");
    expect(excluded.candidates).toHaveLength(1);
    const expired = await begin(user.token);
    await pool.query(
      "UPDATE decision_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.sessionId],
    );
    expect((await answer(user.token, expired, "TIME_30")).statusCode).toBe(410);
    expect(
      (
        await pool.query("SELECT status FROM clarification_requests WHERE id=$1", [
          expired.question!.id,
        ])
      ).rows[0].status,
    ).toBe("PENDING");
    const active = await begin(user.token);
    await pool.query("UPDATE life_objects SET status='ARCHIVED' WHERE id=$1", [user.objectIds[0]]);
    const resolved = nowResponseSchema.parse(
      (await answer(user.token, active, "TIME_60")).json().data,
    );
    expect(resolved.recommendation?.targetLifeObjectId).toBe(user.objectIds[1]);
    expect(
      resolved.candidates.find((item) => item.lifeObjectId === user.objectIds[0])?.filterReason,
    ).toBe("SOURCE_UNAVAILABLE");
  });
});
