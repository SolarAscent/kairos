import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@life/db";
import { MockModelProvider } from "@life/agent-core";
import { nowResponseSchema } from "@life/contracts";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";
import { OutboxWorker } from "../../apps/worker/dist/worker.js";
import { migrate } from "../../packages/db/dist/migrations.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl)
  throw new Error("TEST_DATABASE_URL must identify a disposable local PostgreSQL database");
const schema = "pref_now_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(testUrl),
  url = new URL(testUrl);
url.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(url.toString()),
  pool = source.pool,
  originalEnv = { ...process.env };
let app: Awaited<ReturnType<typeof createApiApp>>;
const worker = new OutboxWorker(pool, new MockModelProvider(), {
  configured: false,
  geocode: async () => ({ ok: false, reason: "NOT_CONFIGURED" }),
  route: async () => ({ ok: false, reason: "NOT_CONFIGURED" }),
});
type User = { userId: string; accessToken: string };
async function req(
  method: "GET" | "POST" | "DELETE",
  path: string,
  user: User | string,
  body?: object,
  key = randomUUID(),
) {
  return app.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${typeof user === "string" ? user : user.accessToken}`,
      "x-idempotency-key": key,
    },
    ...(body ? { payload: body } : {}),
  });
}
async function owner(): Promise<User> {
  return (await req("POST", "/v1/auth/wechat/login", "", { code: randomUUID() })).json().data;
}
async function seed(
  user: User,
  title: string,
  agoSeconds: number,
  duration = 300,
  importance = 0.7,
) {
  const id = randomUUID(),
    date = new Date(Date.now() - agoSeconds * 1000);
  await pool.query(
    "INSERT INTO life_objects(id,user_id,title,kind,importance_score,created_at) VALUES($1,$2,$3,'MEDIA',$4,$5)",
    [id, user.userId, title, importance, date],
  );
  await pool.query(
    "INSERT INTO life_object_projection(life_object_id,user_id,display_kind,search_text,projection_version,duration_min_seconds,cost_min_minor,currency) VALUES($1,$2,'MEDIA',$3,'preference-test',$4,0,'CNY')",
    [id, user.userId, title, duration],
  );
  await pool.query(
    "INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,data,confidence,origin_type,created_at) VALUES($1,$2,$3,'MEDIA','content',$4,1,'USER_STATED',$5)",
    [
      randomUUID(),
      user.userId,
      id,
      {
        intent: "EXPERIENCE",
        description: title,
        verification: "UNVERIFIED",
        facts: {
          origin: "USER_STATED",
          evidence: title,
          duration: { role: "REQUIRED", minSeconds: duration },
          money: { role: "COST", currency: "CNY", minMinor: 0 },
          activityKind: "REMOTE",
        },
      },
      date,
    ],
  );
  return id;
}
async function pair(user: User) {
  return {
    // A tiny known base-score gap establishes a deterministic baseline without relying
    // on UUID ordering; both explicit and meaningful implicit preference can change it.
    older: await seed(user, "读一段科幻小说", 120, 300, 0.69),
    newer: await seed(user, "看一段纪录片", 60),
  };
}
const context = { availableMinutes: 30, budgetMinor: 0, willingToGoOut: false, mood: "NEUTRAL" };
async function begin(
  user: User,
  options: { key?: string; excludeObjectIds?: string[]; availableMinutes?: number } = {},
) {
  const result = await req(
    "POST",
    "/v1/now/sessions",
    user,
    {
      context: {
        ...context,
        ...(options.availableMinutes != null ? { availableMinutes: options.availableMinutes } : {}),
      },
      excludeObjectIds: options.excludeObjectIds ?? [],
    },
    options.key,
  );
  expect(result.statusCode).toBe(201);
  return nowResponseSchema.parse(result.json().data);
}
async function vote(user: User, id: string, rating: "LIKE" | "DISLIKE" | "NONE", key?: string) {
  const result = await req("POST", `/v1/life/${id}/rating`, user, { rating }, key);
  expect(result.statusCode).toBe(201);
  return result.json().data;
}
async function browse(user: User) {
  const result = await req("POST", "/v1/life/search", user, { kind: "MEDIA", limit: 50 });
  expect(result.statusCode).toBe(200);
  return result.json().data.items as Array<{
    id: string;
    myRating: string;
    preferenceScore: number;
  }>;
}
async function preference(user: User, id: string) {
  return (await browse(user)).find((item) => item.id === id)!;
}
async function feedback(user: User, sessionId: string, eventType: string, reasonCode?: string) {
  const response = await req("POST", `/v1/now/sessions/${sessionId}/feedback`, user, {
    eventType,
    clientEventId: randomUUID(),
    ...(reasonCode ? { reasonCode } : {}),
  });
  expect(response.statusCode).toBe(201);
  return response.json().data;
}
async function drain() {
  for (let count = 0; count < 50; count++) if (!(await worker.processNext())) return;
  throw new Error("TEST_OUTBOX_DID_NOT_DRAIN");
}
beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    JWT_SECRET: "preference-now-test-key-longer-than-32-bytes",
    WECHAT_MOCK_LOGIN: "true",
    NODE_ENV: "test",
  });
  app = await createApiApp({
    locationProvider: {
      configured: false,
      geocode: async () => ({ ok: false, reason: "NOT_CONFIGURED" }),
      route: async () => ({ ok: false, reason: "NOT_CONFIGURED" }),
    },
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 30000);
afterAll(async () => {
  if (app) await app.close();
  await pool.end();
  await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe("preference changes reach Now without rewriting facts or hard constraints", () => {
  it("learns explicit LIKE/DISLIKE, withdraws NONE, and preserves an existing decision snapshot", async () => {
    const user = await owner(),
      objects = await pair(user),
      baseline = await begin(user);
    expect(baseline.recommendation?.targetLifeObjectId).toBe(objects.newer);
    const key = randomUUID();
    await vote(user, objects.older, "LIKE", key);
    expect((await vote(user, objects.older, "LIKE", key)).replayed).toBe(true);
    expect((await begin(user)).recommendation?.targetLifeObjectId).toBe(objects.older);
    const original = nowResponseSchema.parse(
      (await req("GET", `/v1/now/sessions/${baseline.sessionId}`, user)).json().data,
    );
    expect(original.recommendation?.targetLifeObjectId).toBe(objects.newer);
    await vote(user, objects.older, "NONE");
    expect((await preference(user, objects.older)).myRating).toBe("NONE");
    expect((await begin(user)).recommendation?.targetLifeObjectId).toBe(objects.newer);
    await vote(user, objects.newer, "DISLIKE");
    expect((await begin(user)).recommendation?.targetLifeObjectId).toBe(objects.older);
    await vote(user, objects.newer, "NONE");
    expect((await preference(user, objects.newer)).preferenceScore).toBeCloseTo(0, 6);
    expect((await preference(user, objects.older)).preferenceScore).toBeCloseTo(0, 6);
    expect((await begin(user)).recommendation?.targetLifeObjectId).toBe(objects.newer);
  });
  it("ignores temporary SKIP and contextual REJECT as category dislikes, including worker replay", async () => {
    const user = await owner(),
      objects = await pair(user);
    for (const [eventType, reasonCode] of [
      ["SKIP", undefined],
      ["REJECT", "NO_TIME"],
    ] as const) {
      const state = await begin(user, { excludeObjectIds: [objects.older] });
      expect(state.recommendation?.targetLifeObjectId).toBe(objects.newer);
      await feedback(user, state.sessionId, eventType, reasonCode);
    }
    await drain();
    for (const id of Object.values(objects))
      expect((await preference(user, id)).preferenceScore).toBeCloseTo(0, 6);
    expect((await begin(user)).recommendation?.targetLifeObjectId).toBe(objects.newer);
    expect(
      (
        await pool.query("SELECT id FROM preference_signals WHERE user_id=$1 AND polarity=-1", [
          user.userId,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("uses the strongest behavior once per action lifecycle and lets completion affect a new decision", async () => {
    const user = await owner(),
      objects = await pair(user);
    const state = await begin(user, { excludeObjectIds: [objects.newer] });
    await feedback(user, state.sessionId, "ACCEPT");
    const accepted = (await preference(user, objects.older)).preferenceScore;
    expect(accepted).toBeGreaterThan(0);
    await feedback(user, state.sessionId, "EXECUTE");
    const executed = (await preference(user, objects.older)).preferenceScore;
    await feedback(user, state.sessionId, "EXECUTE");
    const repeated = (await preference(user, objects.older)).preferenceScore;
    expect(repeated).toBeCloseTo(executed, 3);
    expect(executed).toBeLessThanOrEqual(accepted + 0.001);
    await feedback(user, state.sessionId, "COMPLETE");
    const completed = (await preference(user, objects.older)).preferenceScore;
    expect(completed).toBeGreaterThan(accepted);
    await drain();
    expect((await preference(user, objects.older)).preferenceScore).toBeCloseTo(completed, 3);
    expect((await begin(user)).recommendation?.targetLifeObjectId).toBe(objects.older);
  });
  it("learns an explicit NOT_INTERESTED rejection without turning other contextual reasons into it", async () => {
    const user = await owner(),
      objects = await pair(user),
      state = await begin(user);
    expect(state.recommendation?.targetLifeObjectId).toBe(objects.newer);
    await feedback(user, state.sessionId, "REJECT", "NOT_INTERESTED");
    expect((await preference(user, objects.newer)).preferenceScore).toBeLessThan(0);
    await drain();
    expect((await begin(user)).recommendation?.targetLifeObjectId).toBe(objects.older);
  });
  it("deletes a rated wish without a negative category vote and closes old cards and replayed sessions", async () => {
    const user = await owner(),
      objects = await pair(user);
    await vote(user, objects.older, "LIKE");
    const key = randomUUID(),
      before = await begin(user, { key });
    expect(before.recommendation?.targetLifeObjectId).toBe(objects.older);
    const deleteKey = randomUUID();
    expect(
      (await req("DELETE", `/v1/life/${objects.older}`, user, undefined, deleteKey)).statusCode,
    ).toBe(200);
    expect(
      (await req("DELETE", `/v1/life/${objects.older}`, user, undefined, deleteKey)).json().data
        .replayed,
    ).toBe(true);
    const closed = nowResponseSchema.parse(
      (await req("GET", `/v1/now/sessions/${before.sessionId}`, user)).json().data,
    );
    expect(closed.status).toBe("QUIET");
    expect(closed.recommendation).toBeNull();
    const replay = await begin(user, { key });
    expect(replay.sessionId).toBe(before.sessionId);
    expect(replay.recommendation).toBeNull();
    await drain();
    expect((await browse(user)).some((item) => item.id === objects.older)).toBe(false);
    expect((await preference(user, objects.newer)).preferenceScore).toBeCloseTo(0, 6);
    expect(
      (
        await pool.query("SELECT id FROM preference_signals WHERE user_id=$1 AND polarity=-1", [
          user.userId,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await begin(user)).recommendation?.targetLifeObjectId).toBe(objects.newer);
  });
  it("cannot prefer a liked action through a known time limit", async () => {
    const user = await owner(),
      long = await seed(user, "读二十分钟小说", 60, 1200),
      short = await seed(user, "读五分钟随笔", 120, 300);
    await vote(user, long, "LIKE");
    const state = await begin(user, { availableMinutes: 10 });
    expect(state.recommendation?.targetLifeObjectId).toBe(short);
    expect(
      state.candidates.find((item) => item.lifeObjectId === long && item.actionMode === "DO"),
    ).toMatchObject({ filtered: true, filterReason: "TIME_LIMIT", rank: null });
  });
  it("keeps ratings, learned behavior, deletes and decisions isolated between owners", async () => {
    const a = await owner(),
      b = await owner(),
      aObjects = await pair(a),
      bObjects = await pair(b);
    await vote(a, aObjects.older, "LIKE");
    expect(
      (await req("POST", `/v1/life/${aObjects.older}/rating`, b, { rating: "DISLIKE" })).statusCode,
    ).toBe(404);
    expect((await req("DELETE", `/v1/life/${aObjects.older}`, b)).statusCode).toBe(404);
    expect((await begin(a)).recommendation?.targetLifeObjectId).toBe(aObjects.older);
    expect((await begin(b)).recommendation?.targetLifeObjectId).toBe(bObjects.newer);
    for (const item of await browse(b)) {
      expect(item.myRating).toBe("NONE");
      expect(item.preferenceScore).toBeCloseTo(0, 6);
    }
    const aState = await begin(a);
    expect((await req("GET", `/v1/now/sessions/${aState.sessionId}`, b)).statusCode).toBe(404);
  });
  it("keeps deck pagination stable when a rated category member is deleted between pages", async () => {
    const user = await owner(),
      objects = await pair(user),
      liked = await seed(user, "读另一段已经喜欢的内容", 180);
    await vote(user, liked, "LIKE");
    const first = await req("POST", "/v1/life/deck", user, { kind: "MEDIA", limit: 2 });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json().data;
    expect(firstPage.items.map((item: { id: string }) => item.id)).toEqual([liked, objects.newer]);
    expect(firstPage.nextCursor).toBeTruthy();
    expect((await req("DELETE", `/v1/life/${liked}`, user)).statusCode).toBe(200);
    const second = await req("POST", "/v1/life/deck", user, {
      kind: "MEDIA",
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    expect(second.statusCode).toBe(200);
    const secondPage = second.json().data;
    expect(secondPage.asOf).toBe(firstPage.asOf);
    expect(secondPage.items.map((item: { id: string }) => item.id)).toEqual([objects.older]);
    expect(secondPage.nextCursor).toBeNull();
    const fresh = (await req("POST", "/v1/life/deck", user, { kind: "MEDIA", limit: 5 })).json()
      .data;
    expect(fresh.items.map((item: { id: string }) => item.id)).toEqual([
      objects.newer,
      objects.older,
    ]);
    expect(
      fresh.items.every(
        (item: { preferenceScore: number }) => Math.abs(item.preferenceScore) < 0.000001,
      ),
    ).toBe(true);
  });
  it("recalls an older current LIKE beyond the base 200 while respecting exclusions and withdrawal", async () => {
    const user = await owner();
    let oldest = "";
    for (let index = 0; index < 201; index++)
      oldest = await seed(user, `阅读收藏第${index + 1}段`, 60 + index);
    const baseline = await begin(user);
    expect(baseline.candidates).toHaveLength(200);
    expect(baseline.candidates.some((item) => item.lifeObjectId === oldest)).toBe(false);
    await vote(user, oldest, "LIKE");
    const liked = await begin(user);
    expect(liked.candidates.some((item) => item.lifeObjectId === oldest)).toBe(true);
    expect(liked.candidates.length).toBeLessThanOrEqual(250);
    expect(liked.recommendation?.targetLifeObjectId).toBe(oldest);
    const excluded = await begin(user, { excludeObjectIds: [oldest] });
    expect(excluded.candidates.some((item) => item.lifeObjectId === oldest)).toBe(false);
    expect(excluded.recommendation?.targetLifeObjectId).not.toBe(oldest);
    await vote(user, oldest, "NONE");
    const withdrawn = await begin(user);
    expect(withdrawn.candidates.some((item) => item.lifeObjectId === oldest)).toBe(false);
  });
});
