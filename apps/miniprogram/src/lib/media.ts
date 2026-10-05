import type { z } from "zod";
import type { ApiClient } from "./client";
import { ClientError } from "./client";
import { voiceConnectionErrorCode } from "./errors";

export { mediaCapabilitiesSchema as capabilitiesSchema } from "@life/contracts";
import {
  voiceSessionResponseSchema as voiceSessionSchema,
  voiceServerEventSchema as voiceEventSchema,
} from "@life/contracts";
export type CaptureImage = { mimeType: "image/jpeg" | "image/png"; base64: string; path: string };

export async function chooseCaptureImage(): Promise<CaptureImage | null> {
  if (typeof wx.chooseMedia !== "function") throw new ClientError("MEDIA_UNSUPPORTED");
  const selected = await new Promise<WechatMiniprogram.ChooseMediaSuccessCallbackResult | null>(
    (resolve, reject) => {
      wx.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        sizeType: ["compressed"],
        success: resolve,
        fail: (error) =>
          /cancel/i.test(error.errMsg)
            ? resolve(null)
            : reject(new ClientError("IMAGE_PERMISSION_REQUIRED")),
      });
    },
  );
  const file = selected?.tempFiles[0];
  if (!file) return null;
  if (file.size > 2 * 1024 * 1024) throw new ClientError("IMAGE_TOO_LARGE");
  const base64 = await new Promise<string>((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: file.tempFilePath,
      encoding: "base64",
      success: ({ data }) =>
        typeof data === "string" ? resolve(data) : reject(new ClientError("IMAGE_READ_FAILED")),
      fail: () => reject(new ClientError("IMAGE_READ_FAILED")),
    });
  });
  const mimeType = base64.startsWith("/9j/")
    ? "image/jpeg"
    : base64.startsWith("iVBORw0KGgo")
      ? "image/png"
      : null;
  if (!mimeType) throw new ClientError("IMAGE_FORMAT_UNSUPPORTED");
  return { mimeType, base64, path: file.tempFilePath };
}

type VoiceEvent = z.infer<typeof voiceEventSchema>;
// The native recorder has no portable off-listener API. Register once and route
// events only to the active session, rather than adding listeners for every tap.
let recorder: WechatMiniprogram.RecorderManager | undefined;
let activeVoice: VoiceCapture | undefined;
function getRecorder() {
  if (!recorder) {
    recorder = wx.getRecorderManager();
    recorder.onStart(() => activeVoice?.recordingStarted());
    recorder.onFrameRecorded((event) =>
      activeVoice?.sendFrame(event.frameBuffer, event.isLastFrame),
    );
    recorder.onStop(() => activeVoice?.recordingStopped());
    recorder.onError(() => activeVoice?.fail("VOICE_RECORDING_FAILED"));
    recorder.onInterruptionBegin(() => activeVoice?.fail("VOICE_INTERRUPTED"));
  }
  return recorder;
}

