import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { createDatabase } from "@life/db";
import { migrate } from "../../packages/db/dist/migrations.js";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";
import { OutboxWorker } from "../../apps/worker/dist/worker.js";
import { DomesticModelProvider, domesticConfiguration, MockModelProvider } from "@life/agent-core";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("Set TEST_DATABASE_URL to a disposable local PostgreSQL database.");
const schema = "media_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(testUrl);
const url = new URL(testUrl);
url.searchParams.set("options", `-c search_path=${schema}`);
const database = createDatabase(url.toString());
let app: Awaited<ReturnType<typeof createApiApp>>, upstream: WebSocketServer;
let token = "",
  userId = "",
  base = "";
const requests: { url: string; authorization?: string }[] = [];
const originalEnv = { ...process.env };
const providerCalls: Record<string, unknown>[] = [];
const model = new DomesticModelProvider(
  domesticConfiguration({
    MODEL_PROVIDER: "qwen",
    DASHSCOPE_API_KEY: "fake-provider",
    QWEN_TEXT_MODEL: "text-fake",
    QWEN_VISION_MODEL: "vision-fake",
  }),
  async (_url, options) => {
    providerCalls.push(JSON.parse(options!.body as string));
    const result = await new MockModelProvider().parseCapture("想去公园");
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
      }),
    );
  },
);
function request(
  method: "GET" | "POST",
  path: string,
  payload?: object,
  key = randomUUID(),
  bearer = token,
) {
  return app.inject({
    method,
    url: path,
    headers: { authorization: `Bearer ${bearer}`, "x-idempotency-key": key },
    ...(payload ? { payload } : {}),
  });
}
beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(database.pool);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    JWT_SECRET: "media-test-only-secret-at-least-32-bytes",
    WECHAT_MOCK_LOGIN: "true",
    NODE_ENV: "test",
    MODEL_PROVIDER: "qwen",
    DASHSCOPE_API_KEY: "test-secret",
    DASHSCOPE_WORKSPACE_ID: "test-workspace",
  });
  upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  upstream.on("connection", (socket) =>
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "session.update") socket.send(JSON.stringify({ type: "session.updated" }));
      if (event.type === "input_audio_buffer.append") {
        expect(Buffer.from(event.audio, "base64")).toHaveLength(3200);
        socket.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.text",
            text: "想去",
            stash: "公园",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "sentence-a",
            transcript: "想去公园",
          }),
        );
      }
      if (event.type === "session.finish")
        socket.send(JSON.stringify({ type: "session.finished" }));
    }),
  );
  app = await createApiApp({
    voiceSocketFactory: (target, options) => {
      requests.push({ url: target, authorization: options.headers.Authorization });
      return new WebSocket(
        `ws://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        options,
      );
    },
  });
  await app.listen(0, "127.0.0.1");
  base = `ws://127.0.0.1:${(app.getHttpAdapter().getInstance().server.address() as { port: number }).port}`;
  const login = await request("POST", "/v1/auth/wechat/login", { code: randomUUID() });
  token = login.json().data.accessToken;
  userId = login.json().data.userId;
}, 30000);
afterAll(async () => {
  if (app) await app.close();
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await database.pool.end();
  await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe("multimodal HTTP, socket, PostgreSQL and worker integration", () => {
  it("authenticates tickets, streams PCM, saves edited voice with original provenance, processes via provider and safely replays", async () => {
    expect(
      (await request("POST", "/v1/media/voice/sessions", {}, randomUUID(), "bad")).statusCode,
    ).toBe(401);
    const leaseResponse = await request("POST", "/v1/media/voice/sessions", {});
    expect(leaseResponse.statusCode).toBe(201);
    const lease = leaseResponse.json().data;
    const client = new WebSocket(base + lease.socketPath + "?ticket=" + lease.ticket);
    const events: Record<string, unknown>[] = [];
    const completed = new Promise<Record<string, unknown>>((resolve, reject) => {
      client.on("error", reject);
      client.on("message", (data) => {
        const event = JSON.parse(data.toString());
        events.push(event);
        if (event.type === "ready") client.send(Buffer.alloc(3200));
        if (event.type === "final") client.send(JSON.stringify({ type: "finish" }));
        if (event.type === "error") reject(new Error(event.code));
        if (event.type === "done") resolve(event);
      });
    });
    expect(await completed).toMatchObject({
      type: "done",
      text: "想去公园",
      sessionId: lease.sessionId,
    });
    client.close();
    expect(events.map((event) => event.type)).toEqual(["ready", "partial", "final", "done"]);
    expect(requests[0]).toMatchObject({
      url: "wss://test-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime",
      authorization: "Bearer test-secret",
    });
    const input = {
      type: "VOICE",
      text: "周末想去公园",
      transcriptionSessionId: lease.sessionId,
      sourceChannel: "MINIPROGRAM",
    };
    const key = randomUUID();
    const capture = await request("POST", "/v1/captures", input, key);
    expect(capture.statusCode).toBe(201);
    const captureId = capture.json().data.captureId;
    const original = (
      await database.pool.query(
        "SELECT storage_key,mime_type FROM capture_assets WHERE capture_id=$1",
        [captureId],
      )
    ).rows[0];
    expect(original.mime_type).toBe("application/json");
    expect(
      JSON.parse(Buffer.from(original.storage_key.split(",")[1], "base64").toString()),
    ).toMatchObject({
      transcript: "想去公园",
      provider: "qwen",
      model: "qwen3-asr-flash-realtime",
      sessionId: lease.sessionId,
    });
    await new OutboxWorker(database.pool, model).processNext();
    expect((await request("GET", `/v1/captures/${captureId}`)).json().data).toMatchObject({
      type: "VOICE",
      status: "READY",
      text: "周末想去公园",
    });
    expect((await request("POST", "/v1/captures", input, key)).json().data.replayed).toBe(true);
    expect(
      (await request("POST", "/v1/captures", { ...input, transcriptionSessionId: randomUUID() }))
        .statusCode,
    ).toBe(400);
    expect(providerCalls[0]?.model).toBe("text-fake");
  });
  it("rejects bad, reused and revoked-session socket tickets before the upstream opens", async () => {
    async function denied(ticket: string) {
      const socket = new WebSocket(base + "/v1/media/voice/stream?ticket=" + ticket);
      socket.on("error", () => {});
      return new Promise<number | undefined>((resolve, reject) => {
        socket.on("unexpected-response", (_request, response) => {
          response.resume();
          resolve(response.statusCode);
          socket.terminate();
        });
        socket.on("open", () => {
          socket.close();
          reject(new Error("Unauthorized socket accepted"));
        });
      });
    }
    const before = requests.length;
    expect(await denied("bad")).toBe(401);
    const stranger = (await request("POST", "/v1/auth/wechat/login", { code: randomUUID() })).json()
      .data;
    const lease = (
      await request("POST", "/v1/media/voice/sessions", {}, randomUUID(), stranger.accessToken)
    ).json().data;
    await database.pool.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1", [
      stranger.userId,
    ]);
    expect(await denied(lease.ticket)).toBe(401);
    expect(await denied(lease.ticket)).toBe(401);
    expect(requests).toHaveLength(before);
  });
  it("validates image bytes, persists once, sends vision payload and audits correct model", async () => {
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/q1cAAAAASUVORK5CYII=";
    const input = {
      type: "IMAGE",
      text: "想去这里",
      image: { mimeType: "image/png", base64 },
      sourceChannel: "MINIPROGRAM",
    };
    const key = randomUUID();
    const response = await request("POST", "/v1/captures", input, key);
    expect(response.statusCode).toBe(201);
    const id = response.json().data.captureId;
    expect((await request("POST", "/v1/captures", input, key)).json().data.replayed).toBe(true);
    expect(
      (await database.pool.query("SELECT id FROM capture_assets WHERE capture_id=$1", [id]))
        .rowCount,
    ).toBe(1);
    const unauthorized = (
      await request("POST", "/v1/auth/wechat/login", { code: randomUUID() })
    ).json().data.accessToken;
    expect(
      (await request("GET", `/v1/captures/${id}`, undefined, randomUUID(), unauthorized))
        .statusCode,
    ).toBe(404);
    await new OutboxWorker(database.pool, model).processNext();
    const call = providerCalls.at(-1)!;
    expect(call.model).toBe("vision-fake");
    expect((call.messages as { content: unknown }[])[1]?.content).toMatchObject([
      { type: "text" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
    ]);
    expect(
      (await database.pool.query("SELECT model FROM model_calls WHERE model='vision-fake'"))
        .rowCount,
    ).toBe(1);
    expect(
      (
        await request("POST", "/v1/captures", {
          ...input,
          image: {
            mimeType: "image/png",
            base64: Buffer.from("arbitrary not image bytes").toString("base64"),
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request("POST", "/v1/captures", {
          type: "IMAGE",
          image: { url: "http://127.0.0.1/private" },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("reports no configured model, rejects ASR before upstream, retains failed raw text and image", async () => {
    process.env.DASHSCOPE_API_KEY = "";
    const before = requests.length;
    expect((await request("GET", "/v1/media/capabilities")).json().data).toMatchObject({
      text: false,
      image: false,
      voice: false,
      provider: "qwen",
    });
    expect((await request("POST", "/v1/media/voice/sessions", {})).statusCode).toBe(503);
    expect(requests).toHaveLength(before);
    const response = await request("POST", "/v1/captures", { type: "TEXT", text: "原始输入留存" });
    const id = response.json().data.captureId;
    const missing = new DomesticModelProvider(domesticConfiguration());
    await new OutboxWorker(database.pool, missing).processNext();
    expect((await request("GET", `/v1/captures/${id}`)).json().data).toMatchObject({
      status: "FAILED",
      text: "原始输入留存",
    });
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/q1cAAAAASUVORK5CYII=";
    const image = (
      await request("POST", "/v1/captures", {
        type: "IMAGE",
        image: { mimeType: "image/png", base64 },
      })
    ).json().data.captureId;
    await new OutboxWorker(database.pool, missing).processNext();
    expect((await request("GET", `/v1/captures/${image}`)).json().data.status).toBe("FAILED");
    expect(
      (
        await database.pool.query(
          "SELECT storage_key FROM capture_assets WHERE capture_id=$1 AND user_id=$2",
          [image, userId],
        )
      ).rows[0].storage_key,
    ).toContain(base64);
    process.env.DASHSCOPE_API_KEY = "test-secret";
  });
  it("makes an uncertain wish READY, returns a short owned title and separates queue/model timings", async () => {
    const raw = "最近我有点想找个空闲周末参观博物馆，不过现在还没有确定具体的日期。";
    const accepted = await request("POST", "/v1/captures", { type: "TEXT", text: raw });
    const id = accepted.json().data.captureId;
    expect((await request("GET", `/v1/captures/${id}`)).json().data).toMatchObject({
      status: "UPLOADED",
      title: null,
      summary: null,
      text: raw,
    });
    await database.pool.query(
      "UPDATE outbox_events SET created_at=now()-interval '2 seconds' WHERE aggregate_id=$1",
      [id],
    );
    const parsed = await new MockModelProvider().parseCapture(raw);
    parsed.objects[0]!.title = "周末博物馆游";
    parsed.objects[0]!.summary = "想在空闲周末参观博物馆，日期未定。";
    parsed.objects[0]!.uncertainFields = ["日期未定"];
    parsed.uncertainFields = ["日期未定"];
    await new OutboxWorker(database.pool, {
      providerName: "test-uncertain-wish",
      modelName: "test-model",
      parseCapture: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return parsed;
      },
    }).processNext();
    const detail = (await request("GET", `/v1/captures/${id}`)).json().data;
    expect(detail).toMatchObject({
      status: "READY",
      title: "周末博物馆游",
      summary: parsed.objects[0]!.summary,
      text: raw,
    });
    expect(detail.title).not.toBe(raw);
    expect(
      (await request("GET", "/v1/captures")).json().data.find((capture) => capture.id === id),
    ).toMatchObject({ title: detail.title, summary: detail.summary });
    const diagnostic = (
      await database.pool.query(
        `SELECT ar.result,ar.pipeline_version,mc.latency_ms,mc.prompt_version,mc.structured_output
      FROM agent_runs ar JOIN model_calls mc ON mc.agent_run_id=ar.id WHERE ar.entity_id=$1`,
        [id],
      )
    ).rows[0];
    expect(diagnostic.pipeline_version).toBe("capture-v0.4");
    expect(diagnostic.prompt_version).toBe("0.4");
    expect(diagnostic.result.queueWaitMs).toBeGreaterThanOrEqual(1900);
    expect(diagnostic.result.modelLatencyMs).toBeGreaterThanOrEqual(15);
    expect(diagnostic.latency_ms).toBe(diagnostic.result.modelLatencyMs);
    expect(diagnostic.structured_output.uncertainFields).toEqual(["日期未定"]);
    const other = (await request("POST", "/v1/auth/wechat/login", { code: randomUUID() })).json()
      .data;
    const foreignObject = randomUUID();
    await database.pool.query(
      "INSERT INTO life_objects(id,user_id,title,summary,status,kind,created_at) VALUES($1,$2,'别人的标题','不能泄露的摘要','ACTIVE','MEMORY','1970-01-01')",
      [foreignObject, other.userId],
    );
    await database.pool.query(
      "INSERT INTO life_object_sources(id,user_id,life_object_id,source_type,source_id,is_primary,confidence) VALUES($1,$2,$3,'CAPTURE',$4,true,1)",
      [randomUUID(), other.userId, foreignObject, id],
    );
    expect((await request("GET", `/v1/captures/${id}`)).json().data.title).toBe("周末博物馆游");
    await database.pool.query(
      "UPDATE life_objects SET deleted_at=now(),status='DELETED' WHERE user_id=$1",
      [userId],
    );
    expect((await request("GET", `/v1/captures/${id}`)).json().data).toMatchObject({
      title: null,
      summary: null,
      text: raw,
    });
  });
  it("processes two independent captures concurrently without crossing their model results", async () => {
    const ids: string[] = [];
    for (const text of ["并行读书计划", "并行散步计划"])
      ids.push(
        (await request("POST", "/v1/captures", { type: "TEXT", text })).json().data.captureId,
      );
    let active = 0,
      peak = 0;
    let markBothStarted!: () => void, release!: () => void;
    const bothStarted = new Promise<void>((resolve) => (markBothStarted = resolve));
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const worker = new OutboxWorker(database.pool, {
      providerName: "test-parallel",
      modelName: "test-model",
      parseCapture: async (input) => {
        active++;
        peak = Math.max(peak, active);
        if (active === 2) markBothStarted();
        try {
          await barrier;
          return new MockModelProvider().parseCapture(
            typeof input === "string" ? input : input.text,
          );
        } finally {
          active--;
        }
      },
    });
    let timeout!: ReturnType<typeof setTimeout>;
    const boundedStart = Promise.race([
      bothStarted,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Both model calls must reach the concurrency barrier")),
          5000,
        );
      }),
    ]);
    const runners = [worker.processNext(), worker.processNext()];
    const settled = Promise.allSettled(runners);
    try {
      await boundedStart;
      expect(active).toBe(2);
    } finally {
      clearTimeout(timeout);
      release();
      await settled;
    }
    expect(await Promise.all(runners)).toEqual([true, true]);
    expect(peak).toBe(2);
    expect((await request("GET", `/v1/captures/${ids[0]}`)).json().data.title).toBe("并行读书计划");
    expect((await request("GET", `/v1/captures/${ids[1]}`)).json().data.title).toBe("并行散步计划");
    const audit = await database.pool.query(
      `SELECT ar.entity_id,mc.structured_output FROM agent_runs ar
      JOIN model_calls mc ON mc.agent_run_id=ar.id WHERE ar.entity_id=ANY($1::uuid[])`,
      [ids],
    );
    expect(audit.rowCount).toBe(2);
    for (const row of audit.rows)
      expect(row.structured_output.objects[0].title).toBe(
        row.entity_id === ids[0] ? "并行读书计划" : "并行散步计划",
      );
    const queue = await database.pool.query(
      "SELECT status,attempts,locked_by FROM outbox_events WHERE aggregate_id=ANY($1::uuid[])",
      [ids],
    );
    expect(queue.rows).toEqual(
      expect.arrayContaining([
        { status: "DONE", attempts: 1, locked_by: null },
        { status: "DONE", attempts: 1, locked_by: null },
      ]),
    );
  }, 10000);
  it.each([false, true])(
    "defers duplicate model calls and recovers a stale PROCESSING capture=%s",
    async (stale) => {
      const id = (
        await request("POST", "/v1/captures", { type: "TEXT", text: "重复捕获恢复测试" })
      ).json().data.captureId;
      if (stale) {
        await database.pool.query("UPDATE captures SET status='PROCESSING' WHERE id=$1", [id]);
        await database.pool.query(
          "UPDATE outbox_events SET status='PROCESSING',locked_at=now()-interval '3 minutes',locked_by='dead-worker',attempts=1 WHERE aggregate_id=$1",
          [id],
        );
      }
      await database.pool.query(
        "INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'CAPTURE',$2,'CAPTURE_CREATED',$3)",
        [randomUUID(), id, { captureId: id, userId }],
      );
      let release!: () => void,
        entered!: () => void,
        calls = 0;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const worker = new OutboxWorker(database.pool, {
        providerName: "test-duplicate",
        modelName: "test-model",
        parseCapture: async () => {
          calls++;
          entered();
          await gate;
          return new MockModelProvider().parseCapture("恢复后的随手记");
        },
      });
      const runners = [worker.processNext(), worker.processNext()];
      try {
        await started;
        await Promise.race(runners);
        const leases = await database.pool.query(
          "SELECT count(*)::int AS count FROM outbox_events WHERE aggregate_id=$1 AND status='PROCESSING' AND locked_at>now()-interval '2 minutes'",
          [id],
        );
        expect(leases.rows[0].count).toBe(1);
        expect(calls).toBe(1);
      } finally {
        release();
        await Promise.all(runners);
      }
      await database.pool.query(
        "UPDATE outbox_events SET available_at=now() WHERE aggregate_id=$1 AND status='RETRY'",
        [id],
      );
      await worker.processNext();
      expect(calls).toBe(1);
      expect((await request("GET", `/v1/captures/${id}`)).json().data).toMatchObject({
        status: "READY",
        title: "恢复后的随手记",
      });
      expect(
        (
          await database.pool.query(
            "SELECT id FROM life_object_sources WHERE user_id=$1 AND source_id=$2",
            [userId, id],
          )
        ).rowCount,
      ).toBe(1);
      const events = await database.pool.query(
        "SELECT status,locked_by FROM outbox_events WHERE aggregate_id=$1",
        [id],
      );
      expect(events.rowCount).toBe(2);
      expect(events.rows.every((row) => row.status === "DONE" && row.locked_by === null)).toBe(
        true,
      );
    },
  );
  it("persists stated travel/event facts and projects costs and dates using trusted capture context", async () => {
    const raw = "我在广东，想以后去新疆旅行；明天下午3点参加活动，4点结束，需要20分钟，门票50元。";
    const id = (await request("POST", "/v1/captures", { type: "TEXT", text: raw })).json().data
      .captureId;
    await database.pool.query("UPDATE captures SET created_at='2026-10-05T01:00:00Z' WHERE id=$1", [
      id,
    ]);
    const parsed = await new MockModelProvider().parseCapture(raw);
    const first = parsed.objects[0]!;
    first.title = "新疆旅行愿望";
    first.kind = "PLACE";
    first.facets = [
      {
        type: "PLACE",
        key: "travel",
        source: "EXTRACTED",
        confidence: 0.9,
        data: {
          intent: "VISIT",
          description: null,
          verification: "UNVERIFIED",
          facts: {
            origin: "USER_STATED",
            evidence: "我在广东，想以后去新疆旅行",
            activityKind: "TRAVEL",
            horizon: "LONG_TERM",
            place: { province: "新疆" },
            originContext: { province: "广东" },
          },
        },
      },
    ];
    parsed.objects.push({
      ...first,
      title: "明日活动安排",
      kind: "EVENT",
      facets: [
        {
          type: "EVENT",
          key: "event",
          source: "EXTRACTED",
          confidence: 0.9,
          data: {
            intent: "ATTEND",
            description: null,
            verification: "UNVERIFIED",
            facts: {
              origin: "USER_STATED",
              evidence: "明天下午3点参加活动，4点结束，需要20分钟，门票50元",
              activityKind: "LOCAL_OUTING",
              horizon: "SCHEDULED",
              time: { eventStart: "明天下午3点", eventEnd: "明天下午4点" },
              duration: { minSeconds: 1200, maxSeconds: 1200, role: "REQUIRED" },
              money: { minMinor: 5000, maxMinor: 5000, currency: "CNY", role: "COST" },
            },
          },
        },
      ],
    });
    let supplied;
    await new OutboxWorker(database.pool, {
      providerName: "test-facts",
      modelName: "test-model",
      parseCapture: async (input) => {
        supplied = input;
        return parsed;
      },
    }).processNext();
    expect(supplied).toMatchObject({
      text: raw,
      referenceTime: "2026-10-05T01:00:00.000Z",
      timezone: "Asia/Shanghai",
    });
    const rows = await database.pool.query(
      `SELECT lo.title,p.*,f.data,f.origin_type,f.schema_version FROM life_objects lo
      JOIN life_object_projection p ON p.life_object_id=lo.id JOIN life_object_facets f ON f.life_object_id=lo.id
      JOIN life_object_sources src ON src.life_object_id=lo.id WHERE src.source_id=$1 ORDER BY lo.title`,
      [id],
    );
    const event = rows.rows.find((row) => row.title === "明日活动安排");
    expect(event).toMatchObject({
      cost_min_minor: 5000,
      cost_max_minor: 5000,
      duration_min_seconds: 1200,
      currency: "CNY",
      origin_type: "USER_STATED",
      schema_version: 3,
    });
    expect(event.next_at.toISOString()).toBe("2026-10-06T07:00:00.000Z");
    expect(event.expires_at.toISOString()).toBe("2026-10-06T08:00:00.000Z");
    expect(event.data.normalization).toMatchObject({
      rawTime: { eventStart: "明天下午3点", eventEnd: "明天下午4点" },
      referenceTime: "2026-10-05T01:00:00.000Z",
      timezone: "Asia/Shanghai",
    });
    const travel = rows.rows.find((row) => row.title === "新疆旅行愿望");
    expect(travel).toMatchObject({
      duration_min_seconds: null,
      cost_min_minor: null,
      latitude: null,
      longitude: null,
      next_at: null,
    });
    expect(travel.data.facts).toMatchObject({
      activityKind: "TRAVEL",
      horizon: "LONG_TERM",
      place: { province: "新疆" },
      originContext: { province: "广东" },
    });
    expect((await request("GET", `/v1/captures/${id}`)).json().data.status).toBe("READY");
  });
});

async function oldTravelObject() {
  const captureId = (
    await request("POST", "/v1/captures", {
      type: "TEXT",
      text: "我在广东，想将来去新疆旅行，旅行预算3000元",
    })
  ).json().data.captureId;
  await database.pool.query("UPDATE captures SET created_at='2026-10-05T01:00:00Z' WHERE id=$1", [
    captureId,
  ]);
  await new OutboxWorker(database.pool, new MockModelProvider()).processNext();
  const row = (
    await database.pool.query(
      "SELECT lo.id,f.id AS facet_id,f.facet_type,f.facet_key FROM life_objects lo JOIN life_object_facets f ON f.life_object_id=lo.id JOIN life_object_sources s ON s.life_object_id=lo.id WHERE s.source_id=$1",
      [captureId],
    )
  ).rows[0];
  await database.pool.query(
    "UPDATE life_objects SET title='新疆旅行愿望',summary='以后去旅行',importance_score=0.77 WHERE id=$1",
    [row.id],
  );
  await database.pool.query(
    "UPDATE life_object_facets SET schema_version=2,data=jsonb_set(data,'{description}',to_jsonb('我在广东，想将来去新疆旅行，旅行预算3000元'::text)) WHERE id=$1",
    [row.facet_id],
  );
  return { ...row, captureId };
}
async function queueRebuild(id: string) {
  const eventId = randomUUID();
  await database.pool.query(
    "INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'LIFE_OBJECT',$2,'LIFE_FACTS_REBUILD',$3::jsonb)",
    [eventId, id, JSON.stringify({ lifeObjectId: id, userId, traceId: randomUUID() })],
  );
  return eventId;
}
async function travelEnrichment(target: Awaited<ReturnType<typeof oldTravelObject>>) {
  const parsed = await new MockModelProvider().parseCapture("新疆旅行愿望");
  parsed.objects[0]!.title = "新疆旅行愿望";
  parsed.objects[0]!.kind = target.facet_type;
  parsed.objects[0]!.facets = [
    {
      type: target.facet_type,
      key: target.facet_key,
      confidence: 0.9,
      source: "EXTRACTED",
      data: {
        intent: "VISIT",
        description: "模型改写描述不应覆盖",
        verification: "UNVERIFIED",
        facts: {
          origin: "USER_STATED",
          evidence: "我在广东，想将来去新疆旅行，旅行预算3000元",
          activityKind: "TRAVEL",
          horizon: "LONG_TERM",
          place: { province: "新疆" },
          originContext: { province: "广东" },
          money: { maxMinor: 300000, currency: "CNY", role: "BUDGET", scope: "OBJECT" },
        },
      },
    },
  ];
  return parsed;
}
describe("additive old-object fact enrichment", () => {
  it("preserves identity, original sources and user descriptions while rebuilding facts exactly once", async () => {
    const target = await oldTravelObject(),
      parsed = await travelEnrichment(target);
    let input: unknown;
    const worker = new OutboxWorker(database.pool, {
      providerName: "test-enrich",
      modelName: "fake",
      parseCapture: async (value) => {
        input = value;
        return parsed;
      },
    });
    const eventId = await queueRebuild(target.id);
    expect(await worker.processNext()).toBe(true);
    expect(input).toMatchObject({
      factsOnly: true,
      referenceTime: "2026-10-05T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      originalCaptureText: "我在广东，想将来去新疆旅行，旅行预算3000元",
    });
    expect(JSON.parse((input as { text: string }).text)).toMatchObject({
      title: "新疆旅行愿望",
      descriptions: ["我在广东，想将来去新疆旅行，旅行预算3000元"],
    });
    const row = (
      await database.pool.query(
        "SELECT lo.title,lo.importance_score,f.data,f.schema_version,p.cost_max_minor,p.latitude,p.duration_min_seconds,p.projection_version FROM life_objects lo JOIN life_object_facets f ON f.life_object_id=lo.id JOIN life_object_projection p ON p.life_object_id=lo.id WHERE lo.id=$1",
        [target.id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      title: "新疆旅行愿望",
      importance_score: 0.77,
      schema_version: 3,
      cost_max_minor: null,
      duration_min_seconds: null,
      latitude: null,
      projection_version: "projection-v0.4",
      data: {
        description: "我在广东，想将来去新疆旅行，旅行预算3000元",
        facts: {
          activityKind: "TRAVEL",
          money: { role: "BUDGET", scope: "OBJECT", maxMinor: 300000 },
        },
      },
    });
    expect(
      (await database.pool.query("SELECT status FROM outbox_events WHERE id=$1", [eventId])).rows[0]
        .status,
    ).toBe("DONE");
    const beforeVersion = (
      await database.pool.query("SELECT object_version FROM life_objects WHERE id=$1", [target.id])
    ).rows[0].object_version;
    await queueRebuild(target.id);
    await worker.processNext();
    expect(
      (
        await database.pool.query("SELECT object_version FROM life_objects WHERE id=$1", [
          target.id,
        ])
      ).rows[0].object_version,
    ).toBe(beforeVersion);
    expect(
      (
        await database.pool.query("SELECT id FROM life_object_facets WHERE life_object_id=$1", [
          target.id,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await database.pool.query(
          "SELECT source_id FROM life_object_sources WHERE life_object_id=$1",
          [target.id],
        )
      ).rows,
    ).toEqual([{ source_id: target.captureId }]);
  });
  it("restores omitted details only from a uniquely owned original capture and omits shared source text", async () => {
    const target = await oldTravelObject(),
      parsed = await travelEnrichment(target);
    await database.pool.query(
      "UPDATE life_object_facets SET data=jsonb_set(data,'{description}','null'::jsonb) WHERE id=$1",
      [target.facet_id],
    );
    let supplied: { originalCaptureText?: string } | undefined;
    const worker = new OutboxWorker(database.pool, {
      providerName: "test-own-source",
      modelName: "fake",
      parseCapture: async (input) => {
        supplied = typeof input === "string" ? undefined : input;
        return parsed;
      },
    });
    await queueRebuild(target.id);
    await worker.processNext();
    expect(supplied?.originalCaptureText).toBe("我在广东，想将来去新疆旅行，旅行预算3000元");
    expect(
      (
        await database.pool.query("SELECT data FROM life_object_facets WHERE id=$1", [
          target.facet_id,
        ])
      ).rows[0].data.facts.originContext.province,
    ).toBe("广东");
    const other = await oldTravelObject();
    await database.pool.query(
      "INSERT INTO life_object_sources(id,user_id,life_object_id,source_type,source_id,is_primary,confidence,evidence) VALUES($1,$2,$3,'CAPTURE',$4,false,1,'{}'::jsonb)",
      [randomUUID(), userId, other.id, target.captureId],
    );
    await queueRebuild(target.id);
    await worker.processNext();
    expect(supplied?.originalCaptureText).toBeUndefined();
    expect(
      (
        await database.pool.query("SELECT id FROM life_object_sources WHERE source_id=$1", [
          target.captureId,
        ])
      ).rowCount,
    ).toBe(2);
  });
  it("skips enrichment when a concurrent user edit changes object revision", async () => {
    const target = await oldTravelObject(),
      parsed = await travelEnrichment(target);
    await queueRebuild(target.id);
    await new OutboxWorker(database.pool, {
      providerName: "test-race",
      modelName: "fake",
      parseCapture: async () => {
        await database.pool.query(
          "UPDATE life_objects SET title='我的旅行规划',object_version=object_version+1 WHERE id=$1",
          [target.id],
        );
        return parsed;
      },
    }).processNext();
    expect(
      (await database.pool.query("SELECT title FROM life_objects WHERE id=$1", [target.id])).rows[0]
        .title,
    ).toBe("我的旅行规划");
    expect(
      (
        await database.pool.query("SELECT data FROM life_object_facets WHERE id=$1", [
          target.facet_id,
        ])
      ).rows[0].data.facts,
    ).toBeUndefined();
    expect(
      (
        await database.pool.query(
          "SELECT error_code FROM agent_runs WHERE purpose='LIFE_FACTS_REBUILD' AND entity_id=$1",
          [target.id],
        )
      ).rows[0].error_code,
    ).toBe("OBJECT_CHANGED");
  });
  it("refuses unclear multi-object binding and preserves already stated values", async () => {
    const target = await oldTravelObject(),
      parsed = await travelEnrichment(target);
    parsed.objects.push({ ...parsed.objects[0]!, title: "另一个愿望" });
    await queueRebuild(target.id);
    const worker = new OutboxWorker(database.pool, {
      providerName: "test-bind",
      modelName: "fake",
      parseCapture: async () => parsed,
    });
    await worker.processNext();
    expect(
      (
        await database.pool.query("SELECT data FROM life_object_facets WHERE id=$1", [
          target.facet_id,
        ])
      ).rows[0].data.facts,
    ).toBeUndefined();
    expect(
      (
        await database.pool.query(
          "SELECT error_code FROM agent_runs WHERE entity_id=$1 AND purpose='LIFE_FACTS_REBUILD'",
          [target.id],
        )
      ).rows[0].error_code,
    ).toBe("FACTS_BINDING_UNCLEAR");
    parsed.objects.pop();
    const stated = {
      origin: "USER_STATED",
      evidence: "我的旅行预算1000元",
      money: { maxMinor: 100000, currency: "CNY", role: "BUDGET", scope: "OBJECT" },
    };
    await database.pool.query(
      "UPDATE life_object_facets SET data=jsonb_set(data,'{facts}',$1::jsonb),schema_version=3 WHERE id=$2",
      [JSON.stringify(stated), target.facet_id],
    );
    await queueRebuild(target.id);
    await worker.processNext();
    expect(
      (
        await database.pool.query("SELECT data FROM life_object_facets WHERE id=$1", [
          target.facet_id,
        ])
      ).rows[0].data.facts,
    ).toEqual(stated);
  });
});

describe("trusted original capture grounding", () => {
  it("does not project fabricated USER_STATED travel duration even when the model marks it confident", async () => {
    const id = (
      await request("POST", "/v1/captures", { type: "TEXT", text: "我在广东，想将来去新疆旅行" })
    ).json().data.captureId;
    const parsed = await new MockModelProvider().parseCapture("新疆旅行愿望");
    parsed.objects[0]!.facets[0]!.data.facts = {
      origin: "USER_STATED",
      evidence: "去新疆只需要20分钟",
      activityKind: "TRAVEL",
      duration: { minSeconds: 1200, role: "REQUIRED" },
    };
    await new OutboxWorker(database.pool, {
      providerName: "test-grounding",
      modelName: "fake",
      parseCapture: async () => parsed,
    }).processNext();
    const row = (
      await database.pool.query(
        "SELECT p.duration_min_seconds,f.data,f.origin_type FROM life_object_sources s JOIN life_object_projection p ON p.life_object_id=s.life_object_id JOIN life_object_facets f ON f.life_object_id=s.life_object_id WHERE s.source_id=$1",
        [id],
      )
    ).rows[0];
    expect(row.duration_min_seconds).toBeNull();
    expect(row.data.facts.origin).toBe("INFERRED");
    expect(row.data.normalization.warnings).toContain("EVIDENCE_NOT_IN_SOURCE");
    expect((await request("GET", `/v1/captures/${id}`)).json().data.status).toBe("READY");
  });
});

describe("deterministic current-context recovery", () => {
  it("preserves the model's two objects, fills omitted current resources and rejects trip-budget/current-origin mistakes", async () => {
    const login = (await request("POST", "/v1/auth/wechat/login", { code: randomUUID() })).json()
      .data;
    const currentToken = login.accessToken,
      currentUserId = login.userId;
    const text = "我现在在广东，只有20分钟，想去新疆旅行，旅行预算3000元，还想以后读书。";
    const captureId = (
      await request("POST", "/v1/captures", { type: "TEXT", text }, randomUUID(), currentToken)
    ).json().data.captureId;
    const parsed = await new MockModelProvider().parseCapture("新疆旅行愿望");
    const trip = parsed.objects[0]!;
    trip.kind = "PLACE";
    trip.facets = [
      {
        type: "PLACE",
        key: "trip",
        source: "EXTRACTED",
        confidence: 0.9,
        data: {
          intent: "VISIT",
          description: null,
          verification: "UNVERIFIED",
          facts: {
            origin: "USER_STATED",
            evidence: "旅行预算3000元",
            activityKind: "TRAVEL",
            horizon: "LONG_TERM",
            place: { province: "新疆" },
            originContext: { province: "新疆" },
            money: {
              minMinor: 300000,
              maxMinor: 300000,
              currency: "CNY",
              role: "BUDGET",
              scope: "CURRENT",
            },
          },
        },
      },
    ];
    parsed.objects.push({
      ...trip,
      title: "阅读愿望",
      kind: "MEDIA",
      facets: [
        {
          type: "MEDIA",
          key: "reading",
          source: "EXTRACTED",
          confidence: 0.9,
          data: {
            intent: "READ",
            description: null,
            verification: "UNVERIFIED",
            facts: {
              origin: "USER_STATED",
              evidence: "还想以后读书",
              activityKind: "HOME",
              horizon: "LONG_TERM",
            },
          },
        },
      ],
    });
    await new OutboxWorker(database.pool, {
      providerName: "test-current-omission",
      modelName: "fake",
      parseCapture: async () => parsed,
    }).processNext();
    const objects = await database.pool.query(
      "SELECT life_object_id FROM life_object_sources WHERE user_id=$1 AND source_id=$2",
      [currentUserId, captureId],
    );
    expect(objects.rowCount).toBe(2);
    const rows = (
      await database.pool.query(
        "SELECT f.facet_key,f.data,p.duration_min_seconds,p.cost_min_minor FROM life_object_facets f JOIN life_object_projection p ON p.life_object_id=f.life_object_id WHERE f.user_id=$1 AND f.origin_id=$2",
        [currentUserId, captureId],
      )
    ).rows;
    expect(rows.filter((row) => row.facet_key === "source_current_duration")).toHaveLength(2);
    expect(rows.filter((row) => row.facet_key === "source_current_location")).toHaveLength(2);
    expect(
      rows
        .filter((row) => row.facet_key === "source_current_duration")
        .every(
          (row) =>
            row.data.facts.duration.scope === "CURRENT" &&
            row.data.facts.duration.maxSeconds === 1200,
        ),
    ).toBe(true);
    expect(rows.find((row) => row.facet_key === "trip").data.facts.money.scope).toBe("OBJECT");
    expect(rows.find((row) => row.facet_key === "trip").data.facts.originContext).toBeUndefined();
    expect(
      rows.every((row) => row.duration_min_seconds === null && row.cost_min_minor === null),
    ).toBe(true);
    const decision = await request(
      "POST",
      "/v1/now/sessions",
      { context: {} },
      randomUUID(),
      currentToken,
    );
    expect([200, 201]).toContain(decision.statusCode);
    const snapshot = (
      await database.pool.query(
        "SELECT context FROM context_snapshots WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
        [currentUserId],
      )
    ).rows[0].context;
    expect(snapshot.availableMinutes).toBe(20);
    expect(snapshot.location.region).toBe("广东");
    expect(snapshot.budgetMinor).toBeUndefined();
  });
});
