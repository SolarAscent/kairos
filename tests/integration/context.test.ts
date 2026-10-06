import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@life/db";
import { migrate } from "../../packages/db/dist/migrations.js";
import { BuildDecisionContextService } from "../../apps/api/dist/context/build-decision-context.service.js";
import type { GeoPoint, LocationProvider } from "@life/integrations";
import { nowContextSchema } from "@life/contracts";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl)
  throw new Error("TEST_DATABASE_URL must identify a disposable local PostgreSQL database.");
const schema = "context_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(testUrl);
const url = new URL(testUrl);
url.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(url.toString());
const now = new Date("2026-10-05T10:00:00Z");
const originalEnv = { ...process.env };
let app: Awaited<ReturnType<typeof createApiApp>>;
const unconfigured: LocationProvider = {
  configured: false,
  geocode: async () => ({ ok: false, reason: "NOT_CONFIGURED" }),
  route: async () => ({ ok: false, reason: "NOT_CONFIGURED" }),
};
const service = new BuildDecisionContextService(source.db, unconfigured);
async function user(timezone = "Asia/Shanghai") {
  const id = randomUUID();
  await source.pool.query("INSERT INTO users(id,timezone) VALUES($1,$2)", [id, timezone]);
  return id;
}
async function fact(
  userId: string,
  facts: Record<string, unknown>,
  agoSeconds = 60,
  kind = "DESIRE",
) {
  const captureId = randomUUID(),
    id = randomUUID(),
    date = new Date(now.getTime() - agoSeconds * 1000);
  await source.pool.query(
    "INSERT INTO captures(id,user_id,capture_type,status,source_channel,text_content,created_at) VALUES($1,$2,'TEXT','READY','API','source',$3)",
    [captureId, userId, date],
  );
  await source.pool.query(
    "INSERT INTO life_objects(id,user_id,title,kind) VALUES($1,$2,'source',$3)",
    [id, userId, kind],
  );
  await source.pool.query(
    "INSERT INTO life_object_projection(life_object_id,user_id,search_text,projection_version) VALUES($1,$2,'source','context-test')",
    [id, userId],
  );
  await source.pool.query(
    "INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,data,confidence,origin_type,origin_id,created_at) VALUES($1,$2,$3,$4,'facts',$5,1,'EXTRACTED',$6,$7)",
    [randomUUID(), userId, id, kind, { facts }, captureId, date],
  );
  return id;
}
beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(source.pool);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    JWT_SECRET: "context-test-only-secret-at-least-32-bytes",
    WECHAT_MOCK_LOGIN: "true",
    NODE_ENV: "test",
  });
  app = await createApiApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 30000);
