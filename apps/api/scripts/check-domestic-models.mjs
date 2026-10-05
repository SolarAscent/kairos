// Live acceptance in a disposable PostgreSQL schema. Never use production data.
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { createDatabase } from "@life/db";
import { createModelGateway, domesticConfiguration, mediaCapabilities } from "@life/agent-core";

const root = resolve(import.meta.dirname, "../../..");
loadEnv({ path: resolve(root, ".env"), quiet: true });
const value = (flag) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
};
const config = domesticConfiguration();
if (!["qwen", "glm"].includes(config.provider) || !config.apiKey?.trim()) {
  console.log(
    JSON.stringify({
      status: "blocked",
      code: "DOMESTIC_PROVIDER_CREDENTIALS_REQUIRED",
      liveModelVerified: false,
    }),
  );
  process.exit(2);
}
if (!process.env.TEST_DATABASE_URL) {
  console.log(
    JSON.stringify({
      status: "blocked",
      code: "DISPOSABLE_TEST_DATABASE_REQUIRED",
      liveModelVerified: false,
    }),
  );
  process.exit(2);
}
const pcmPath = value("--pcm");
if (pcmPath && !mediaCapabilities().voice) {
  console.log(
    JSON.stringify({
      status: "blocked",
      code: "QWEN_ASR_WORKSPACE_REQUIRED",
      liveModelVerified: false,
    }),
  );
  process.exit(2);
}
const schema = "live_models_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(process.env.TEST_DATABASE_URL);
const scopedUrl = new URL(process.env.TEST_DATABASE_URL);
scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = scopedUrl.toString();
process.env.NODE_ENV = "test";
process.env.WECHAT_MOCK_LOGIN = "true";
process.env.JWT_SECRET = randomBytes(48).toString("hex");
const source = createDatabase(scopedUrl.toString());
let app;
let created = false;
const receipt = {
  provider: config.provider,
  textModel: config.textModel,
  visionModel: config.visionModel,
  asrModel: config.asrModel,
  checkedAt: new Date().toISOString(),
  databaseScope: "disposable schema",
  checks: [],
};
try {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  const { migrate } = await import("../../../packages/db/dist/migrations.js");
  await migrate(source.pool);
  const { createApiApp } = await import("../dist/bootstrap.js");
  const { OutboxWorker } = await import("../../worker/dist/worker.js");
  app = await createApiApp();
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl();
  const worker = new OutboxWorker(source.pool, createModelGateway(process.env));
  let token;
  async function request(path, body) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-idempotency-key": randomUUID(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const envelope = await response.json();
    if (!response.ok) throw new Error(envelope.error?.code || "BACKEND_REQUEST_FAILED");
    return envelope.data;
  }
  const login = await request("/v1/auth/wechat/login", {
    code: "domestic-model-smoke:" + randomUUID(),
  });
  token = login.accessToken;
  const capabilities = await request("/v1/media/capabilities");
  if (capabilities.provider !== config.provider || !capabilities.text)
    throw new Error("BACKEND_PROVIDER_MISMATCH");
  async function capture(body) {
    const startedAt = performance.now();
    const accepted = await request("/v1/captures", { ...body, sourceChannel: "API" });
    const acceptedAt = performance.now();
    await worker.processNext();
    const result = await request("/v1/captures/" + accepted.captureId);
    if (!["READY", "NEEDS_REVIEW"].includes(result.status))
      throw new Error("LIVE_CAPTURE_PARSE_FAILED");
    const audit = await source.pool.query(
      "SELECT calls.provider,calls.model,calls.latency_ms,runs.result FROM model_calls calls JOIN agent_runs runs ON runs.id=calls.agent_run_id WHERE runs.entity_id=$1 ORDER BY calls.created_at DESC LIMIT 1",
      [accepted.captureId],
    );
    receipt.checks.push({
      modality: body.type,
      captureStatus: result.status,
      title: result.title ?? null,
      summary: result.summary ?? null,
      timings: {
        acceptedMs: Math.round(acceptedAt - startedAt),
        understoodMs: Math.round(performance.now() - acceptedAt),
        modelMs: audit.rows[0]?.latency_ms ?? null,
        queueWaitMs: audit.rows[0]?.result?.queueWaitMs ?? null,
      },
      audit: audit.rows[0],
    });
    if (!result.title?.trim() || result.title === body.text)
      throw new Error("LIVE_SUMMARIZED_TITLE_MISSING");
    if (body.type === "TEXT" && result.status !== "READY")
      throw new Error("LIVE_LOW_RISK_CAPTURE_NOT_READY");
    const life = await request("/v1/life");
    if (!life.some((item) => item.title === result.title && item.summary === result.summary))
      throw new Error("LIVE_LIFE_SUMMARY_NOT_UPDATED");
  }
  await capture({ type: "TEXT", text: "我想找个空闲周末去博物馆，具体日期还没定。" });
  const imagePath = value("--image");
  if (imagePath) {
    const bytes = await readFile(resolve(imagePath));
    const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : "image/jpeg";
    await capture({
      type: "IMAGE",
      text: "这是联调用的合成图片，请保存其中的生活事项。",
      image: { mimeType, base64: bytes.toString("base64") },
    });
  }
  if (pcmPath) {
    const pcm = await readFile(resolve(pcmPath));
    if (!pcm.length || pcm.length % 2 || pcm.length > 16000 * 2 * 60)
      throw new Error("PCM16_16KHZ_MONO_REQUIRED");
    const session = await request("/v1/media/voice/sessions", {});
    const wsUrl =
      base.replace(/^http/, "ws") +
      session.socketPath +
      "?ticket=" +
      encodeURIComponent(session.ticket);
    let partials = 0;
    const transcript = await new Promise((resolveTranscript, reject) => {
      const socket = new WebSocket(wsUrl);
      let complete = false;
      let started = false;
      let offset = 0;
      let timer;
      const deadline = setTimeout(() => fail("LIVE_ASR_TIMEOUT"), 85000);
      function fail(code) {
        clearTimeout(deadline);
        clearInterval(timer);
        socket.close();
        if (!complete) {
          complete = true;
          reject(new Error(code));
        }
      }
      socket.on("error", () => fail("LIVE_ASR_CONNECTION_FAILED"));
      socket.on("close", () => {
        if (!complete) fail("LIVE_ASR_CLOSED_BEFORE_DONE");
      });
      socket.on("message", (data) => {
        let event;
        try {
          event = JSON.parse(data.toString());
        } catch {
          fail("LIVE_ASR_PROTOCOL_INVALID");
          return;
        }
        if (event.type === "ready" && !started) {
          started = true;
          timer = setInterval(() => {
            if (offset >= pcm.length) {
              clearInterval(timer);
              socket.send(JSON.stringify({ type: "finish" }));
              return;
            }
            const frame = pcm.subarray(offset, Math.min(offset + 4096, pcm.length));
            offset += frame.length;
            socket.send(frame);
          }, 128);
        } else if (event.type === "partial") partials++;
        else if (event.type === "error") fail(event.code);
        else if (event.type === "done") {
          complete = true;
          clearTimeout(deadline);
          clearInterval(timer);
          socket.close();
          resolveTranscript(event.text);
        }
      });
    });
    if (!partials) throw new Error("LIVE_ASR_NO_STREAMING_PARTIALS");
    await capture({ type: "VOICE", text: transcript, transcriptionSessionId: session.sessionId });
    receipt.checks.push({
      modality: "ASR_STREAM",
      partialEvents: partials,
      transcriptCharacters: transcript.length,
    });
  }
  receipt.status = "passed";
  receipt.liveModelVerified = true;
} catch (error) {
  receipt.status = "failed";
  receipt.liveModelVerified = false;
  receipt.code = /^[A-Z_0-9]+$/.test(error?.message || "") ? error.message : "LIVE_CHECK_FAILED";
  process.exitCode = 1;
} finally {
  await app?.close();
  await source.pool.end();
  if (created) await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
}
await mkdir(resolve(root, ".local/domestic-models"), { recursive: true });
await writeFile(
  resolve(root, ".local/domestic-models/live-receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(receipt));