export class VoiceCapture {
  private socket?: WechatMiniprogram.SocketTask;
  private disposed = false;
  private isRecording = false;
  private recorderStarting = false;
  private finishing = false;
  private ready = false;
  private timer?: ReturnType<typeof setTimeout>;
  private queue = Promise.resolve();
  private queuedFrames = 0;
  private bufferedFrames: ArrayBuffer[] = [];
  private bufferedBytes = 0;
  private readonly maxBufferedBytes = 16000 * 2 * 10;
  private lastFrame = false;
  private stopped = false;
  private finishSent = false;
  constructor(
    private readonly client: ApiClient,
    private readonly onEvent: (event: VoiceEvent) => void,
    private readonly onRecording: () => void = () => {},
    private readonly onFinishing: () => void = () => {},
    private readonly onPreparing: (phase: "permission" | "connecting") => void = () => {},
    private readonly onLevel: (level: number) => void = () => {},
  ) {}
  private deadline() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail("VOICE_TIMEOUT"), 15000);
  }
  async start() {
    if (
      typeof wx.getRecorderManager !== "function" ||
      typeof wx.connectSocket !== "function" ||
      wx.getDeviceInfo?.().platform === "devtools"
    )
      throw new ClientError("VOICE_DEVICE_REQUIRED");
    if (activeVoice && activeVoice !== this) throw new ClientError("VOICE_RECORDING_BUSY");
    this.onPreparing("permission");
    // User initiated this recording. Permission and a short-lived backend ticket
    // can prepare together. Permission starts local audio; the ticket alone
    // never opens a provider socket.
    activeVoice = this;
    const permission = new Promise<void>((resolve, reject) =>
      wx.authorize({
        scope: "scope.record",
        success: () => {
          if (!this.disposed) {
            this.onPreparing("connecting");
            this.recorderStarting = true;
            this.deadline();
            getRecorder().start({
              duration: 60000,
              sampleRate: 16000,
              numberOfChannels: 1,
              format: "PCM",
              frameSize: 4,
            });
          }
          resolve();
        },
        fail: () => reject(new ClientError("VOICE_PERMISSION_REQUIRED")),
      }),
    );
    const prepareTicket = async () => {
      const key = await this.client.newKey();
      if (this.disposed) return null;
      const requestedAt = Date.now();
      const session = await this.client.request("/v1/media/voice/sessions", voiceSessionSchema, {
        method: "POST",
        data: {},
        key,
      });
      return { session, requestedAt };
    };
    let prepared: Awaited<ReturnType<typeof prepareTicket>>;
    try {
      [, prepared] = await Promise.all([permission, prepareTicket()]);
    } catch (error) {
      this.dispose(true);
      throw error;
    }
    if (this.disposed || !prepared) return;
    const fresh =
      Date.now() - prepared.requestedAt < (prepared.session.expiresIn - 5) * 1000
        ? prepared
        : await prepareTicket();
    if (this.disposed || !fresh) return;
    const session = fresh.session;
    // A one-time backend ticket authenticates this socket. Provider credentials
    // and the normal access token never appear in a socket URL.
    const url =
      this.client.config.apiBaseUrl.replace(/^http/, "ws") +
      session.socketPath +
      "?ticket=" +
      encodeURIComponent(session.ticket);
    this.socket = wx.connectSocket({
      url,
      success: () => {},
      fail: (error) => this.fail(voiceConnectionErrorCode(error)),
    });
    this.deadline();
    this.socket.onMessage(({ data }) => {
      if (this.disposed || typeof data !== "string") return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(data);
      } catch {
        this.fail("RESPONSE_INVALID");
        return;
      }
      const parsed = voiceEventSchema.safeParse(decoded);
      if (!parsed.success) {
        this.fail("RESPONSE_INVALID");
        return;
      }
      const event = parsed.data;
      if (event.type === "ready") {
        if (this.ready || event.sessionId !== session.sessionId) {
          this.fail("RESPONSE_INVALID");
          return;
        }
        this.ready = true;
        if (this.timer) clearTimeout(this.timer);
        for (const frame of this.bufferedFrames.splice(0)) this.enqueueFrame(frame);
        this.bufferedBytes = 0;
        if (this.stopped) this.deadline();
        this.flushFinish();
      } else if (event.type === "error") this.fail(event.code);
      else if (event.type === "done") {
        if (event.sessionId !== session.sessionId) {
          this.fail("RESPONSE_INVALID");
          return;
        }
        this.onEvent(event);
        this.dispose(false);
      } else this.onEvent(event);
    });
    this.socket.onError((error) => this.fail(voiceConnectionErrorCode(error)));
    this.socket.onClose(() => {
      if (!this.disposed) this.fail("VOICE_CONNECTION_CLOSED");
    });
  }
  recordingStarted() {
    if (this.disposed) {
      getRecorder().stop();
      return;
    }
    this.recorderStarting = false;
    this.isRecording = true;
    this.onRecording();
  }
  sendFrame(frame: ArrayBuffer, isLastFrame = false) {
    if (this.disposed) return;
    const samples = new Int16Array(frame);
    let energy = 0,
      count = 0;
    for (let index = 0; index < samples.length; index += 32) {
      energy += samples[index]! * samples[index]!;
      count++;
    }
    this.onLevel(count ? Math.min(1, Math.sqrt(energy / count) / 6000) : 0);
    if (isLastFrame) this.lastFrame = true;
    if (!this.ready) {
      if (this.bufferedBytes + frame.byteLength > this.maxBufferedBytes) {
        this.fail("VOICE_STARTUP_SLOW");
        return;
      }
      this.bufferedFrames.push(frame);
      this.bufferedBytes += frame.byteLength;
    } else this.enqueueFrame(frame);
    this.flushFinish();
  }
  private enqueueFrame(frame: ArrayBuffer) {
    if (++this.queuedFrames > 128) {
      this.fail("VOICE_NETWORK_SLOW");
      return;
    }
    this.queue = this.queue
      .then(
        () =>
          new Promise<void>((resolve) => {
            if (this.disposed) {
              resolve();
              return;
            }
            this.socket?.send({
              data: frame,
              success: () => resolve(),
              fail: (error) => {
                this.fail(voiceConnectionErrorCode(error));
                resolve();
              },
            });
          }),
      )
      .finally(() => {
        this.queuedFrames--;
      });
  }
  recordingStopped() {
    this.isRecording = false;
    this.recorderStarting = false;
    if (this.disposed) {
      if (activeVoice === this) activeVoice = undefined;
      return;
    }
    this.finishing = true;
    this.stopped = true;
    this.onFinishing();
    this.deadline();
    this.flushFinish();
  }
  private flushFinish() {
    if (!this.ready || !this.stopped || !this.lastFrame || this.finishSent || this.disposed) return;
    this.finishSent = true;
    void this.queue.then(() => {
      if (!this.disposed)
        this.socket?.send({
          data: JSON.stringify({ type: "finish" }),
          fail: (error) => this.fail(voiceConnectionErrorCode(error)),
        });
    });
  }
  finish() {
    if (this.disposed || this.finishing) return;
    this.finishing = true;
    if (this.isRecording || this.recorderStarting) getRecorder().stop();
    else this.cancel();
  }
  fail(code: string) {
    if (this.disposed) return;
    this.onEvent({ type: "error", code });
    this.dispose(true);
  }
  cancel() {
    this.dispose(true);
  }
  private dispose(sendCancel: boolean) {
    if (this.disposed) return;
    this.disposed = true;
    this.bufferedFrames = [];
    this.bufferedBytes = 0;
    if (this.timer) clearTimeout(this.timer);
    if (sendCancel && this.ready) this.socket?.send({ data: JSON.stringify({ type: "cancel" }) });
    if (this.isRecording || this.recorderStarting) getRecorder().stop();
    else if (activeVoice === this) activeVoice = undefined;
    this.socket?.close({ code: 1000 });
  }
}