afterAll(async () => {
  if (app) await app.close();
  await source.pool.end();
  await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe("server decision context from owned structured facts", () => {
  it("serves authenticated GET context with server fields and user isolation", async () => {
    const login = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/wechat/login",
          payload: { code: randomUUID() },
        })
      ).json().data;
    const a = await login(),
      b = await login();
    await fact(
      a.userId,
      { origin: "USER_STATED", originContext: { region: "广东" } },
      (now.getTime() - Date.now()) / 1000 + 60,
    );
    const get = (token?: string) =>
      app.inject({
        method: "GET",
        url: "/v1/context",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    const response = await get(a.accessToken);
    expect(response.statusCode).toBe(200);
    const context = nowContextSchema.parse(response.json().data);
    expect(context.location?.region).toBe("广东");
    expect(context.serverTime).toBeDefined();
    expect(context.localClock).toMatch(/^\d\d:\d\d$/);
    expect((await get(b.accessToken)).json().data.location).toBeUndefined();
    expect((await get()).statusCode).toBe(401);
  });
  it("uses server clock and user timezone, not a caller clock", async () => {
    const id = await user("Asia/Tokyo");
    const built = await service.build(id, { localTime: "1990-01-01T00:00:00Z" }, undefined, now);
    expect(built.context).toMatchObject({
      serverTime: now.toISOString(),
      localTime: now.toISOString(),
      localDate: "2026-10-05",
      localClock: "19:00",
      timezone: "Asia/Tokyo",
    });
  });
  it("keeps Guangdong as coarse origin, never turns a Xinjiang destination into the origin", async () => {
    const id = await user();
    await fact(id, {
      origin: "USER_STATED",
      evidence: "我在广东，只有20分钟，想去新疆旅行",
      originContext: { region: "广东" },
      place: { region: "新疆", latitude: 43.8, longitude: 87.6, coordinateSystem: "GCJ02" },
      activityKind: "TRAVEL",
      duration: { role: "AVAILABLE", scope: "CURRENT", minSeconds: 1200 },
    });
    await fact(await user(), { origin: "USER_STATED", originContext: { region: "北京" } }, 0);
    const built = await service.build(id, {}, undefined, now);
    expect(built.context.location).toMatchObject({ region: "广东", source: "SAVED_CURRENT" });
    expect(built.context.location?.latitude).toBeUndefined();
    expect(built.context.availableMinutes).toBe(20);
    expect(built.snapshot.containsPreciseLocation).toBe(false);
    expect(
      (
        await service.enrichCandidates(built.context, [
          { id: "trip", title: "新疆", kind: "PLACE" },
        ])
      ).trip?.reason,
    ).toBe("NOT_CONFIGURED");
  });
  it("expires current location after 24h and AVAILABLE/BUDGET after 2h, but retains an explicitly saved HOME as coarse data", async () => {
    const id = await user();
    await fact(
      id,
      {
        origin: "USER_STATED",
        originContext: { region: "广东" },
        duration: { role: "AVAILABLE", scope: "CURRENT", minSeconds: 1200 },
        money: { role: "BUDGET", scope: "CURRENT", minMinor: 2000, currency: "CNY" },
      },
      25 * 3600,
    );
    expect((await service.build(id, {}, undefined, now)).context.location).toBeUndefined();
    await fact(
      id,
      {
        origin: "USER_STATED",
        activityKind: "HOME",
        place: {
          region: "四川",
          city: "成都",
          latitude: 30.6,
          longitude: 104.1,
          coordinateSystem: "GCJ02",
        },
      },
      30 * 86400,
    );
    const built = await service.build(id, {}, undefined, now);
    expect(built.context.location).toMatchObject({
      region: "四川",
      city: "成都",
      source: "SAVED_HOME",
    });
    expect(built.context.location?.latitude).toBeUndefined();
    expect(built.context.availableMinutes).toBeUndefined();
    expect(built.context.budgetMinor).toBeUndefined();
  });
  it("prefers explicit current input and never treats REQUIRED duration or COST as current user constraints", async () => {
    const id = await user();
    await fact(id, {
      origin: "USER_STATED",
      originContext: { region: "广东" },
      duration: { role: "AVAILABLE", scope: "CURRENT", minSeconds: 1200 },
      money: { role: "BUDGET", scope: "CURRENT", minMinor: 2000, currency: "CNY" },
    });
    await fact(
      id,
      {
        origin: "USER_STATED",
        duration: { role: "REQUIRED", minSeconds: 300 },
        money: { role: "COST", minMinor: 10000, currency: "CNY" },
      },
      0,
    );
    const built = await service.build(
      id,
      { availableMinutes: 10, budgetMinor: 0, location: { region: "浙江", source: "USER_INPUT" } },
      undefined,
      now,
    );
    expect(built.context).toMatchObject({
      availableMinutes: 10,
      budgetMinor: 0,
      location: { region: "浙江" },
    });
    const inferredId = await user();
    await fact(inferredId, {
      origin: "INFERRED",
      originContext: { region: "北京" },
      duration: { role: "AVAILABLE", scope: "CURRENT", minSeconds: 500 },
    });
    expect((await service.build(inferredId, {}, undefined, now)).context.location).toBeUndefined();
  });
  it("caps a 60-minute window before a known event and returns zero time while busy", async () => {
    const id = await user();
    const eventId = await fact(
      id,
      {
        origin: "USER_STATED",
        horizon: "SCHEDULED",
        time: { eventStart: "2026-10-05T10:20:00Z", eventEnd: "2026-10-05T11:00:00Z" },
      },
      60,
      "EVENT",
    );
    const built = await service.build(id, { availableMinutes: 60 }, undefined, now);
    expect(built.context.calendar).toMatchObject({
      isBusy: false,
      effectiveAvailableMinutes: 20,
      eventIds: [eventId],
    });
    const busy = await service.build(
      id,
      { availableMinutes: 60 },
      undefined,
      new Date("2026-10-05T10:30:00Z"),
    );
    expect(busy.context.calendar).toMatchObject({
      isBusy: true,
      effectiveAvailableMinutes: 0,
      busyUntil: "2026-10-05T11:00:00.000Z",
    });
  });
  it("bounds exact current coordinates to a two-hour snapshot with no writes to permanent location facts", async () => {
    const id = await user();
    const built = await service.build(
      id,
      {
        location: { latitude: 23.1, longitude: 113.3, coordinateSystem: "GCJ02", source: "DEVICE" },
      },
      undefined,
      now,
    );
    expect(built.snapshot.containsPreciseLocation).toBe(true);
    expect(built.snapshot.purgeAt.getTime() - now.getTime()).toBe(2 * 3600000);
    expect(built.context.location?.expiresAt).toBe("2026-10-05T12:00:00.000Z");
    expect(
      (await source.pool.query("SELECT * FROM life_object_facets WHERE user_id=$1", [id])).rowCount,
    ).toBe(0);
  });
  it("rejects stale/future device observations and incoherent expiry", async () => {
    const id = await user();
    const point = {
      latitude: 23.1,
      longitude: 113.3,
      coordinateSystem: "GCJ02" as const,
      source: "DEVICE" as const,
    };
    for (const extra of [
      { observedAt: "2026-10-05T10:00:01Z" },
      { observedAt: "2026-10-05T07:59:59Z" },
      { observedAt: "2026-10-05T09:00:00Z", expiresAt: "2026-10-05T08:00:00Z" },
      { latitude: Number.NaN },
    ])
      expect(
        (await service.build(id, { location: { ...point, ...extra } }, undefined, now)).context
          .location,
      ).toBeUndefined();
    const valid = await service.build(
      id,
      { location: { ...point, observedAt: "2026-10-05T09:00:00Z" } },
      undefined,
      now,
    );
    expect(valid.context.location?.expiresAt).toBe("2026-10-05T11:00:00.000Z");
  });
  it("uses max-only CURRENT limits and the upper value of a stated range without requiring a fixed clock phrase", async () => {
    const id = await user();
    await fact(id, {
      origin: "USER_STATED",
      evidence: "只有20分钟，最多花二十元",
      duration: { role: "AVAILABLE", scope: "CURRENT", maxSeconds: 1200 },
      money: { role: "BUDGET", scope: "CURRENT", maxMinor: 2000, currency: "CNY" },
    });
    expect((await service.build(id, {}, undefined, now)).context).toMatchObject({
      availableMinutes: 20,
      budgetMinor: 2000,
    });
    const ranged = await user();
    await fact(ranged, {
      origin: "USER_STATED",
      evidence: "这会儿有5到20分钟，这次最多花20元",
      duration: { role: "AVAILABLE", scope: "CURRENT", minSeconds: 300, maxSeconds: 1200 },
      money: { role: "BUDGET", scope: "CURRENT", minMinor: 1000, maxMinor: 2000, currency: "CNY" },
    });
    expect((await service.build(ranged, {}, undefined, now)).context).toMatchObject({
      availableMinutes: 20,
      budgetMinor: 2000,
    });
    const zero = await user();
    await fact(zero, {
      origin: "USER_STATED",
      evidence: "现在没有空，也不花钱",
      duration: { role: "AVAILABLE", scope: "CURRENT", maxSeconds: 0 },
      money: { role: "BUDGET", scope: "CURRENT", maxMinor: 0, currency: "CNY" },
    });
    expect((await service.build(zero, {}, undefined, now)).context).toMatchObject({
      availableMinutes: 0,
      budgetMinor: 0,
      calendar: { effectiveAvailableMinutes: 0 },
    });
  });
  it("does not import object/travel budgets or ambiguous legacy roles into the current context", async () => {
    const id = await user();
    await fact(id, {
      origin: "USER_STATED",
      evidence: "旅行预算3000元",
      money: { role: "BUDGET", scope: "OBJECT", maxMinor: 300000, currency: "CNY" },
      duration: { role: "AVAILABLE", scope: "OBJECT", maxSeconds: 86400 },
    });
    await fact(
      id,
      {
        origin: "USER_STATED",
        evidence: "预算1000元",
        money: { role: "BUDGET", minMinor: 100000, currency: "CNY" },
      },
      0,
    );
    const built = await service.build(id, {}, undefined, now);
    expect(built.context.budgetMinor).toBeUndefined();
    expect(built.context.availableMinutes).toBeUndefined();
  });
  it("consumes the current availability window with server elapsed time, including sub-minute precision", async () => {
    const id = await user();
    await fact(
      id,
      {
        origin: "USER_STATED",
        evidence: "现在只有20分钟",
        duration: { role: "AVAILABLE", scope: "CURRENT", maxSeconds: 1200 },
      },
      360,
    );
    const built = await service.build(id, {}, undefined, now);
    expect(built.context.availableMinutes).toBe(20);
    expect(built.context.calendar).toMatchObject({
      availableUntil: "2026-10-05T10:14:00.000Z",
      effectiveAvailableMinutes: 14,
    });
    const expired = await service.build(id, {}, undefined, new Date(now.getTime() + 15 * 60000));
    expect(expired.context.calendar.effectiveAvailableMinutes).toBe(0);
    expect(expired.context.availableMinutes).toBe(20);
    const precise = await user();
    await fact(
      precise,
      {
        origin: "USER_STATED",
        duration: { role: "AVAILABLE", scope: "CURRENT", maxSeconds: 1200 },
      },
      8,
    );
    const minutes = (await service.build(precise, {}, undefined, now)).context.calendar
      .effectiveAvailableMinutes!;
    expect(minutes).toBeCloseTo(1192 / 60, 8);
    expect(minutes).toBeLessThan(20);
  });
  it("uses a newer current declaration and the tightest limit in repeated same-capture facets", async () => {
    const id = await user();
    await fact(
      id,
      {
        origin: "USER_STATED",
        duration: { role: "AVAILABLE", scope: "CURRENT", maxSeconds: 1200 },
      },
      900,
    );
    const newest = await fact(
      id,
      { origin: "USER_STATED", duration: { role: "AVAILABLE", scope: "CURRENT", maxSeconds: 600 } },
      60,
    );
    const [{ origin_id: captureId }] = (
      await source.pool.query("SELECT origin_id FROM life_object_facets WHERE life_object_id=$1", [
        newest,
      ])
    ).rows;
    await source.pool.query(
      "INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,data,confidence,origin_type,origin_id,created_at) VALUES($1,$2,$3,'DESIRE','second-copy',$4,1,'EXTRACTED',$5,$6)",
      [
        randomUUID(),
        id,
        newest,
        {
          facts: {
            origin: "USER_STATED",
            duration: { role: "AVAILABLE", scope: "CURRENT", maxSeconds: 480 },
          },
        },
        captureId,
        new Date(now.getTime() - 60000),
      ],
    );
    const built = await service.build(id, {}, undefined, now);
    expect(built.context.availableMinutes).toBe(8);
    expect(built.context.calendar.effectiveAvailableMinutes).toBe(7);
    expect(built.context.calendar.availableUntil).toBe("2026-10-05T10:07:00.000Z");
  });
  it("preserves an existing deadline on an unrelated answer but lets fresh availability explicitly replace it", async () => {
    const id = await user();
    await fact(
      id,
      {
        origin: "USER_STATED",
        duration: { role: "AVAILABLE", scope: "CURRENT", maxSeconds: 1200 },
      },
      360,
    );
    const initial = (await service.build(id, {}, undefined, now)).context;
    const later = new Date(now.getTime() + 5 * 60000);
    const preserved = await service.build(id, { ...initial, budgetMinor: 1000 }, undefined, later);
    expect(preserved.context.calendar.effectiveAvailableMinutes).toBe(9);
    expect(preserved.context.calendar.availableUntil).toBe(initial.calendar.availableUntil);
    const fresh = await service.build(id, { availableMinutes: 20 }, undefined, later);
    expect(fresh.context.calendar.effectiveAvailableMinutes).toBe(20);
    expect(fresh.context.calendar.availableUntil).toBe("2026-10-05T10:25:00.000Z");
  });
  it("combines elapsed availability with the next event without subtracting time twice", async () => {
    const id = await user();
    await fact(
      id,
      {
        origin: "USER_STATED",
        duration: { role: "AVAILABLE", scope: "CURRENT", maxSeconds: 1200 },
      },
      360,
    );
    await fact(
      id,
      {
        origin: "USER_STATED",
        time: { eventStart: "2026-10-05T10:10:30Z", eventEnd: "2026-10-05T11:00:00Z" },
      },
      60,
      "EVENT",
    );
    const built = await service.build(id, {}, undefined, now);
    expect(built.context.calendar).toMatchObject({
      availableUntil: "2026-10-05T10:14:00.000Z",
      freeMinutesUntilNextEvent: 10.5,
      effectiveAvailableMinutes: 10.5,
    });
    nowContextSchema.parse(built.context);
  });
  it("uses exact model event windows through their captured raw expressions", async () => {
    const id = await user();
    const facts = {
      origin: "USER_STATED",
      evidence: "明天下午3点到4点有线上会议",
      time: { windowStart: "2026-10-06T07:00:00Z", windowEnd: "2026-10-06T08:00:00Z" },
    };
    const eventId = await fact(id, facts, 60, "EVENT");
    await source.pool.query("UPDATE life_object_facets SET data=$1 WHERE life_object_id=$2", [
      {
        facts,
        normalization: {
          referenceTime: "2026-10-05T09:59:00Z",
          timezone: "Asia/Shanghai",
          rawTime: { windowStart: "明天下午3点", windowEnd: "明天下午4点" },
          warnings: [],
        },
      },
      eventId,
    ]);
    const busy = await service.build(id, {}, undefined, new Date("2026-10-06T07:30:00Z"));
    expect(busy.context.calendar).toMatchObject({
      isBusy: true,
      busyUntil: "2026-10-06T08:00:00.000Z",
      eventIds: [eventId],
    });
  });
  it("never treats fuzzy or ungrounded model windows as a fixed busy interval", async () => {
    for (const warnings of [[], ["windowStart:TIME_NOT_GROUNDED"]]) {
      const id = await user();
      const facts = {
        origin: "USER_STATED",
        evidence: "明天下午有线上会议",
        time: { windowStart: "2026-10-06T04:00:00Z", windowEnd: "2026-10-06T10:00:00Z" },
      };
      const eventId = await fact(id, facts, 60, "EVENT");
      await source.pool.query("UPDATE life_object_facets SET data=$1 WHERE life_object_id=$2", [
        {
          facts,
          normalization: {
            referenceTime: "2026-10-05T09:59:00Z",
            timezone: "Asia/Shanghai",
            rawTime: {
              windowStart: warnings.length ? "明天下午3点" : "明天下午",
              windowEnd: warnings.length ? "明天下午4点" : "明天下午",
            },
            warnings,
          },
        },
        eventId,
      ]);
      expect(
        (await service.build(id, {}, undefined, new Date("2026-10-06T07:30:00Z"))).context.calendar,
      ).toMatchObject({ isBusy: false, eventIds: [] });
    }
  });
  it("accepts explicit ISO windows on a manually confirmed event", async () => {
    const id = await user();
    const eventId = await fact(
      id,
      {
        origin: "USER_STATED",
        time: { windowStart: "2026-10-05T09:30:00Z", windowEnd: "2026-10-05T10:30:00Z" },
      },
      60,
      "EVENT",
    );
    await source.pool.query(
      "UPDATE life_object_facets SET origin_type='USER_STATED' WHERE life_object_id=$1",
      [eventId],
    );
    expect((await service.build(id, {}, undefined, now)).context.calendar).toMatchObject({
      isBusy: true,
      busyUntil: "2026-10-05T10:30:00.000Z",
    });
  });
  it("finds an older future event even behind over five hundred recent irrelevant facets", async () => {
    const id = await user();
    const eventId = await fact(
      id,
      {
        origin: "USER_STATED",
        horizon: "SCHEDULED",
        time: { windowStart: "2026-10-05T10:20:00Z", windowEnd: "2026-10-05T11:00:00Z" },
      },
      10 * 86400,
      "EVENT",
    );
    await source.pool.query(
      "UPDATE life_object_facets SET origin_type='USER_STATED' WHERE life_object_id=$1",
      [eventId],
    );
    await source.pool.query(
      "INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,data,confidence,origin_type,created_at) SELECT gen_random_uuid(),$1,$2,'DESIRE','irrelevant','{}',1,'EXTRACTED',$3 FROM generate_series(1,550)",
      [id, eventId, now],
    );
    const built = await service.build(id, { availableMinutes: 60 }, undefined, now);
    expect(built.context.calendar).toMatchObject({
      effectiveAvailableMinutes: 20,
      eventIds: [eventId],
    });
  });
  it("purges only the owner's expired snapshots and caps legacy precise retention at 24 hours", async () => {
    const id = await user(),
      other = await user();
    const seed = async (owner: string, expired: boolean, legacy: boolean) => {
      const sessionId = randomUUID(),
        snapshotId = randomUUID();
      await source.pool.query(
        "INSERT INTO decision_sessions(id,user_id,status,scoring_version,question_policy_version,context_summary,expires_at) VALUES($1,$2,'QUIET','test','test','{}',$3)",
        [sessionId, owner, new Date(now.getTime() + 3600000)],
      );
      await source.pool.query(
        "INSERT INTO context_snapshots(id,user_id,decision_session_id,context,contains_precise_location,purge_at,created_at) VALUES($1,$2,$3,$4,true,$5,$6)",
        [
          snapshotId,
          owner,
          sessionId,
          { location: { latitude: 23.1, longitude: 113.3 } },
          legacy ? null : new Date(now.getTime() + (expired ? -1000 : 3600000)),
          new Date(now.getTime() - (legacy ? 25 : 1) * 3600000),
        ],
      );
      return snapshotId;
    };
    const expired = await seed(id, true, false),
      legacy = await seed(id, false, true),
      live = await seed(id, false, false),
      foreign = await seed(other, true, false);
    await service.build(id, {}, undefined, now);
    const snapshots = (
      await source.pool.query("SELECT id FROM context_snapshots WHERE id=ANY($1::uuid[])", [
        [expired, legacy, live, foreign],
      ])
    ).rows.map((row) => row.id);
    expect(snapshots).toContain(live);
    expect(snapshots).toContain(foreign);
    expect(snapshots).not.toContain(expired);
    expect(snapshots).not.toContain(legacy);
  });
  it("marks accepted plans busy until terminal feedback cancels them", async () => {
    const id = await user(),
      sessionId = randomUUID(),
      candidateId = randomUUID(),
      recId = randomUUID();
    await source.pool.query(
      "INSERT INTO decision_sessions(id,user_id,status,scoring_version,question_policy_version,context_summary,expires_at) VALUES($1,$2,'RECOMMENDED','test','test','{}',$3)",
      [sessionId, id, new Date(now.getTime() + 3600000)],
    );
    await source.pool.query(
      "INSERT INTO action_candidates(id,user_id,decision_session_id,action_type,action_payload,value_score,fit_score,friction_score,urgency_score,uncertainty_score,total_score,hard_filter_status,generator_version,scoring_version) VALUES($1,$2,$3,'START_TIMER','{}',1,1,0,0,0,1,'ELIGIBLE','test','test')",
      [candidateId, id, sessionId],
    );
    await source.pool.query(
      "INSERT INTO recommendations(id,user_id,decision_session_id,action_candidate_id,headline,execution_type,execution_payload,copy_version) VALUES($1,$2,$3,$4,'test','START_TIMER',$5,'test')",
      [recId, id, sessionId, candidateId, { plan: { totalSeconds: 1800 } }],
    );
    await source.pool.query(
      "INSERT INTO feedback_events(id,user_id,recommendation_id,decision_session_id,event_type,client_event_id,created_at,metadata) VALUES($1,$2,$3,$4,'ACCEPT',$5,$6,$7)",
      [
        randomUUID(),
        id,
        recId,
        sessionId,
        randomUUID(),
        new Date(now.getTime() - 600000),
        {
          serverPlan: {
            startAt: "2026-10-05T09:50:00Z",
            endAt: "2026-10-05T10:20:00Z",
            totalSeconds: 1800,
          },
        },
      ],
    );
    expect((await service.build(id, {}, undefined, now)).context.calendar).toMatchObject({
      isBusy: true,
      busyUntil: "2026-10-05T10:20:00.000Z",
      effectiveAvailableMinutes: 0,
    });
    await source.pool.query(
      "INSERT INTO feedback_events(id,user_id,recommendation_id,decision_session_id,event_type,client_event_id,created_at) VALUES($1,$2,$3,$4,'COMPLETE',$5,$6)",
      [randomUUID(), id, recId, sessionId, randomUUID(), now],
    );
    expect((await service.build(id, {}, undefined, now)).context.calendar.isBusy).toBe(false);
  });
  it("anchors busy time to the first EXECUTE even when later EXECUTE and ACCEPT signals repeat", async () => {
    const id = await user(),
      sessionId = randomUUID(),
      candidateId = randomUUID(),
      recId = randomUUID();
    await source.pool.query(
      "INSERT INTO decision_sessions(id,user_id,status,scoring_version,question_policy_version,context_summary,expires_at) VALUES($1,$2,'RECOMMENDED','test','test','{}',$3)",
      [sessionId, id, new Date(now.getTime() + 3600000)],
    );
    await source.pool.query(
      "INSERT INTO action_candidates(id,user_id,decision_session_id,action_type,action_payload,value_score,fit_score,friction_score,urgency_score,uncertainty_score,total_score,hard_filter_status,generator_version,scoring_version) VALUES($1,$2,$3,'START_TIMER','{}',1,1,0,0,0,1,'ELIGIBLE','test','test')",
      [candidateId, id, sessionId],
    );
    await source.pool.query(
      "INSERT INTO recommendations(id,user_id,decision_session_id,action_candidate_id,headline,execution_type,execution_payload,copy_version) VALUES($1,$2,$3,$4,'test','START_TIMER',$5,'test')",
      [recId, id, sessionId, candidateId, { plan: { totalSeconds: 1800 } }],
    );
    for (const [type, minutesAgo, metadata] of [
      [
        "EXECUTE",
        10,
        {
          serverPlan: {
            startAt: "2026-10-05T09:50:00Z",
            endAt: "2026-10-05T10:20:00Z",
            totalSeconds: 1800,
          },
        },
      ],
      ["EXECUTE", 5, null],
      ["ACCEPT", 2, null],
    ] as const)
      await source.pool.query(
        "INSERT INTO feedback_events(id,user_id,recommendation_id,decision_session_id,event_type,client_event_id,created_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          randomUUID(),
          id,
          recId,
          sessionId,
          type,
          randomUUID(),
          new Date(now.getTime() - minutesAgo * 60000),
          metadata,
        ],
      );
    expect((await service.build(id, {}, undefined, now)).context.calendar).toMatchObject({
      isBusy: true,
      busyUntil: "2026-10-05T10:20:00.000Z",
    });
    expect(
      (await service.build(id, {}, undefined, new Date("2026-10-05T10:24:00Z"))).context.calendar
        .isBusy,
    ).toBe(false);
    await source.pool.query(
      "INSERT INTO feedback_events(id,user_id,recommendation_id,decision_session_id,event_type,client_event_id,created_at) VALUES($1,$2,$3,$4,'COMPLETE',$5,$6)",
      [randomUUID(), id, recId, sessionId, randomUUID(), now],
    );
    expect((await service.build(id, {}, undefined, now)).context.calendar.isBusy).toBe(false);
  });
});

