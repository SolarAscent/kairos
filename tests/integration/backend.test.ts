import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@life/db";
import { migrate } from "../../packages/db/dist/migrations.js";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";
import { OutboxWorker } from "../../apps/worker/dist/worker.js";
import { MockModelProvider } from "@life/agent-core";
import { ApiClient, type ClientPlatform } from "../../apps/miniprogram/src/lib/client";
import {
  captureAcceptedSchema,
  captureResponseSchema,
  nowResponseSchema,
  authResponseSchema,
  feedbackAcceptedSchema,
  lifeListResponseSchema,
  captureListResponseSchema,
} from "@life/contracts";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("Set TEST_DATABASE_URL to a disposable local PostgreSQL database.");
const schema = "review_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(testUrl);
const scopedUrl = new URL(testUrl);
// Never fall back to pre-existing public tables when a test removes a relation.
scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(scopedUrl.toString());
const pool = source.pool;
const model = new MockModelProvider();
const worker = new OutboxWorker(pool, model);
let app: Awaited<ReturnType<typeof createApiApp>>;
let token = "",
  userId = "",
  otherToken = "",
  captureId = "",
  sessionId = "";

async function request(
  method: "GET" | "POST",
  url: string,
  body?: object,
  bearer = token,
  key = randomUUID(),
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${bearer}`, "x-idempotency-key": key },
    ...(body ? { payload: body } : {}),
  });
}
async function createCapture(text: string) {
  const response = await request("POST", "/v1/captures", { type: "TEXT", text });
  expect(response.statusCode).toBe(201);
  return response.json().data.captureId as string;
}
async function queueCapture(id: string, attempts = 0) {
  await pool.query(
    "INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,attempts) VALUES($1,'CAPTURE',$2,'CAPTURE_CREATED',$3,$4)",
    [randomUUID(), id, { captureId: id, userId }, attempts],
  );
}

beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
  await migrate(pool);
  process.env.DATABASE_URL = scopedUrl.toString();
  process.env.JWT_SECRET = "test-only-secret-at-least-32-bytes-long";
  process.env.WECHAT_MOCK_LOGIN = "true";
  process.env.NODE_ENV = "test";
  app = await createApiApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 30000);
afterAll(async () => {
  if (app) await app.close();
  await pool.end();
  await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
});

describe("PostgreSQL + HTTP + Worker", () => {
  it("runs native client login, lost-write replay, parsing, decision, feedback and logout", async () => {
    const storage = new Map<string, unknown>();
    let loseCaptureResponse = true;
    const platform: ClientPlatform = {
      send: async (input) => {
        const url = new URL(input.url);
        const response = await app.inject({
          method: input.method,
          url: url.pathname,
          headers: input.headers,
          ...(input.data ? { payload: input.data as object } : {}),
        });
        if (url.pathname === "/v1/captures" && input.method === "POST" && loseCaptureResponse) {
          loseCaptureResponse = false;
          throw new Error("Simulated response loss after server commit");
        }
        return { status: response.statusCode, body: response.json() };
      },
      login: async () => randomUUID(),
      uuid: async () => randomUUID(),
      read: (key) => storage.get(key),
      write: (key, value) => {
        storage.set(key, value);
      },
      remove: (key) => {
        storage.delete(key);
      },
      envVersion: () => "develop",
      sdkVersion: () => "3.7.1",
    };
    const client = new ApiClient(
      {
        environment: "develop",
        appId: "touristappid",
        apiBaseUrl: "http://local.test",
        loginMode: "mock",
        appVersion: "0.2.0",
      },
      platform,
    );
    await client.login();
    const key = randomUUID();
    const options = {
      method: "POST" as const,
      data: { type: "TEXT", text: "想读那本书", sourceChannel: "MINIPROGRAM" },
      key,
    };
    await expect(
      client.request("/v1/captures", captureAcceptedSchema, options),
    ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    const receipt = await client.request("/v1/captures", captureAcceptedSchema, options);
    expect(receipt.replayed).toBe(true);
    expect(await client.request("/v1/captures", captureListResponseSchema)).toHaveLength(1);
    await worker.processNext();
    const life = await client.request("/v1/life", lifeListResponseSchema);
    expect(life).toHaveLength(1);
    const decision = await client.request("/v1/now/sessions", nowResponseSchema, {
      method: "POST",
      key: randomUUID(),
      data: { context: { availableMinutes: 15 } },
    });
    expect(decision.status).toBe("RECOMMENDED");
    await client.request(
      `/v1/now/sessions/${decision.sessionId}/feedback`,
      feedbackAcceptedSchema,
      {
        method: "POST",
        key: randomUUID(),
        data: { clientEventId: randomUUID(), eventType: "ACCEPT" },
      },
    );
    await worker.processNext();
    const sessions = await pool.query(
      "SELECT id FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL",
      [client.userId],
    );
    await client.logout();
    expect(client.userId).toBeNull();
    expect(
      (await pool.query("SELECT revoked_at FROM auth_sessions WHERE id=$1", [sessions.rows[0].id]))
        .rows[0].revoked_at,
    ).not.toBeNull();
  });
  it("migrates twice and returns live readiness", async () => {
    expect(
      (await pool.query("SELECT name FROM schema_migrations ORDER BY name")).rows,
    ).toHaveLength(2);
    expect((await request("GET", "/health/ready")).statusCode).toBe(200);
  });
  it("serializes concurrent first login without duplicate accounts", async () => {
    const code = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request("POST", "/v1/auth/wechat/login", { code })),
    );
    results.forEach((r) => {
      expect(r.statusCode).toBe(201);
      authResponseSchema.parse(r.json().data);
    });
    expect(new Set(results.map((r) => r.json().data.userId)).size).toBe(1);
    token = results[0]!.json().data.accessToken;
    userId = results[0]!.json().data.userId;
    const other = await request("POST", "/v1/auth/wechat/login", { code: randomUUID() });
    otherToken = other.json().data.accessToken;
  });
  it("rotates refresh tokens once under concurrent refreshes", async () => {
    const login = (await request("POST", "/v1/auth/wechat/login", { code: randomUUID() })).json()
      .data;
    const results = await Promise.all([
      request("POST", "/v1/auth/refresh", { refreshToken: login.refreshToken }),
      request("POST", "/v1/auth/refresh", { refreshToken: login.refreshToken }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 401]);
    expect((await request("GET", "/v1/life", undefined, login.accessToken)).statusCode).toBe(401);
    const rotated = results.find((result) => result.statusCode === 201)!.json().data;
    expect((await request("GET", "/v1/life", undefined, rotated.accessToken)).statusCode).toBe(200);
    expect((await request("POST", "/v1/auth/logout", {}, rotated.accessToken)).statusCode).toBe(
      201,
    );
    expect((await request("GET", "/v1/life", undefined, rotated.accessToken)).statusCode).toBe(401);
  });
  it("returns QUIET without source records", async () => {
    const response = await request("POST", "/v1/now/sessions", {});
    expect(nowResponseSchema.parse(response.json().data).status).toBe("QUIET");
  });
  it("deduplicates concurrent captures and rejects key conflicts", async () => {
    const key = randomUUID(),
      body = { type: "TEXT", text: "想读那本书" };
    const responses = await Promise.all([
      request("POST", "/v1/captures", body, token, key),
      request("POST", "/v1/captures", body, token, key),
    ]);
    responses.forEach((r) => {
      expect(r.statusCode).toBe(201);
      captureAcceptedSchema.parse(r.json().data);
    });
    captureId = responses[0]!.json().data.captureId;
    expect(responses[1]!.json().data.captureId).toBe(captureId);
    const conflict = await request(
      "POST",
      "/v1/captures",
      { ...body, text: "different" },
      token,
      key,
    );
    expect(conflict.statusCode).toBe(409);
    expect(
      (await pool.query("SELECT * FROM outbox_events WHERE aggregate_id=$1", [captureId])).rowCount,
    ).toBe(1);
  });
  it("persists raw input before parsing and enforces user isolation", async () => {
    const response = await request("GET", `/v1/captures/${captureId}`);
    expect(captureResponseSchema.parse(response.json().data).status).toBe("UPLOADED");
    expect(
      (await request("GET", `/v1/captures/${captureId}`, undefined, otherToken)).statusCode,
    ).toBe(404);
    expect((await request("GET", "/v1/life", undefined, "invalid")).statusCode).toBe(401);
  });
  it("parses once even when another event targets the same Capture", async () => {
    await worker.processNext();
    await queueCapture(captureId);
    await new OutboxWorker(pool, model).processNext();
    const life = (await request("GET", "/v1/life")).json().data;
    expect(life).toHaveLength(1);
    expect((await request("GET", `/v1/life/${life[0].id}`, undefined, otherToken)).statusCode).toBe(
      404,
    );
    expect((await request("GET", `/v1/captures/${captureId}`)).json().data.status).toBe("READY");
  });
  it("generates one action within five available minutes", async () => {
    const response = await request("POST", "/v1/now/sessions", {
      context: { availableMinutes: 5 },
    });
    const data = nowResponseSchema.parse(response.json().data);
    expect(data.status).toBe("RECOMMENDED");
    expect(data.recommendation?.headline).toContain("5 分钟");
    sessionId = data.sessionId;
    expect(
      (await request("GET", `/v1/now/sessions/${sessionId}`, undefined, otherToken)).statusCode,
    ).toBe(404);
  });
  it("deduplicates feedback across request keys and detects changed content", async () => {
    const body = { clientEventId: randomUUID(), eventType: "ACCEPT", metadata: { a: 1, b: 2 } };
    const url = `/v1/now/sessions/${sessionId}/feedback`;
    const responses = await Promise.all([request("POST", url, body), request("POST", url, body)]);
    responses.forEach((r) => {
      expect(r.statusCode).toBe(201);
      feedbackAcceptedSchema.parse(r.json().data);
    });
    expect(responses[0]!.json().data.feedbackId).toBe(responses[1]!.json().data.feedbackId);
    expect((await request("POST", url, { ...body, metadata: { b: 2, a: 1 } })).statusCode).toBe(
      201,
    );
    expect((await request("POST", url, { ...body, reasonCode: "CHANGED" })).statusCode).toBe(409);
    expect(
      (await request("POST", `/v1/now/sessions/${randomUUID()}/feedback`, body)).statusCode,
    ).toBe(409);
    await worker.processNext();
    const signals = await pool.query("SELECT * FROM preference_signals WHERE user_id=$1", [userId]);
    expect(signals.rows).toHaveLength(1);
  });
  it("preserves input on model failure and exhausts retries without Mock fallback", async () => {
    const id = await createCapture("模型错误测试");
    const broken = new OutboxWorker(pool, {
      providerName: "broken",
      modelName: "test",
      parseCapture: async () => {
        throw new Error("private provider detail");
      },
    });
    await broken.processNext();
    expect(
      (await pool.query("SELECT status FROM outbox_events WHERE aggregate_id=$1", [id])).rows[0]
        .status,
    ).toBe("RETRY");
    expect(
      (await pool.query("SELECT provider,status FROM model_calls WHERE provider='broken'")).rows[0],
    ).toEqual({ provider: "broken", status: "FAILED" });
    await pool.query(
      "UPDATE outbox_events SET attempts=7,available_at=now() WHERE aggregate_id=$1",
      [id],
    );
    await broken.processNext();
    const response = await request("GET", `/v1/captures/${id}`);
    expect(response.json().data.status).toBe("FAILED");
    expect(response.json().data.text).toBe("模型错误测试");
  });
  it("does not resurrect a Capture deleted during model execution", async () => {
    const id = await createCapture("删除竞态测试");
    const deleting = new OutboxWorker(pool, {
      providerName: "test",
      modelName: "test",
      parseCapture: async (text: string) => {
        await pool.query("UPDATE captures SET status='DELETED',deleted_at=now() WHERE id=$1", [id]);
        return model.parseCapture(text);
      },
    });
    await deleting.processNext();
    expect((await request("GET", `/v1/captures/${id}`)).statusCode).toBe(404);
    expect(
      (await pool.query("SELECT * FROM life_object_sources WHERE source_id=$1", [id])).rowCount,
    ).toBe(0);
  });
  it("does not let a stale worker mark a reclaimed job or Capture as failed", async () => {
    const id = await createCapture("租约竞态测试");
    await pool.query("UPDATE outbox_events SET attempts=7 WHERE aggregate_id=$1", [id]);
    const stale = new OutboxWorker(pool, {
      providerName: "test",
      modelName: "test",
      parseCapture: async () => {
        await pool.query(
          "UPDATE outbox_events SET locked_by='new-owner',attempts=attempts+1 WHERE aggregate_id=$1",
          [id],
        );
        throw new Error("stale provider failure");
      },
    });
    await stale.processNext();
    expect(
      (await pool.query("SELECT status,locked_by FROM outbox_events WHERE aggregate_id=$1", [id]))
        .rows[0],
    ).toEqual({ status: "PROCESSING", locked_by: "new-owner" });
    expect((await pool.query("SELECT status FROM captures WHERE id=$1", [id])).rows[0].status).toBe(
      "PROCESSING",
    );
  });
  it("fails unknown event types instead of silently discarding them", async () => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'TEST',$1,'UNKNOWN','{}')",
      [id],
    );
    await worker.processNext();
    expect(
      (await pool.query("SELECT status FROM outbox_events WHERE id=$1", [id])).rows[0].status,
    ).toBe("RETRY");
  });
  it("rejects expired sessions and inactive accounts", async () => {
    await pool.query(
      "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [userId],
    );
    expect((await request("GET", "/v1/life")).statusCode).toBe(401);
    await pool.query("UPDATE users SET status='DELETING' WHERE id=$1", [userId]);
    const identity = (
      await pool.query("SELECT provider_subject FROM user_identities WHERE user_id=$1", [userId])
    ).rows[0].provider_subject;
    expect(
      (
        await request("POST", "/v1/auth/wechat/login", {
          code: identity.replace("local-demo:", ""),
        })
      ).statusCode,
    ).toBe(401);
  });
  it("returns 503 if the queue schema is missing", async () => {
    await pool.query("ALTER TABLE outbox_events RENAME TO outbox_events_missing");
    try {
      expect((await request("GET", "/health/ready")).statusCode).toBe(503);
    } finally {
      await pool.query("ALTER TABLE outbox_events_missing RENAME TO outbox_events");
    }
  });
  it("publishes request/response schemas as OpenAPI 3.1", async () => {
    const response = await request("GET", "/docs-json");
    const spec = response.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(
      spec.paths["/v1/captures"].post.requestBody.content["application/json"].schema.properties.text
        .maxLength,
    ).toBe(5000);
  });
});
