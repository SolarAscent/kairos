import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function setup() {
  vi.resetModules();
  const permission: any = {},
    socket: any = {};
  const recorder = {
    onStart: vi.fn(),
    onStop: vi.fn(),
    onFrameRecorded: vi.fn(),
    onError: vi.fn(),
    onInterruptionBegin: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const connect = vi.fn(() => ({
    onMessage: (callback: any) => (socket.message = callback),
    onError: vi.fn(),
    onClose: vi.fn(),
    send: vi.fn(({ data, success }: any) => {
      (socket.sent ??= []).push(data);
      success?.();
    }),
    close: vi.fn(),
  }));
  vi.stubGlobal("wx", {
    getDeviceInfo: () => ({ platform: "ios" }),
    authorize: (options: any) => Object.assign(permission, options),
    getRecorderManager: () => recorder,
    connectSocket: connect,
  });
  const sessionId = randomUUID();
  let requests = 0;
  const client = {
    config: { apiBaseUrl: "https://api.example.cn" },
    newKey: async () => randomUUID(),
    request: vi.fn(async () => ({
      sessionId,
      ticket: "test-ticket-" + ++requests,
      expiresIn: 60,
      socketPath: "/v1/media/voice/stream",
      sampleRate: 16000,
      format: "pcm16",
    })),
  };
  const { VoiceCapture } = await import("../../apps/miniprogram/src/lib/media");
  const phases: string[] = [];
  const events: any[] = [];
  const voice = new VoiceCapture(
    client as any,
    (event) => events.push(event),
    () => {},
    () => {},
    (phase) => phases.push(phase),
  );
  return { voice, permission, socket, connect, recorder, client, sessionId, phases, events };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("voice startup permission and ticket preparation", () => {
  it("prepares the ticket while permission is pending, opening no socket or microphone before permission", async () => {
    const { voice, permission, client, connect, recorder, socket, sessionId, phases } =
      await setup();
    const starting = voice.start();
    await flush();
    expect(client.request).toHaveBeenCalledWith(
      "/v1/media/voice/sessions",
      expect.anything(),
      expect.objectContaining({ method: "POST" }),
    );
    expect(connect).not.toHaveBeenCalled();
    expect(recorder.start).not.toHaveBeenCalled();
    permission.success();
    await starting;
    expect(phases).toEqual(["permission", "connecting"]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(recorder.start).toHaveBeenCalledTimes(1);
    socket.message({ data: JSON.stringify({ type: "ready", sessionId }) });
    expect(recorder.start).toHaveBeenCalledTimes(1);
    voice.cancel();
  });
  it("permission denial never opens a socket or microphone even after ticket preparation", async () => {
    const { voice, permission, connect, recorder } = await setup();
    const result = voice.start().catch((error) => error);
    await flush();
    permission.fail();
    expect((await result).code).toBe("VOICE_PERMISSION_REQUIRED");
    expect(connect).not.toHaveBeenCalled();
    expect(recorder.start).not.toHaveBeenCalled();
    voice.cancel();
  });
  it("cancellation during the permission prompt prevents late permission from starting recording", async () => {
    const { voice, permission, connect, recorder } = await setup();
    const starting = voice.start();
    await flush();
    voice.cancel();
    permission.success();
    await starting;
    expect(connect).not.toHaveBeenCalled();
    expect(recorder.start).not.toHaveBeenCalled();
  });
  it("replaces an unused expired ticket after a long first permission prompt", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100000);
    const { voice, permission, client, connect } = await setup();
    const starting = voice.start();
    await flush();
    now.mockReturnValue(160000);
    permission.success();
    await starting;
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://api.example.cn/v1/media/voice/stream?ticket=test-ticket-2",
      }),
    );
    voice.cancel();
  });
  it("flushes buffered PCM before finish when release precedes upstream ready", async () => {
    const { voice, permission, socket, sessionId } = await setup();
    const starting = voice.start();
    permission.success();
    await starting;
    const first = new ArrayBuffer(4),
      last = new ArrayBuffer(2);
    voice.sendFrame(first);
    voice.sendFrame(last, true);
    voice.recordingStopped();
    expect(socket.sent).toBeUndefined();
    socket.message({ data: JSON.stringify({ type: "ready", sessionId }) });
    await flush();
    expect(socket.sent[0]).toBe(first);
    expect(socket.sent[1]).toBe(last);
    expect(JSON.parse(socket.sent[2])).toEqual({ type: "finish" });
    voice.cancel();
  });
  it("bounds the pre-ready audio prefix and ignores late ready after overflow", async () => {
    const { voice, permission, socket, sessionId, events } = await setup();
    const starting = voice.start();
    permission.success();
    await starting;
    voice.sendFrame(new ArrayBuffer(16000 * 2 * 10));
    voice.sendFrame(new ArrayBuffer(2));
    expect(events).toEqual([{ type: "error", code: "VOICE_STARTUP_SLOW" }]);
    socket.message({ data: JSON.stringify({ type: "ready", sessionId }) });
    await flush();
    expect(socket.sent).toBeUndefined();
    voice.cancel();
  });
  it("stops early audio and discards its buffer if cancelled while the ticket is still in flight", async () => {
    const { voice, permission, client, connect, recorder, sessionId } = await setup();
    let receive!: (session: any) => void;
    client.request.mockImplementationOnce(() => new Promise((resolve) => (receive = resolve)));
    const starting = voice.start();
    permission.success();
    await flush();
    voice.sendFrame(new ArrayBuffer(4096));
    voice.cancel();
    receive({
      sessionId,
      ticket: "test-ticket",
      expiresIn: 60,
      socketPath: "/v1/media/voice/stream",
      sampleRate: 16000,
      format: "pcm16",
    });
    await starting;
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
  });
});
