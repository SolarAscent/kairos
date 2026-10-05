import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@life/db";
import { migrate } from "../../packages/db/dist/migrations.js";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";
import { OutboxWorker } from "../../apps/worker/dist/worker.js";
import {
  captureParseResultSchema,
  nowResponseSchema,
  nowContextSchema,
  type StructuredLifeFacts,
} from "@life/contracts";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL required");
const schema = "planning_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(testUrl),
  url = new URL(testUrl);
url.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(url.toString()),
  pool = source.pool,
  originalEnv = { ...process.env };
let app: Awaited<ReturnType<typeof createApiApp>>;
async function req(
  method: "GET" | "POST" | "PATCH",
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
async function owner() {
  return (await req("POST", "/v1/auth/wechat/login", "", { code: randomUUID() })).json().data as {
    userId: string;
    accessToken: string;
  };
}
async function seed(userId: string, title: string, facts: StructuredLifeFacts, kind = "DESIRE") {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO life_objects(id,user_id,title,kind,importance_score) VALUES($1,$2,$3,$4,0.9)",
    [id, userId, title, kind],
  );
  await pool.query(
    "INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,schema_version,data,confidence,origin_type) VALUES($1,$2,$3,$4,'test',3,$5,1,'USER_STATED')",
    [
      randomUUID(),
      userId,
      id,
      kind,
      { intent: null, description: null, verification: "UNVERIFIED", facts },
    ],
  );
  await pool.query(
    "INSERT INTO life_object_projection(life_object_id,user_id,display_kind,search_text,projection_version) VALUES($1,$2,$3,$4,'test')",
    [id, userId, kind, title],
  );
  return id;
}
async function now(token: string, context: object = {}) {
  const result = await req("POST", "/v1/now/sessions", token, { context });
  expect(result.statusCode).toBe(201);
  return nowResponseSchema.parse(result.json().data);
}
beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    JWT_SECRET: "planning-test-only-key-more-than-32-characters",
    WECHAT_MOCK_LOGIN: "true",
    NODE_ENV: "test",
  });
  app = await createApiApp();
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

