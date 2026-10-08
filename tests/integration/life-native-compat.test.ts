import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@life/db";
import {
  captureAcceptedSchema,
  captureImageResponseSchema,
  lifeDetailResponseSchema,
  lifeSearchResponseSchema,
  nowContextSchema,
  nowResponseSchema,
  recordExportPageSchema,
  uiCapabilitiesResponseSchema,
  userSettingsResponseSchema,
} from "@life/contracts";
import { migrate } from "../../packages/db/dist/migrations.js";
import { ActionPlanService } from "../../apps/api/dist/planning/action-plan.service.js";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
const schema = "native_compat_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(testUrl);
const scopedUrl = new URL(testUrl);
// The only schema in search_path is our disposable schema, including when a table is absent.
scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(scopedUrl.toString());
const pool = source.pool;
const originalEnv = { ...process.env };
let app: Awaited<ReturnType<typeof createApiApp>> | undefined;
let schemaCreated = false;

type Identity = { userId: string; accessToken: string };
async function request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  identity?: Identity,
  body?: object,
  key: string | undefined = randomUUID(),
) {
  if (!app) throw new Error("TEST_APP_NOT_READY");
  return app.inject({
    method,
    url: path,
    headers: {
      ...(identity ? { authorization: `Bearer ${identity.accessToken}` } : {}),
      ...(key ? { "x-idempotency-key": key } : {}),
    },
    ...(body ? { payload: body } : {}),
  });
}
async function login(): Promise<Identity> {
  const response = await request("POST", "/v1/auth/wechat/login", undefined, {
    code: randomUUID(),
  });
  expect(response.statusCode).toBe(201);
  return response.json().data;
}
async function settings(identity: Identity) {
  const response = await request("GET", "/v1/settings", identity);
  expect(response.statusCode).toBe(200);
  return userSettingsResponseSchema.parse(response.json().data);
}
async function lifeObject(identity: Identity, title: string, summary: string | null = null) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO life_objects(id,user_id,title,summary,kind) VALUES($1,$2,$3,$4,'MEDIA')",
    [id, identity.userId, title, summary],
  );
  return id;
}
async function search(identity: Identity, query: string, cursor?: string, limit = 20) {
  const response = await request("POST", "/v1/life/search", identity, {
    query,
    limit,
    ...(cursor ? { cursor } : {}),
  });
  expect(response.statusCode).toBe(200);
  return lifeSearchResponseSchema.parse(response.json().data);
}

