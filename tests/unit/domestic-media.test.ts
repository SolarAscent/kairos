import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  DomesticModelProvider,
  domesticConfiguration,
  mediaCapabilities,
  MockModelProvider,
} from "@life/agent-core";
import { createCaptureRequestSchema } from "@life/contracts";
import { VoiceService, type AsrSocketFactory } from "../../apps/api/dist/media/voice.service.js";

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
  terminate() {
    this.close();
  }
  receive(event: object) {
    this.emit("message", Buffer.from(JSON.stringify(event)), false);
  }
}
const env = {
  MODEL_PROVIDER: "qwen",
  DASHSCOPE_API_KEY: "test-secret",
  DASHSCOPE_WORKSPACE_ID: "test-workspace",
};
const user = { id: randomUUID(), sessionId: randomUUID() };
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function harness() {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const upstream = new Socket(),
    client = new Socket();
  const factory = vi.fn(() => upstream) as unknown as AsrSocketFactory;
  const service = new VoiceService(factory);
  const lease = service.create(user);
  const claimed = service.claim(lease.ticket)!;
  service.relay(client as unknown as WebSocket, claimed);
  return { upstream, client, service, lease, factory };
}

describe("domestic text and image provider boundary", () => {
  it("selects vision model, sends inline image, preserves schema and refuses fabricated output", async () => {
    const result = await new MockModelProvider().parseCapture("想去书店");
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
          }),
        ),
    );
    const gateway = new DomesticModelProvider(
      domesticConfiguration({
        ...env,
        QWEN_TEXT_MODEL: "text-test",
        QWEN_VISION_MODEL: "vision-test",
      }),
      transport as typeof fetch,
    );
    await expect(
      gateway.parseCapture({ text: "想去这里", image: { mimeType: "image/jpeg", base64: "/9j/" } }),
    ).resolves.toEqual(result);
    const [url, request] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://test-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    const body = JSON.parse(request.body as string);
    expect(body.model).toBe("vision-test");
    expect(body.messages[1].content[1].image_url.url).toBe("data:image/jpeg;base64,/9j/");
    expect(body.messages[0].content).toContain("待理解的数据");
    expect(body.messages[0].content).toContain("不照抄整段输入");
    expect(body.messages[0].content.length).toBeLessThan(9500);
    expect(body.messages[0].content).toContain(
      "TIME、DURATION、LOCATION、CONTEXT、BUDGET、ACTIVITY均不是facet.type",
    );
    expect(body.messages[0].content).toContain(
      '"type":{"type":"string","enum":["PLACE","DESIRE","MEDIA","TIME_ANCHOR"',
    );
    result.objects[0]!.facets[0]!.data.verification = "VERIFIED" as never;
    await expect(gateway.parseCapture("text")).rejects.toThrow();
  });
  it.each([
    ["qwen", undefined, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"],
    [
      "qwen",
      "ws-real-workspace",
      "https://ws-real-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    ],
    [
      "qwen",
      "evil.example/path?key=secret",
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    ],
    ["glm", "ws-real-workspace", "https://open.bigmodel.cn/api/paas/v4/chat/completions"],
  ])(
    "selects the fixed official endpoint for %s workspace %s",
    async (provider, workspace, expected) => {
      const result = await new MockModelProvider().parseCapture("想读书");
      const transport = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
            }),
          ),
      );
      const gateway = new DomesticModelProvider(
        domesticConfiguration({
          MODEL_PROVIDER: provider,
          DASHSCOPE_API_KEY: "test-secret",
          GLM_API_KEY: "test-secret",
          DASHSCOPE_WORKSPACE_ID: workspace,
        }),
        transport as typeof fetch,
      );
      await gateway.parseCapture("想读书");
      expect((transport.mock.calls[0] as unknown as [string])[0]).toBe(expected);
    },
  );
  it("sends unique-source rebuild evidence as quoted user data with the existing object scope", async () => {
    const result = await new MockModelProvider().parseCapture("新疆旅行愿望");
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
          }),
        ),
    );
    const gateway = new DomesticModelProvider(
      domesticConfiguration(env),
      transport as typeof fetch,
    );
    await gateway.parseCapture({
      text: JSON.stringify({ title: "新疆旅行愿望", descriptions: [] }),
      factsOnly: true,
      originalCaptureText: "我在广东，想将来去新疆旅行，预算3000元",
      referenceTime: "2026-10-05T01:00:00Z",
      timezone: "Asia/Shanghai",
    });
    const body = JSON.parse(
      (transport.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.messages[0].content).toContain("originalCaptureText仅在来源唯一时提供");
    expect(JSON.parse(body.messages[1].content)).toEqual({
      existingObject: { title: "新疆旅行愿望", descriptions: [] },
      originalCaptureText: "我在广东，想将来去新疆旅行，预算3000元",
    });
  });
  it("retains status and a safe request id without reading or exposing an upstream error body", async () => {
    const response = new Response("private upstream details and secret", {
      status: 429,
      headers: { "x-request-id": "request-123" },
    });
    const readBody = vi.spyOn(response, "text");
    const gateway = new DomesticModelProvider(domesticConfiguration(env), async () => response);
    let caught: unknown;
    try {
      await gateway.parseCapture("想去公园");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: "MODEL_PROVIDER_ERROR",
      provider: "qwen",
      status: 429,
      providerRequestId: "request-123",
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(JSON.stringify(caught)).not.toContain("secret");
  });
  it("never requests upstream without credentials and never falls back to mock", async () => {
    const transport = vi.fn();
    const gateway = new DomesticModelProvider(
      domesticConfiguration({ MODEL_PROVIDER: "qwen" }),
      transport,
    );
    await expect(gateway.parseCapture("text")).rejects.toThrow("MODEL_CONFIGURATION_MISSING");
    expect(transport).not.toHaveBeenCalled();
    expect(mediaCapabilities({ MODEL_PROVIDER: "mock" })).toMatchObject({
      text: false,
      image: false,
      voice: false,
      provider: "mock",
    });
    expect(mediaCapabilities({ ...env, DASHSCOPE_WORKSPACE_ID: undefined }).voice).toBe(false);
  });
  it("GLM image omits text-only response_format and uses its vision model", async () => {
    const result = await new MockModelProvider().parseCapture("想读书");
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
          }),
        ),
    );
    const gateway = new DomesticModelProvider(
      domesticConfiguration({ MODEL_PROVIDER: "glm", GLM_API_KEY: "test" }),
      transport as typeof fetch,
    );
    await gateway.parseCapture({ text: "图", image: { mimeType: "image/png", base64: "AAAA" } });
    const request = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(request[1].body as string)).toMatchObject({ model: "glm-4.6v-flash" });
    expect(JSON.parse(request[1].body as string)).not.toHaveProperty("response_format");
  });
  it("rejects remote image URLs and invalid/oversized encoding at contract", () => {
    expect(
      createCaptureRequestSchema.safeParse({
        type: "IMAGE",
        image: { url: "http://localhost/private" },
      }).success,
    ).toBe(false);
    expect(
      createCaptureRequestSchema.safeParse({
        type: "IMAGE",
        image: { mimeType: "image/png", base64: "bad?" },
      }).success,
    ).toBe(false);
    expect(
      createCaptureRequestSchema.safeParse({
        type: "IMAGE",
        image: { mimeType: "image/png", base64: "A".repeat(2800000) },
      }).success,
    ).toBe(false);
  });
});