describe("capture → constraints → feasible plan → actual time", () => {
  it("uses one sentence's Guangdong/current 20-minute budget without pretending Xinjiang travel lasts 20 minutes", async () => {
    const user = await owner();
    const text = "我现在在广东，只有20分钟，想去新疆旅行，旅行预算3000元";
    const capture = await req("POST", "/v1/captures", user.accessToken, { type: "TEXT", text });
    expect(capture.statusCode).toBe(201);
    const worker = new OutboxWorker(pool, {
      providerName: "planning-fixture",
      modelName: "fixture",
      parseCapture: async () =>
        captureParseResultSchema.parse({
          objects: [
            {
              title: "新疆旅行计划",
              summary: "从广东出发的旅行愿望",
              kind: "DESIRE",
              importance: 0.9,
              confidence: 1,
              uncertainFields: [],
              facets: [
                {
                  type: "DESIRE",
                  key: "trip",
                  confidence: 1,
                  source: "EXTRACTED",
                  data: {
                    intent: "TRAVEL",
                    description: text,
                    verification: "UNVERIFIED",
                    facts: {
                      origin: "USER_STATED",
                      evidence: text,
                      activityKind: "TRAVEL",
                      horizon: "LONG_TERM",
                      duration: { minSeconds: 1200, role: "AVAILABLE", scope: "CURRENT" },
                      money: { minMinor: 300000, currency: "CNY", role: "BUDGET", scope: "OBJECT" },
                      place: { region: "新疆" },
                      originContext: { region: "广东" },
                    },
                  },
                },
              ],
            },
          ],
          relations: [],
          uncertainFields: [],
          suggestedEnrichments: [],
        }),
    });
    await worker.processNext();
    const ctx = nowContextSchema.parse(
      (await req("GET", "/v1/context", user.accessToken)).json().data,
    );
    expect(ctx.location?.region).toBe("广东");
    expect(ctx.availableMinutes).toBe(20);
    expect(ctx.budgetMinor).toBeUndefined();
    const state = await now(user.accessToken);
    expect(state.status).toBe("RECOMMENDED");
    expect(state.question).toBeNull();
    expect(state.recommendation?.plan?.mode).toBe("PREPARE");
    expect(state.recommendation?.plan?.totalSeconds).toBeLessThanOrEqual(1200);
    expect(state.recommendation?.headline).toMatch(/日期|预算|方案/);
    expect(state.candidates.find((item) => item.actionMode === "DO")?.filtered).toBe(true);
    const projection = (
      await pool.query(
        "SELECT duration_min_seconds,cost_min_minor,latitude FROM life_object_projection WHERE user_id=$1",
        [user.userId],
      )
    ).rows[0];
    expect(projection.duration_min_seconds).toBeNull();
    expect(projection.cost_min_minor).toBeNull();
    expect(projection.latitude).toBeNull();
  });
  it("deducts upcoming occupied time and remains quiet while an event is in progress", async () => {
    const user = await owner(),
      at = Date.now();
    const start = new Date(at + 10 * 60000).toISOString(),
      end = new Date(at + 70 * 60000).toISOString();
    await seed(
      user.userId,
      "线上会议",
      {
        origin: "USER_STATED",
        evidence: "会议开始结束",
        activityKind: "REMOTE",
        duration: { minSeconds: 3600, role: "REQUIRED" },
        time: { eventStart: start, eventEnd: end },
      },
      "EVENT",
    );
    const reading = await seed(
      user.userId,
      "读二十分钟书",
      {
        origin: "USER_STATED",
        evidence: "读二十分钟",
        activityKind: "HOME",
        duration: { minSeconds: 1200, role: "REQUIRED" },
        money: { minMinor: 0, currency: "CNY", role: "COST" },
      },
      "MEDIA",
    );
    const state = await now(user.accessToken, { availableMinutes: 60 });
    expect(
      state.candidates.find(
        (item) => item.lifeObjectId === reading && item.actionKey?.endsWith(":DO"),
      )?.filterReason,
    ).toMatch(/TIME/);
    expect(state.recommendation?.plan?.totalSeconds ?? 0).toBeLessThanOrEqual(600);
    await pool.query(
      "UPDATE life_object_facets SET data=jsonb_set(data,'{facts,time}', $2::jsonb) WHERE user_id=$1 AND facet_type='EVENT'",
      [
        user.userId,
        JSON.stringify({
          eventStart: new Date(at - 60000).toISOString(),
          eventEnd: new Date(at + 600000).toISOString(),
        }),
      ],
    );
    const busy = await now(user.accessToken);
    expect(busy.status).toBe("QUIET");
    expect(busy.quietReason).toMatch(/已有安排/);
  });
  it("serializes accepted plans, records actual elapsed time and completing preparation does not complete the trip", async () => {
    const user = await owner();
    const object = await seed(user.userId, "新疆旅行", {
      origin: "USER_STATED",
      evidence: "想去新疆旅行",
      activityKind: "TRAVEL",
      horizon: "LONG_TERM",
      place: { region: "新疆" },
    });
    const first = await now(user.accessToken),
      second = await now(user.accessToken);
    const path = (id: string) => `/v1/now/sessions/${id}/feedback`;
    const replies = await Promise.all([
      req("POST", path(first.sessionId), user.accessToken, {
        eventType: "ACCEPT",
        clientEventId: randomUUID(),
      }),
      req("POST", path(second.sessionId), user.accessToken, {
        eventType: "ACCEPT",
        clientEventId: randomUUID(),
      }),
    ]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
    const active = replies[0]!.statusCode === 201 ? first : second;
    await pool.query(
      "UPDATE feedback_events SET created_at=now()-interval '65 seconds' WHERE decision_session_id=$1 AND event_type='ACCEPT'",
      [active.sessionId],
    );
    const complete = await req("POST", path(active.sessionId), user.accessToken, {
      eventType: "COMPLETE",
      clientEventId: randomUUID(),
    });
    expect(complete.statusCode).toBe(201);
    expect(complete.json().data.progress.state).toBe("COMPLETED");
    expect(complete.json().data.progress.elapsedSeconds).toBeGreaterThanOrEqual(65);
    const restored = nowResponseSchema.parse(
      (await req("GET", `/v1/now/sessions/${active.sessionId}`, user.accessToken)).json().data,
    );
    expect(restored.recommendation?.progress?.state).toBe("COMPLETED");
    expect(
      (await pool.query("SELECT status FROM life_objects WHERE id=$1", [object])).rows[0].status,
    ).toBe("ACTIVE");
    expect((await now(user.accessToken)).status).toBe("RECOMMENDED");
  });
  it("lets explicit corrections rebuild structured projections, without changing another user's records", async () => {
    const user = await owner(),
      other = await owner();
    const id = await seed(
      user.userId,
      "读书",
      {
        origin: "USER_STATED",
        evidence: "读20分钟",
        duration: { minSeconds: 1200, role: "REQUIRED" },
        activityKind: "HOME",
      },
      "MEDIA",
    );
    const body = {
      facts: [
        {
          type: "MEDIA",
          key: "test",
          facts: {
            origin: "INFERRED",
            evidence: "我更正为10分钟",
            duration: { minSeconds: 600, role: "REQUIRED" },
            activityKind: "HOME",
          },
        },
      ],
    };
    expect((await req("PATCH", `/v1/life/${id}`, other.accessToken, body)).statusCode).toBe(404);
    const key = randomUUID();
    const patched = await req("PATCH", `/v1/life/${id}`, user.accessToken, body, key);
    expect(patched.statusCode).toBe(200);
    expect(
      (await req("PATCH", `/v1/life/${id}`, user.accessToken, body, key)).json().data.replayed,
    ).toBe(true);
    const projection = (
      await pool.query(
        "SELECT duration_min_seconds FROM life_object_projection WHERE life_object_id=$1",
        [id],
      )
    ).rows[0];
    expect(projection.duration_min_seconds).toBe(600);
    const state = await now(user.accessToken, { availableMinutes: 10 });
    expect(state.recommendation?.plan?.totalSeconds).toBe(600);
    expect(state.recommendation?.plan?.mode).toBe("DO");
  });
  it("preserves a session's absolute 10-minute availability when acceptance happens with only one minute remaining", async () => {
    const user = await owner();
    await seed(user.userId, "新疆旅行", {
      origin: "USER_STATED",
      evidence: "想去新疆旅行",
      activityKind: "TRAVEL",
      horizon: "LONG_TERM",
      place: { region: "新疆" },
    });
    const state = await now(user.accessToken, { availableMinutes: 10 });
    expect(state.recommendation?.plan?.totalSeconds).toBe(300);
    // Age the server snapshot's absolute lease by nine minutes; the stored
    // availableMinutes remains ten and must never restart the original allowance.
    const remainingUntil = new Date(Date.now() + 60000).toISOString();
    await pool.query(
      "UPDATE context_snapshots SET context=jsonb_set(context,'{calendar,availableUntil}',to_jsonb($2::text)),created_at=now()-interval '9 minutes' WHERE decision_session_id=$1",
      [state.sessionId, remainingUntil],
    );
    await pool.query("UPDATE recommendations SET expires_at=$2 WHERE decision_session_id=$1", [
      state.sessionId,
      remainingUntil,
    ]);
    const accepted = await req(
      "POST",
      `/v1/now/sessions/${state.sessionId}/feedback`,
      user.accessToken,
      { eventType: "ACCEPT", clientEventId: randomUUID() },
    );
    expect(accepted.statusCode).toBe(409);
    expect(JSON.stringify(accepted.json())).toContain("ACTION_TIME_CONFLICT");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM feedback_events WHERE decision_session_id=$1",
          [state.sessionId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("checks that a delayed direct action still ends inside its source window", async () => {
    const user = await owner();
    const windowEnd = new Date(Date.now() + 600000).toISOString();
    await seed(user.userId, "整理桌面", {
      origin: "USER_STATED",
      evidence: "在这段空闲中整理五分钟",
      activityKind: "HOME",
      duration: { minSeconds: 300, role: "REQUIRED" },
      money: { minMinor: 0, currency: "CNY", role: "COST" },
      time: { windowEnd },
    });
    const state = await now(user.accessToken, { availableMinutes: 30 });
    expect(state.recommendation?.plan).toMatchObject({
      mode: "DO",
      totalSeconds: 300,
      validUntil: windowEnd,
    });
    // The persisted source boundary now has two minutes remaining, while the
    // recommendation and available-time lease are still valid for starting.
    const delayedBoundary = new Date(Date.now() + 120000).toISOString();
    await pool.query(
      "UPDATE recommendations SET execution_payload=jsonb_set(execution_payload,'{plan,validUntil}',to_jsonb($2::text)) WHERE decision_session_id=$1",
      [state.sessionId, delayedBoundary],
    );
    const accepted = await req(
      "POST",
      `/v1/now/sessions/${state.sessionId}/feedback`,
      user.accessToken,
      { eventType: "ACCEPT", clientEventId: randomUUID() },
    );
    expect(accepted.statusCode).toBe(409);
    expect(JSON.stringify(accepted.json())).toContain("ACTION_TIME_CONFLICT");
  });
  it("rejects an old recommendation after the source object has been corrected", async () => {
    const user = await owner();
    const id = await seed(user.userId, "整理桌面", {
      origin: "USER_STATED",
      evidence: "整理五分钟",
      activityKind: "HOME",
      duration: { minSeconds: 300, role: "REQUIRED" },
      money: { minMinor: 0, currency: "CNY", role: "COST" },
    });
    const state = await now(user.accessToken, { availableMinutes: 30 });
    expect(state.recommendation?.targetLifeObjectId).toBe(id);
    const correction = await req("PATCH", `/v1/life/${id}`, user.accessToken, {
      title: "改成整理书架",
    });
    expect(correction.statusCode).toBe(200);
    expect(correction.json().data.objectVersion).toBe(2);
    const accepted = await req(
      "POST",
      `/v1/now/sessions/${state.sessionId}/feedback`,
      user.accessToken,
      { eventType: "ACCEPT", clientEventId: randomUUID() },
    );
    expect(accepted.statusCode).toBe(409);
    expect(JSON.stringify(accepted.json())).toContain("ACTION_SOURCE_CHANGED");
  });
  it("lets an estimated five-minute preparation start immediately within a five-minute allowance", async () => {
    const user = await owner();
    await seed(user.userId, "新疆旅行", {
      origin: "USER_STATED",
      evidence: "想去新疆旅行",
      activityKind: "TRAVEL",
      horizon: "LONG_TERM",
      place: { region: "新疆" },
    });
    const state = await now(user.accessToken, { availableMinutes: 5 });
    expect(state.recommendation?.plan?.mode).toBe("PREPARE");
    expect(state.recommendation?.plan?.totalSeconds).toBeGreaterThan(0);
    expect(state.recommendation?.plan?.totalSeconds).toBeLessThanOrEqual(285);
    const accepted = await req(
      "POST",
      `/v1/now/sessions/${state.sessionId}/feedback`,
      user.accessToken,
      { eventType: "ACCEPT", clientEventId: randomUUID() },
    );
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().data.progress.state).toBe("ACTIVE");
  });
  it("finishes an old accepted action without resolving a source goal corrected to a newer version", async () => {
    const user = await owner();
    const id = await seed(user.userId, "整理桌面", {
      origin: "USER_STATED",
      evidence: "整理五分钟",
      activityKind: "HOME",
      duration: { minSeconds: 300, role: "REQUIRED" },
      money: { minMinor: 0, currency: "CNY", role: "COST" },
    });
    const state = await now(user.accessToken, { availableMinutes: 30 });
    const path = `/v1/now/sessions/${state.sessionId}/feedback`;
    expect(
      (
        await req("POST", path, user.accessToken, {
          eventType: "ACCEPT",
          clientEventId: randomUUID(),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await req("PATCH", `/v1/life/${id}`, user.accessToken, { title: "改成整理书架" }))
        .statusCode,
    ).toBe(200);
    const completed = await req("POST", path, user.accessToken, {
      eventType: "COMPLETE",
      clientEventId: randomUUID(),
    });
    expect(completed.statusCode).toBe(201);
    expect(completed.json().data.progress.state).toBe("COMPLETED");
    const worker = new OutboxWorker(pool, {
      providerName: "planning-fixture",
      modelName: "fixture",
      parseCapture: async () => {
        throw new Error("UNEXPECTED_MODEL_PARSE");
      },
    });
    for (let i = 0; i < 50; i++) if (!(await worker.processNext())) break;
    const goal = (
      await pool.query("SELECT status,object_version,last_acted_at FROM life_objects WHERE id=$1", [
        id,
      ])
    ).rows[0];
    expect(goal).toMatchObject({ status: "ACTIVE", object_version: 2 });
    expect(goal.last_acted_at).not.toBeNull();
    const receipt = (
      await pool.query(
        "SELECT status FROM outbox_events WHERE aggregate_id=$1 AND event_type='FEEDBACK_RECORDED'",
        [completed.json().data.feedbackId],
      )
    ).rows[0];
    expect(receipt.status).toBe("DONE");
  });
  it("queues one background reconstruction for a legacy projection version without blocking or duplicating Now", async () => {
    const user = await owner();
    const id = await seed(user.userId, "去新疆旅行", {
      origin: "USER_STATED",
      evidence: "想去新疆旅行",
      activityKind: "TRAVEL",
      horizon: "LONG_TERM",
    });
    await pool.query(
      "UPDATE life_object_facets SET schema_version=2,data=data-'facts' WHERE life_object_id=$1",
      [id],
    );
    await pool.query(
      "UPDATE life_object_projection SET projection_version='projection-v0.2' WHERE life_object_id=$1",
      [id],
    );
    const replies = await Promise.all([now(user.accessToken), now(user.accessToken)]);
    for (const reply of replies) {
      expect(reply.status).toBe("RECOMMENDED");
      expect(reply.recommendation?.plan?.mode).toBe("PREPARE");
    }
    await now(user.accessToken);
    const jobs = (
      await pool.query(
        "SELECT status,attempts,payload FROM outbox_events WHERE aggregate_id=$1 AND event_type='LIFE_FACTS_REBUILD'",
        [id],
      )
    ).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: "PENDING",
      attempts: 0,
      payload: {
        lifeObjectId: id,
        userId: user.userId,
        objectVersion: 1,
        factsVersion: "life-facts-v0.4",
      },
    });
    expect(
      (
        await pool.query(
          "SELECT projection_version FROM life_object_projection WHERE life_object_id=$1",
          [id],
        )
      ).rows[0].projection_version,
    ).toBe("projection-v0.2");
  });
});

it("persists preparation deadline and rejects a delayed start that would finish after it", async () => {
  const user = await owner();
  await seed(user.userId, "新疆旅行", {
    origin: "USER_STATED",
    evidence: "新疆旅行，今天准备",
    activityKind: "TRAVEL",
    horizon: "LONG_TERM",
    time: { deadline: new Date(Date.now() + 600000).toISOString() },
    place: { province: "新疆" },
  });
  const result = await now(user.accessToken, { availableMinutes: 20 });
  expect(result.recommendation?.plan?.mode).toBe("PREPARE");
  expect(result.recommendation?.plan?.validUntil).toBeTruthy();
  const bound = new Date(Date.now() + 60000).toISOString();
  await pool.query(
    "UPDATE recommendations SET execution_payload=jsonb_set(execution_payload::jsonb,'{plan,validUntil}',to_jsonb($2::text))::json WHERE decision_session_id=$1",
    [result.sessionId, bound],
  );
  const feedback = await req(
    "POST",
    `/v1/now/sessions/${result.sessionId}/feedback`,
    user.accessToken,
    { eventType: "ACCEPT", clientEventId: randomUUID() },
  );
  expect(feedback.statusCode).toBe(409);
  expect(feedback.json().error.code).toBe("ACTION_TIME_CONFLICT");
});

it("keeps old facts repair behind new input and reserves a foreground worker", async () => {
  const user = await owner();
  const id = await seed(user.userId, "旧新疆旅行", {
    origin: "USER_STATED",
    evidence: "去新疆旅行",
    activityKind: "TRAVEL",
    horizon: "LONG_TERM",
  });
  await pool.query(
    "UPDATE life_object_projection SET projection_version='projection-v0.2' WHERE life_object_id=$1",
    [id],
  );
  await now(user.accessToken, { availableMinutes: 20 });
  const accepted = await req("POST", "/v1/captures", user.accessToken, {
    type: "TEXT",
    text: "想读书",
  });
  const captureId = accepted.json().data.captureId;
  const gateway = {
    providerName: "TEST",
    modelName: "test",
    async parseCapture() {
      return captureParseResultSchema.parse({
        objects: [
          {
            title: "阅读手边的书",
            summary: null,
            kind: "MEDIA",
            importance: 0.6,
            confidence: 1,
            uncertainFields: [],
            facets: [],
          },
        ],
        relations: [],
        uncertainFields: [],
        suggestedEnrichments: [],
      });
    },
  };
  const foreground = new OutboxWorker(pool, gateway);
  expect(await foreground.processNext(false)).toBe(true);
  expect((await req("GET", `/v1/captures/${captureId}`, user.accessToken)).json().data.status).toBe(
    "READY",
  );
  expect(
    (
      await pool.query(
        "SELECT status FROM outbox_events WHERE aggregate_id=$1 AND event_type='LIFE_FACTS_REBUILD'",
        [id],
      )
    ).rows[0].status,
  ).toBe("PENDING");
  expect(await foreground.processNext(false)).toBe(false);
});

it("shows a named destination separately from precise coordinates without leaking another owner's place", async () => {
  const user = await owner(),
    other = await owner();
  await seed(user.userId, "新疆旅行", {
    origin: "USER_STATED",
    evidence: "去新疆旅行",
    activityKind: "TRAVEL",
    place: { province: "新疆" },
    originContext: { province: "广东" },
  });
  await seed(other.userId, "私有地点", {
    origin: "USER_STATED",
    evidence: "私有地点",
    place: { name: "其他用户的地址" },
  });
  const response = await req("POST", "/v1/life/search", user.accessToken, {});
  expect(response.statusCode).toBe(200);
  const items = response.json().data.items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ placeLabel: "新疆", hasLocation: false, distanceMeters: null });
  expect(JSON.stringify(items)).not.toContain("其他用户的地址");
});