beforeAll(async () => {
  // Verify connectivity before creating or migrating the scoped database connection.
  expect((await admin.pool.query("SELECT 1 AS available")).rows[0].available).toBe(1);
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  expect((await pool.query("SHOW search_path")).rows[0].search_path).toBe(schema);
  await migrate(pool);
  Object.assign(process.env, {
    DATABASE_URL: scopedUrl.toString(),
    JWT_SECRET: "native-lifestyle-test-secret-over-32-characters",
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
  if (schemaCreated) await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
});

describe("life native functionality API integration", () => {
  it("searches active and happened records in one owner-bound continuation without including archived records", async () => {
    const owner = await login(),
      other = await login();
    const ids: string[] = [];
    for (const status of ["ACTIVE", "RESOLVED", "ACTIVE", "RESOLVED", "ARCHIVED", "DELETED"]) {
      const id = await lifeObject(owner, "跨状态搜索", "共享摘要关键词");
      await pool.query("UPDATE life_objects SET status=$2 WHERE id=$1", [id, status]);
      if (status === "ACTIVE" || status === "RESOLVED") ids.push(id);
    }
    await lifeObject(other, "跨状态搜索", "共享摘要关键词");
    expect((await search(owner, "共享摘要关键词")).items).toHaveLength(2);
    const happened = await request("POST", "/v1/life/search", owner, {
      section: "HAPPENED",
      query: "共享摘要关键词",
    });
    expect(happened.json().data.items).toHaveLength(2);
    const input = { scope: "ALL_RECORDED", section: "UPCOMING", query: "共享摘要关键词", limit: 2 };
    const first = await request("POST", "/v1/life/search", owner, input);
    expect(first.statusCode).toBe(200);
    const page = lifeSearchResponseSchema.parse(first.json().data);
    expect(page.nextCursor).not.toBeNull();
    expect(page.nextCursor!.length).toBeLessThanOrEqual(256);
    const next = await request("POST", "/v1/life/search", owner, {
      ...input,
      cursor: page.nextCursor,
    });
    expect(next.statusCode).toBe(200);
    expect([...page.items, ...next.json().data.items].map((item) => item.id).sort()).toEqual(
      ids.sort(),
    );
    for (const changes of [
      { scope: "SECTION" },
      { query: "跨状态搜索" },
      { location: "UNLOCATED" },
    ]) {
      const invalid = await request("POST", "/v1/life/search", owner, {
        ...input,
        ...changes,
        cursor: page.nextCursor,
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("INVALID_LIFE_CURSOR");
    }
    expect(
      (await request("POST", "/v1/life/search", other, { ...input, cursor: page.nextCursor }))
        .statusCode,
    ).toBe(400);
  });

  it("persists confirmed native map points in details while keeping them distinct from external verification", async () => {
    const owner = await login(),
      other = await login();
    const id = await lifeObject(owner, "广州图书馆");
    await pool.query("UPDATE life_objects SET kind='PLACE' WHERE id=$1", [id]);
    const intent = await request("POST", "/v1/locations/picker-intents", owner, {
      lifeObjectId: id,
    });
    expect(intent.statusCode).toBe(201);
    const selected = {
      lifeObjectId: id,
      intentToken: intent.json().data.intentToken,
      name: "广州图书馆",
      address: "广州市天河区珠江东路4号",
      location: { latitude: 23.117, longitude: 113.325, coordinateSystem: "GCJ02" },
    };
    expect((await request("POST", "/v1/locations/map-select", other, selected)).statusCode).toBe(
      400,
    );
    const key = randomUUID();
    expect(
      (await request("POST", "/v1/locations/map-select", owner, selected, key)).statusCode,
    ).toBe(201);
    expect(
      (await request("POST", "/v1/locations/map-select", owner, selected, key)).json().data
        .replayed,
    ).toBe(true);
    const detail = lifeDetailResponseSchema.parse(
      (await request("GET", `/v1/life/${id}`, owner)).json().data,
    );
    expect(detail.verifiedDestination).toBeNull();
    expect(detail.selectedDestination).toEqual({
      ...selected.location,
      name: selected.name,
      address: selected.address,
      source: "USER_SELECTED_MAP",
    });
    expect((await request("GET", `/v1/life/${id}`, other)).statusCode).toBe(404);
    await request("PATCH", `/v1/life/${id}`, owner, { title: "另一座图书馆" });
    expect(
      (await request("GET", `/v1/life/${id}`, owner)).json().data.selectedDestination,
    ).toBeNull();
  });

  it("cancels only the target's current action when a record is resolved or archived, without deleting or learning dislike", async () => {
    const owner = await login(),
      other = await login();
    const activePlan = async (id: string, preSkipped = false) => {
      const session = randomUUID(),
        candidate = randomUUID(),
        recommendation = randomUUID();
      await pool.query(
        "INSERT INTO decision_sessions(id,user_id,status,scoring_version,question_policy_version,context_summary,expires_at) VALUES($1,$2,'RECOMMENDED','test','test','{}',now()+interval '1 day')",
        [session, owner.userId],
      );
      await pool.query(
        "INSERT INTO action_candidates(id,user_id,decision_session_id,target_life_object_id,action_type,action_payload,value_score,fit_score,friction_score,urgency_score,uncertainty_score,total_score,hard_filter_status,generator_version,scoring_version) VALUES($1,$2,$3,$4,'VIEW_CONTENT','{}',0.5,0.5,0.1,0.1,0.1,0.5,'PASS','test','test')",
        [candidate, owner.userId, session, id],
      );
      await pool.query(
        "INSERT INTO recommendations(id,user_id,decision_session_id,action_candidate_id,headline,execution_type,execution_payload,copy_version) VALUES($1,$2,$3,$4,'行动','VIEW_CONTENT','{}','test')",
        [recommendation, owner.userId, session, candidate],
      );
      // A skip before acceptance does not cancel a plan that has not started yet.
      if (preSkipped)
        await pool.query(
          "INSERT INTO feedback_events(id,user_id,recommendation_id,decision_session_id,event_type,client_event_id,created_at) VALUES($1,$2,$3,$4,'SKIP',$5,now()-interval '1 second')",
          [randomUUID(), owner.userId, recommendation, session, randomUUID()],
        );
      await pool.query(
        "INSERT INTO feedback_events(id,user_id,recommendation_id,decision_session_id,event_type,client_event_id) VALUES($1,$2,$3,$4,'ACCEPT',$5)",
        [randomUUID(), owner.userId, recommendation, session, randomUUID()],
      );
      await pool.query(
        "INSERT INTO clarification_requests(id,user_id,decision_session_id,scope_type,question_key,question_text,options,sequence,status) VALUES($1,$2,$3,'NOW','AVAILABLE_TIME','问题','[]',1,'PENDING')",
        [randomUUID(), owner.userId, session],
      );
      return { session, recommendation };
    };
    const untouched = await activePlan(await lifeObject(owner, "另一条进行中的记录"));
    for (const status of ["RESOLVED", "ARCHIVED"]) {
      const id = await lifeObject(owner, "状态改变的记录"),
        plan = await activePlan(id, true);
      expect((await request("PATCH", `/v1/life/${id}`, other, { status })).statusCode).toBe(404);
      const key = randomUUID();
      expect((await request("PATCH", `/v1/life/${id}`, owner, { status }, key)).statusCode).toBe(
        200,
      );
      expect(
        (await request("PATCH", `/v1/life/${id}`, owner, { status }, key)).json().data.replayed,
      ).toBe(true);
      expect(
        (await new ActionPlanService().progress(source.db, owner.userId, plan.recommendation))
          .state,
      ).toBe("CANCELLED");
      expect(
        (
          await pool.query(
            "SELECT status FROM clarification_requests WHERE decision_session_id=$1",
            [plan.session],
          )
        ).rows[0].status,
      ).toBe("CANCELLED");
      expect(
        (
          await pool.query(
            "SELECT status,deleted_at,object_version FROM life_objects WHERE id=$1",
            [id],
          )
        ).rows[0],
      ).toEqual({ status, deleted_at: null, object_version: 2 });
      expect(
        (
          await pool.query(
            "SELECT event_type,reason_code FROM feedback_events WHERE recommendation_id=$1 AND event_type='DISMISS'",
            [plan.recommendation],
          )
        ).rows,
      ).toEqual([
        {
          event_type: "DISMISS",
          reason_code: status === "RESOLVED" ? "OBJECT_RESOLVED" : "OBJECT_ARCHIVED",
        },
      ]);
    }
    expect(
      (await new ActionPlanService().progress(source.db, owner.userId, untouched.recommendation))
        .state,
    ).toBe("ACTIVE");
    expect(
      (
        await pool.query("SELECT count(*)::int AS n FROM preference_signals WHERE user_id=$1", [
          owner.userId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });
});
