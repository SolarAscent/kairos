import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createDatabase } from "@life/db";
import { nowResponseSchema } from "@life/contracts";
import {
  TencentLbsAdapter,
  type LocationProvider,
  type MapFailure,
  type GeoPoint,
} from "@life/integrations";
import { migrate } from "../../packages/db/dist/migrations.js";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";
import { BuildDecisionContextService } from "../../apps/api/dist/context/build-decision-context.service.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
const schema = "route_focus_" + randomUUID().replaceAll("-", ""),
  admin = createDatabase(testUrl),
  url = new URL(testUrl);
url.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(url.toString()),
  pool = source.pool,
  originalEnv = { ...process.env };
const origin: GeoPoint = { latitude: 23.1, longitude: 113.3, coordinateSystem: "GCJ02" };
const destination: GeoPoint = { latitude: 23.105, longitude: 113.305, coordinateSystem: "GCJ02" };
let app: Awaited<ReturnType<typeof createApiApp>>,
  failure: MapFailure | undefined,
  throwRoute = false;
let calls = 0;
const addresses: Array<{ address: string; city?: string }> = [];
const provider: LocationProvider = {
  configured: true,
  geocode: async (address, city) => {
    addresses.push({ address, city });
    return { ok: true, value: { location: destination, reliability: 9, level: 10 } };
  },
  route: async () => {
    calls++;
    if (throwRoute) throw new Error("synthetic transport failure");
    return failure
      ? { ok: false, reason: failure }
      : {
          ok: true,
          value: {
            distanceMeters: 100,
            durationSeconds: 120,
            mode: "walking",
            provider: "TENCENT",
            observedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          },
        };
  },
};
type Owner = { userId: string; accessToken: string };
async function req(
  method: "POST" | "GET",
  path: string,
  owner: Owner | string,
  body?: object,
  key = randomUUID(),
) {
  return app.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${typeof owner === "string" ? owner : owner.accessToken}`,
      "x-idempotency-key": key,
    },
    ...(body ? { payload: body } : {}),
  });
}
async function owner(): Promise<Owner> {
  return (await req("POST", "/v1/auth/wechat/login", "", { code: randomUUID() })).json().data;
}
async function seed(user: Owner, kind = "PLACE", withCity = true) {
  const id = randomUUID(),
    title = kind === "PLACE" ? "广州市合成地点" : "合成阅读事项";
  await pool.query(
    "INSERT INTO life_objects(id,user_id,title,kind,importance_score) VALUES($1,$2,$3,$4,0.9)",
    [id, user.userId, title, kind],
  );
  await pool.query(
    `INSERT INTO life_object_projection(life_object_id,user_id,display_kind,search_text,projection_version,duration_min_seconds)
    VALUES($1,$2,$3,$4,'route-fixture',600)`,
    [id, user.userId, kind, title],
  );
  const facts = {
    origin: "USER_STATED",
    evidence: "合成事项需要十分钟且免费",
    duration: { role: "REQUIRED", minSeconds: 600 },
    money: { role: "COST", minMinor: 0, currency: "CNY" },
    activityKind: kind === "PLACE" ? "LOCAL_OUTING" : "HOME",
    ...(kind === "PLACE" ? { place: { name: title, ...(withCity ? { city: "广州" } : {}) } } : {}),
  };
  await pool.query(
    `INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,data,confidence,origin_type)
    VALUES($1,$2,$3,$4,'fixture',$5,1,'USER_STATED')`,
    [randomUUID(), user.userId, id, kind, { facts }],
  );
  return id;
}
function input(focusObjectId?: string, availableMinutes = 60) {
  return {
    ...(focusObjectId ? { focusObjectId } : {}),
    context: {
      availableMinutes,
      budgetMinor: 0,
      willingToGoOut: true,
      location: {
        ...origin,
        source: "DEVICE",
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    },
  };
}
beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    JWT_SECRET: "route-focus-test-secret-at-least-32-chars",
    WECHAT_MOCK_LOGIN: "true",
    NODE_ENV: "test",
  });
  app = await createApiApp({ locationProvider: provider });
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

describe("targeted, bounded route checks", () => {
  it("does not let five liked indoor cards consume the route quota", async () => {
    const user = await owner(),
      place = await seed(user);
    for (let i = 0; i < 5; i++) {
      const media = await seed(user, "MEDIA");
      await req("POST", `/v1/life/${media}/rating`, user, { rating: "LIKE" });
    }
    const before = calls,
      response = await req("POST", "/v1/now/sessions", user, input());
    expect(response.statusCode).toBe(201);
    const state = nowResponseSchema.parse(response.json().data);
    expect(calls - before).toBe(2);
    expect(state.candidates.find((item) => item.lifeObjectId === place)?.routeCheck).toMatchObject({
      status: "READY",
      reason: null,
    });
  });
  it("keeps a focused target through idempotent replay and accepts a full destination without a separate city", async () => {
    const user = await owner(),
      target = await seed(user, "PLACE", false),
      media = await seed(user, "MEDIA"),
      key = randomUUID();
    await req("POST", `/v1/life/${media}/rating`, user, { rating: "LIKE" });
    const body = input(target),
      before = calls,
      response = await req("POST", "/v1/now/sessions", user, body, key);
    expect(response.statusCode).toBe(201);
    const state = nowResponseSchema.parse(response.json().data);
    expect(state.focusObjectId).toBe(target);
    expect(state.routeCheck).toMatchObject({ status: "READY", reason: null });
    expect(state.routeCheck?.detail).toMatchObject({
      origin,
      destination,
      outwardSeconds: 120,
      returnSeconds: 120,
      outwardMeters: 100,
      returnMeters: 100,
      requiredSeconds: 840,
      departureBlocker: null,
    });
    expect(state.recommendation?.targetLifeObjectId).toBe(target);
    expect(state.recommendation?.plan?.mode).toBe("DO");
    expect(new Set(state.candidates.map((item) => item.lifeObjectId))).toEqual(new Set([target]));
    expect(addresses.at(-1)?.city).toBeUndefined();
    expect(calls - before).toBe(2);
    const replay = await req("POST", "/v1/now/sessions", user, body, key);
    expect(replay.json().data.sessionId).toBe(state.sessionId);
    expect(replay.json().data.replayed).toBe(true);
    expect(replay.json().data.routeCheck.detail).toMatchObject({
      origin,
      destination,
      departureBlocker: null,
    });
    expect(calls - before).toBe(2);
    expect((await req("POST", "/v1/now/sessions", user, input(media), key)).statusCode).toBe(409);
  });
  it("rejects foreign/deleted focus and conflicting exclusions without a billable query", async () => {
    const user = await owner(),
      other = await owner(),
      foreign = await seed(other),
      target = await seed(user),
      before = calls;
    expect((await req("POST", "/v1/now/sessions", user, input(foreign))).statusCode).toBe(404);
    expect(
      (
        await req("POST", "/v1/now/sessions", user, {
          ...input(target),
          excludeObjectIds: [target],
        })
      ).statusCode,
    ).toBe(400);
    await pool.query("UPDATE life_objects SET status='DELETED',deleted_at=now() WHERE id=$1", [
      target,
    ]);
    expect((await req("POST", "/v1/now/sessions", user, input(target))).statusCode).toBe(404);
    expect(calls).toBe(before);
  });
  it("preserves the stored focus when a pending question is continued", async () => {
    const user = await owner(),
      target = await seed(user),
      other = await seed(user, "MEDIA");
    await req("POST", `/v1/life/${other}/rating`, user, { rating: "LIKE" });
    const state = nowResponseSchema.parse(
      (await req("POST", "/v1/now/sessions", user, input(target))).json().data,
    );
    const questionId = randomUUID();
    // A stored question is valid across server versions; follow-up must retain its original target scope.
    await pool.query("UPDATE decision_sessions SET status='NEEDS_ANSWER' WHERE id=$1", [
      state.sessionId,
    ]);
    await pool.query(
      `INSERT INTO clarification_requests(id,user_id,decision_session_id,scope_type,question_key,question_text,options,sequence,status)
      VALUES($1,$2,$3,'DECISION','AVAILABLE_TIME','synthetic question',$4,1,'PENDING')`,
      [
        questionId,
        user.userId,
        state.sessionId,
        {
          items: [
            { id: "TIME_30", label: "30分钟" },
            { id: "TIME_60", label: "60分钟" },
          ],
        },
      ],
    );
    const reply = await req("POST", `/v1/now/sessions/${state.sessionId}/answers`, user, {
      questionId,
      optionId: "TIME_30",
    });
    expect(reply.statusCode).toBe(201);
    const continued = nowResponseSchema.parse(reply.json().data);
    expect(continued.focusObjectId).toBe(target);
    expect(continued.recommendation?.targetLifeObjectId).toBe(target);
    expect(continued.candidates.every((candidate) => candidate.lifeObjectId === target)).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT context_summary->>'focusObjectId' AS focus FROM decision_sessions WHERE id=$1",
          [state.sessionId],
        )
      ).rows[0].focus,
    ).toBe(target);
  });
  it("exposes provider failure without disguising it as a successful DO plan", async () => {
    const user = await owner(),
      target = await seed(user);
    for (const reason of ["QUOTA_EXCEEDED", "RATE_LIMITED", "PROVIDER_REJECTED"] as const) {
      failure = reason;
      const response = await req("POST", "/v1/now/sessions", user, input(target));
      expect(response.statusCode).toBe(201);
      const state = nowResponseSchema.parse(response.json().data);
      expect(state.routeCheck).toEqual({ status: "UNAVAILABLE", reason });
      expect(state.recommendation?.plan?.mode).toBe("PREPARE");
      expect(
        (await req("GET", `/v1/now/sessions/${state.sessionId}`, user)).json().data.routeCheck,
      ).toEqual(state.routeCheck);
    }
    failure = undefined;
    throwRoute = true;
    const thrown = await req("POST", "/v1/now/sessions", user, input(target));
    expect(thrown.statusCode).toBe(201);
    expect(thrown.json().data.routeCheck.reason).toBe("PROVIDER_UNAVAILABLE");
    throwRoute = false;
  });
  it("keeps hard time and active-plan constraints even when the route is verified", async () => {
    const user = await owner(),
      target = await seed(user);
    const tooShort = nowResponseSchema.parse(
      (await req("POST", "/v1/now/sessions", user, input(target, 5))).json().data,
    );
    expect(tooShort.routeCheck?.status).toBe("READY");
    expect(tooShort.recommendation?.plan?.mode).toBe("PREPARE");
    expect(tooShort.routeCheck?.detail).toMatchObject({
      departureBlocker: "TIME_LIMIT",
      requiredSeconds: 840,
    });
    expect(tooShort.routeCheck?.detail?.availableSeconds).toBeGreaterThanOrEqual(299);
    expect(tooShort.routeCheck?.detail?.availableSeconds).toBeLessThanOrEqual(300);
    expect(tooShort.recommendation?.reasonText).toContain("超过当前可用的 5 分钟");
    expect(tooShort.candidates.find((item) => item.actionMode === "DO")?.filterReason).toBe(
      "TIME_LIMIT",
    );
    const ready = nowResponseSchema.parse(
      (await req("POST", "/v1/now/sessions", user, input(target))).json().data,
    );
    const accepted = await req("POST", `/v1/now/sessions/${ready.sessionId}/feedback`, user, {
      clientEventId: randomUUID(),
      eventType: "ACCEPT",
    });
    expect(accepted.statusCode).toBe(201);
    const before = calls,
      busy = nowResponseSchema.parse(
        (await req("POST", "/v1/now/sessions", user, input(target))).json().data,
      );
    expect(busy.status).toBe("QUIET");
    expect(busy.recommendation).toBeNull();
    expect(busy.routeCheck?.reason).toBe("CURRENTLY_BUSY");
    expect(calls).toBe(before);
  });
  it("explains unknown visit duration after route verification and keeps precise detail only in the expiring snapshot", async () => {
    const user = await owner(),
      target = await seed(user),
      key = randomUUID();
    await pool.query(
      "UPDATE life_object_projection SET duration_min_seconds=NULL WHERE life_object_id=$1",
      [target],
    );
    await pool.query(
      `UPDATE life_object_facets SET data=jsonb_set(data,'{facts,duration}',$2::jsonb) WHERE life_object_id=$1`,
      [target, JSON.stringify({ role: "AVAILABLE", scope: "CURRENT", minSeconds: 7200 })],
    );
    const body = input(target, 120);
    const state = nowResponseSchema.parse(
      (await req("POST", "/v1/now/sessions", user, body, key)).json().data,
    );
    expect(state.recommendation?.plan?.mode).toBe("PREPARE");
    expect(state.routeCheck).toMatchObject({
      status: "READY",
      reason: null,
      detail: {
        origin,
        destination,
        destinationLabel: "广州市合成地点",
        departureBlocker: "DURATION_UNKNOWN",
        requiredSeconds: null,
      },
    });
    expect(state.routeCheck?.detail?.availableSeconds).toBeGreaterThanOrEqual(7199);
    expect(state.routeCheck?.detail?.availableSeconds).toBeLessThanOrEqual(7200);
    expect(state.recommendation?.reasonText).toContain("要停留多久");
    expect(state.recommendation?.reasonText).toContain("可用时间，不是活动所需时长");
    expect(state.recommendation?.body).not.toContain("核对往返交通");
    const saved = await pool.query(
      `SELECT
      (SELECT jsonb_agg(action_payload) FROM action_candidates WHERE decision_session_id=$1) AS actions,
      (SELECT jsonb_agg(execution_payload) FROM recommendations WHERE decision_session_id=$1) AS recommendations,
      (SELECT response_body FROM idempotency_keys WHERE user_id=$2 AND idempotency_key=$3) AS response,
      (SELECT context FROM context_snapshots WHERE decision_session_id=$1 ORDER BY created_at DESC LIMIT 1) AS snapshot`,
      [state.sessionId, user.userId, key],
    );
    for (const store of [
      saved.rows[0].actions,
      saved.rows[0].recommendations,
      saved.rows[0].response,
    ]) {
      expect(JSON.stringify(store)).not.toContain('"origin"');
      expect(JSON.stringify(store)).not.toContain('"latitude"');
      expect(JSON.stringify(store)).not.toContain('"detail"');
    }
    expect(saved.rows[0].snapshot.verifiedRouteDetails[target].detail.origin).toEqual(origin);
    expect(
      (await req("GET", `/v1/now/sessions/${state.sessionId}`, user)).json().data.routeCheck.detail,
    ).toMatchObject({ origin, departureBlocker: "DURATION_UNKNOWN" });
    await pool.query(
      "UPDATE context_snapshots SET purge_at=now()-interval '1 second' WHERE decision_session_id=$1",
      [state.sessionId],
    );
    for (const response of [
      await req("GET", `/v1/now/sessions/${state.sessionId}`, user),
      await req("POST", "/v1/now/sessions", user, body, key),
    ]) {
      expect(response.json().data.routeCheck).toEqual({ status: "READY", reason: null });
      expect(
        response
          .json()
          .data.candidates.every(
            (item: { routeCheck?: { detail?: unknown } }) => !item.routeCheck?.detail,
          ),
      ).toBe(true);
    }
  });
  it("omits map detail for expired routes, changed source objects, and mismatched snapshot origins", async () => {
    const user = await owner(),
      target = await seed(user),
      another = await owner();
    for (const mutation of ["route", "object", "origin"] as const) {
      const state = nowResponseSchema.parse(
        (await req("POST", "/v1/now/sessions", user, input(target))).json().data,
      );
      expect(state.routeCheck?.detail?.origin).toEqual(origin);
      if (mutation === "route")
        await pool.query(
          `UPDATE context_snapshots SET context=jsonb_set(context,ARRAY['verifiedRouteDetails',$2,'expiresAt'],to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE decision_session_id=$1`,
          [state.sessionId, target],
        );
      if (mutation === "object")
        await pool.query("UPDATE life_objects SET object_version=object_version+1 WHERE id=$1", [
          target,
        ]);
      if (mutation === "origin")
        await pool.query(
          `UPDATE context_snapshots SET context=jsonb_set(context,'{location,latitude}','24.1'::jsonb) WHERE decision_session_id=$1`,
          [state.sessionId],
        );
      expect(
        (await req("GET", `/v1/now/sessions/${state.sessionId}`, user)).json().data.routeCheck,
      ).toEqual({ status: "READY", reason: null });
      expect((await req("GET", `/v1/now/sessions/${state.sessionId}`, another)).statusCode).toBe(
        404,
      );
    }
  });
  it("finishes all five round trips with the real adapter's synthetic 250ms start pacing", async () => {
    let starts = 0;
    const adapter = new TencentLbsAdapter(
      { key: "synthetic-" + randomUUID(), rateIntervalMs: 250 },
      async () => {
        starts++;
        return new Response(
          JSON.stringify({ status: 0, result: { routes: [{ duration: 1, distance: 100 }] } }),
        );
      },
    );
    const mapper = new BuildDecisionContextService(source.db, adapter),
      start = Date.now();
    const results = await mapper.enrichCandidates(
      { location: { ...origin, source: "DEVICE" } },
      Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        title: "synthetic",
        kind: "PLACE",
        location: destination,
      })),
    );
    expect(starts).toBe(10);
    expect(Object.values(results).every((item) => item.status === "READY")).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(2100);
    expect(Date.now() - start).toBeLessThan(4000);
  }, 10000);
});