describe("authenticated Qwen voice relay protocol", () => {
  it("is single-use, binds transcript to user, waits for config ack and relays partial/final/done", () => {
    const { upstream, client, service, lease } = harness();
    expect(service.claim(lease.ticket)).toBeUndefined();
    upstream.emit("open");
    expect(upstream.sent[0]).toMatchObject({
      type: "session.update",
      session: { sample_rate: 16000, input_audio_format: "pcm" },
    });
    expect(client.sent).toHaveLength(0);
    upstream.receive({ type: "session.updated" });
    expect(client.sent[0]).toEqual({ type: "ready", sessionId: lease.sessionId });
    client.emit("message", Buffer.alloc(3200), true);
    expect(upstream.sent[1]).toMatchObject({ type: "input_audio_buffer.append" });
    upstream.receive({
      type: "conversation.item.input_audio_transcription.text",
      text: "想去",
      stash: "公园",
    });
    expect(client.sent[1]).toEqual({ type: "partial", text: "想去公园" });
    upstream.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "a",
      transcript: "想去公园",
    });
    upstream.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "a",
      transcript: "想去公园",
    });
    expect(client.sent.filter((e) => e.type === "final")).toHaveLength(1);
    client.receive({ type: "finish" });
    expect(upstream.sent.at(-1)?.type).toBe("session.finish");
    upstream.receive({ type: "session.finished" });
    expect(client.sent.at(-1)).toEqual({
      type: "done",
      text: "想去公园",
      sessionId: lease.sessionId,
    });
    expect(service.assertTranscript(user.id, lease.sessionId)).toMatchObject({
      transcript: "想去公园",
      provider: "qwen",
      model: "qwen3-asr-flash-realtime",
    });
    expect(() => service.assertTranscript(randomUUID(), lease.sessionId)).toThrow();
    service.shutdown();
  });
  it("retains a 60-second recording despite pruning, expires finished transcripts and rejects ticket expiry", () => {
    vi.useFakeTimers();
    const { upstream, client, service, lease } = harness();
    upstream.receive({ type: "session.updated" });
    client.emit("message", Buffer.alloc(320), true);
    vi.advanceTimersByTime(61000);
    service.create({ id: randomUUID(), sessionId: randomUUID() });
    upstream.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "原始转写",
    });
    client.receive({ type: "finish" });
    upstream.receive({ type: "session.finished" });
    expect(service.assertTranscript(user.id, lease.sessionId).transcript).toBe("原始转写");
    vi.advanceTimersByTime(300001);
    expect(() => service.assertTranscript(user.id, lease.sessionId)).toThrow();
    const late = service.create(user);
    vi.advanceTimersByTime(60001);
    expect(service.claim(late.ticket)).toBeUndefined();
    service.shutdown();
  });
  it("cancels upstream and rejects PCM format/byte limits without retaining a transcript", () => {
    const first = harness();
    first.upstream.receive({ type: "session.updated" });
    first.client.receive({ type: "cancel" });
    expect(first.upstream.readyState).toBe(WebSocket.CLOSED);
    expect(() => first.service.assertTranscript(user.id, first.lease.sessionId)).toThrow();
    const second = harness();
    second.upstream.receive({ type: "session.updated" });
    second.client.emit("message", Buffer.alloc(3), true);
    expect(second.client.sent.at(-1)).toMatchObject({
      type: "error",
      code: "VOICE_AUDIO_LIMIT_OR_FORMAT",
    });
    first.service.shutdown();
    second.service.shutdown();
  });
  it("releases the active lease on cancel or close so another short recording can start", () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const sockets: Socket[] = [];
    const factory = (() => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    }) as unknown as AsrSocketFactory;
    const service = new VoiceService(factory);
    for (const action of ["cancel", "close"]) {
      const lease = service.create(user),
        claimed = service.claim(lease.ticket)!;
      expect(claimed).toBeDefined();
      const client = new Socket();
      service.relay(client as unknown as WebSocket, claimed);
      expect(() => service.create(user)).toThrow();
      if (action === "cancel") client.receive({ type: "cancel" });
      else client.close();
      expect(sockets.at(-1)!.readyState).toBe(WebSocket.CLOSED);
      expect(() => service.assertTranscript(user.id, lease.sessionId)).toThrow();
    }
    const next = service.create(user);
    expect(service.claim(next.ticket)).toBeDefined();
    service.shutdown();
  });
  it("fails immediately without key and limits session creation per user", () => {
    vi.stubEnv("MODEL_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "");
    const factory = vi.fn();
    const service = new VoiceService(factory);
    expect(() => service.create(user)).toThrow();
    expect(factory).not.toHaveBeenCalled();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.useFakeTimers();
    for (let attempt = 0; attempt < 12; attempt++) service.create(user);
    expect(() => service.create(user)).toThrow();
    vi.advanceTimersByTime(60001);
    expect(() => service.create(user)).not.toThrow();
    service.shutdown();
  });
});