describe("bounded explicit-origin travel enrichment", () => {
  const origin: GeoPoint = { latitude: 23.1, longitude: 113.3, coordinateSystem: "GCJ02" };
  const dest: GeoPoint = { latitude: 23.2, longitude: 113.4, coordinateSystem: "GCJ02" };
  it("uses distinct outward and return calls, only five targets and at most two active queries", async () => {
    let active = 0,
      peak = 0;
    const calls: [GeoPoint, GeoPoint][] = [];
    const provider: LocationProvider = {
      configured: true,
      geocode: async () => ({ ok: false, reason: "AMBIGUOUS_ADDRESS" }),
      route: async (from, to) => {
        calls.push([from, to]);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return {
          ok: true,
          value: {
            durationSeconds: from.latitude === origin.latitude ? 120 : 180,
            distanceMeters: 500,
            mode: "walking",
            provider: "TENCENT",
            observedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          },
        };
      },
    };
    const mapper = new BuildDecisionContextService(source.db, provider);
    const result = await mapper.enrichCandidates(
      {
        location: {
          ...origin,
          source: "DEVICE",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      },
      Array.from({ length: 9 }, (_, i) => ({
        id: String(i),
        title: "地方",
        kind: "PLACE",
        location: dest,
      })),
    );
    expect(Object.keys(result)).toHaveLength(5);
    expect(calls).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(2);
    expect(calls[0]).toEqual([origin, dest]);
    expect(
      calls.some(
        ([from, to]) => from.latitude === dest.latitude && to.latitude === origin.latitude,
      ),
    ).toBe(true);
    expect(result["0"]?.route).toMatchObject({
      durationSeconds: 120,
      returnDurationSeconds: 180,
      origin,
      destination: dest,
    });
  });
  it("does not route from saved home, a city centroid or expired coordinates", async () => {
    let calls = 0;
    const provider: LocationProvider = {
      configured: true,
      geocode: async () => {
        calls++;
        return { ok: false, reason: "TIMEOUT" };
      },
      route: async () => {
        calls++;
        return { ok: false, reason: "TIMEOUT" };
      },
    };
    const mapper = new BuildDecisionContextService(source.db, provider),
      targets = [{ id: "a", title: "地方", kind: "PLACE", location: dest }];
    for (const location of [
      { region: "广东", source: "USER_INPUT" as const },
      { ...origin, source: "SAVED_HOME" as const },
      { ...origin, source: "DEVICE" as const, expiresAt: "2020-01-01T00:00:00Z" },
      {
        ...origin,
        source: "DEVICE" as const,
        observedAt: new Date(Date.now() + 60000).toISOString(),
      },
      {
        ...origin,
        source: "DEVICE" as const,
        observedAt: new Date(Date.now() - 3 * 3600000).toISOString(),
      },
      { ...origin, source: "DEVICE" as const, latitude: Number.NaN },
    ])
      expect((await mapper.enrichCandidates({ location }, targets)).a?.status).toBe("UNAVAILABLE");
    expect(calls).toBe(0);
  });
  it("requires a successful return journey and stops a stalled batch after four seconds", async () => {
    let calls = 0;
    const provider: LocationProvider = {
      configured: true,
      geocode: async () => ({ ok: false, reason: "TIMEOUT" }),
      route: async () => {
        calls++;
        return calls % 2 === 1
          ? {
              ok: true,
              value: {
                durationSeconds: 120,
                distanceMeters: 500,
                mode: "walking",
                provider: "TENCENT",
                observedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 300000).toISOString(),
              },
            }
          : { ok: false, reason: "PROVIDER_REJECTED" };
      },
    };
    const context = { location: { ...origin, source: "DEVICE" as const } };
    const targets = [{ id: "a", title: "地方", kind: "PLACE", location: dest }];
    const result = await new BuildDecisionContextService(source.db, provider).enrichCandidates(
      context,
      targets,
    );
    expect(result.a).toEqual({ status: "UNAVAILABLE", reason: "PROVIDER_REJECTED" });
    const stalled: LocationProvider = { ...provider, route: () => new Promise(() => {}) };
    const start = Date.now();
    const timeout = await new BuildDecisionContextService(source.db, stalled).enrichCandidates(
      context,
      targets,
    );
    expect(Date.now() - start).toBeLessThan(4300);
    expect(timeout.a).toEqual({ status: "UNAVAILABLE", reason: "TIMEOUT" });
  });
});
