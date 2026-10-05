import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  HttpException,
} from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { domesticConfiguration, mediaCapabilities } from "@life/agent-core";
import type { AuthenticatedUser } from "../common/security.js";

type VoiceSession = {
  id: string;
  user: AuthenticatedUser;
  expiresAt: number;
  ticket?: string;
  connected?: boolean;
  transcript?: string;
  provider: string;
  model: string;
};
export type AsrSocketFactory = (
  url: string,
  options: { headers: Record<string, string>; handshakeTimeout: number; maxPayload: number },
) => WebSocket;
const MAX_PCM_BYTES = 16000 * 2 * 60;

@Injectable()
export class VoiceService {
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly starts = new Map<string, number[]>();
  private readonly active = new Set<() => void>();
  constructor(
    private readonly socketFactory: AsrSocketFactory = (url, options) =>
      new WebSocket(url, options),
  ) {}

  capabilities() {
    return mediaCapabilities();
  }
  create(user: AuthenticatedUser) {
    this.prune();
    if (!this.capabilities().voice)
      throw new ServiceUnavailableException({ code: "VOICE_CONFIGURATION_MISSING" });
    const now = Date.now();
    const starts = (this.starts.get(user.id) ?? []).filter((at) => at > now - 60000);
    if (
      starts.length >= 12 ||
      [...this.sessions.values()].some(
        (s) => s.user.id === user.id && s.connected && s.transcript === undefined,
      )
    )
      throw new HttpException({ code: "VOICE_RATE_LIMIT" }, 429);
    starts.push(now);
    this.starts.set(user.id, starts);
    const config = domesticConfiguration();
    const session: VoiceSession = {
      provider: "qwen",
      model: config.asrModel,
      id: randomUUID(),
      user,
      ticket: randomBytes(32).toString("base64url"),
      expiresAt: now + 60000,
    };
    this.sessions.set(session.id, session);
    return {
      sessionId: session.id,
      ticket: session.ticket!,
      expiresIn: 60 as const,
      socketPath: "/v1/media/voice/stream" as const,
      sampleRate: 16000 as const,
      format: "pcm16" as const,
    };
  }
  claim(ticket: string) {
    this.prune();
    const session = [...this.sessions.values()].find((s) => s.ticket === ticket);
    if (!session || session.connected || session.expiresAt <= Date.now()) return undefined;
    if (
      [...this.sessions.values()].some(
        (s) =>
          s.id !== session.id &&
          s.user.id === session.user.id &&
          s.connected &&
          s.transcript === undefined,
      )
    )
      return undefined;
    session.ticket = undefined;
    session.connected = true;
    session.expiresAt = Date.now() + 90000;
    return session;
  }
  assertTranscript(userId: string, sessionId: string) {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session || session.user.id !== userId || !session.transcript)
      throw new BadRequestException({ code: "VOICE_TRANSCRIPT_INVALID_OR_EXPIRED" });
    return {
      transcript: session.transcript,
      sessionId: session.id,
      provider: session.provider,
      model: session.model,
    };
  }
  private prune() {
    const now = Date.now();
    for (const [id, session] of this.sessions)
      if (session.expiresAt <= now) this.sessions.delete(id);
    for (const [id, starts] of this.starts)
      if (starts.every((at) => at <= now - 60000)) this.starts.delete(id);
  }
  discard(sessionId: string) {
    this.sessions.delete(sessionId);
  }
  shutdown() {
    for (const close of this.active) close();
  }

  relay(client: WebSocket, session: VoiceSession) {
    const config = domesticConfiguration();
    if (!config.apiKey || !this.capabilities().voice) {
      client.send(JSON.stringify({ type: "error", code: "VOICE_CONFIGURATION_MISSING" }));
      client.close();
      this.sessions.delete(session.id);
      return;
    }
    const upstream = this.socketFactory(
      `wss://${config.workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(config.asrModel)}`,
      {
        headers: { Authorization: "Bearer " + config.apiKey, "OpenAI-Beta": "realtime=v1" },
        handshakeTimeout: 10000,
        maxPayload: 256 * 1024,
      },
    );
    let ready = false,
      finishing = false,
      done = false,
      closed = false,
      bytes = 0;
    const segments = new Map<string, string>();
    let segmentIndex = 0;
    const emit = (event: object) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
    };
    const send = (type: string, extra: object = {}) => {
      if (upstream.readyState === WebSocket.OPEN)
        upstream.send(JSON.stringify({ event_id: randomUUID(), type, ...extra }));
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      clearTimeout(openDeadline);
      if (finishDeadline) clearTimeout(finishDeadline);
      this.active.delete(close);
      if (!done) this.sessions.delete(session.id);
      if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      else upstream.close();
      if (client.readyState === WebSocket.OPEN) client.close();
    };
    const fail = (code: string) => {
      if (closed) return;
      emit({ type: "error", code });
      close();
    };
    const deadline = setTimeout(() => fail("VOICE_DURATION_LIMIT"), 75000);
    const openDeadline = setTimeout(() => {
      if (!ready) fail("VOICE_UPSTREAM_TIMEOUT");
    }, 12000);
    let finishDeadline: ReturnType<typeof setTimeout> | undefined;
    this.active.add(close);
    upstream.on("open", () =>
      send("session.update", {
        session: {
          modalities: ["text"],
          input_audio_format: "pcm",
          sample_rate: 16000,
          input_audio_transcription: { language: "zh" },
          turn_detection: { type: "server_vad", threshold: 0.2, silence_duration_ms: 400 },
        },
      }),
    );
    upstream.on("message", (data: RawData) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        fail("VOICE_UPSTREAM_INVALID");
        return;
      }
      if (event.type === "session.updated") {
        ready = true;
        clearTimeout(openDeadline);
        emit({ type: "ready", sessionId: session.id });
      } else if (event.type === "conversation.item.input_audio_transcription.text") {
        const text =
          (typeof event.text === "string" ? event.text : "") +
          (typeof event.stash === "string" ? event.stash : "");
        if (text.length > 5000) {
          fail("VOICE_TRANSCRIPT_TOO_LONG");
          return;
        }
        emit({ type: "partial", text });
      } else if (event.type === "conversation.item.input_audio_transcription.completed") {
        const text = typeof event.transcript === "string" ? event.transcript : "";
        const key = typeof event.item_id === "string" ? event.item_id : String(segmentIndex++);
        const duplicate = segments.get(key) === text;
        segments.set(key, text);
        if ([...segments.values()].join("").length > 5000) {
          fail("VOICE_TRANSCRIPT_TOO_LONG");
          return;
        }
        if (!duplicate) emit({ type: "final", text });
      } else if (event.type === "session.finished") {
        if (!finishing) {
          fail("VOICE_UNEXPECTED_FINISH");
          return;
        }
        const text = [...segments.values()].join("").trim();
        if (!text) {
          fail("VOICE_NO_SPEECH");
          return;
        }
        done = true;
        session.transcript = text;
        session.expiresAt = Date.now() + 300000;
        emit({ type: "done", text, sessionId: session.id });
        close();
      } else if (
        event.type === "error" ||
        event.type === "conversation.item.input_audio_transcription.failed"
      )
        fail("VOICE_UPSTREAM_ERROR");
    });
    upstream.on("error", () => fail("VOICE_UPSTREAM_UNAVAILABLE"));
    upstream.on("close", () => {
      if (!done) fail("VOICE_UPSTREAM_CLOSED");
    });
    client.on("message", (data: RawData, isBinary: boolean) => {
      if (done) return;
      if (isBinary) {
        const buffer = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        if (!ready || finishing) {
          fail("VOICE_NOT_READY");
          return;
        }
        bytes += buffer.byteLength;
        if (
          !buffer.byteLength ||
          buffer.byteLength % 2 ||
          buffer.byteLength > 64 * 1024 ||
          bytes > MAX_PCM_BYTES
        ) {
          fail("VOICE_AUDIO_LIMIT_OR_FORMAT");
          return;
        }
        if (upstream.bufferedAmount > 128 * 1024) {
          fail("VOICE_BACKPRESSURE");
          return;
        }
        send("input_audio_buffer.append", { audio: buffer.toString("base64") });
      } else {
        if (Buffer.byteLength(data.toString()) > 256) {
          fail("VOICE_MESSAGE_INVALID");
          return;
        }
        let event: { type?: string };
        try {
          event = JSON.parse(data.toString());
        } catch {
          fail("VOICE_MESSAGE_INVALID");
          return;
        }
        if (event.type === "cancel") close();
        else if (event.type === "finish" && ready && !finishing && bytes > 0) {
          finishing = true;
          send("session.finish");
          finishDeadline = setTimeout(() => fail("VOICE_FINAL_TIMEOUT"), 15000);
        } else fail("VOICE_MESSAGE_INVALID");
      }
    });
    client.on("close", close);
    client.on("error", close);
  }
}
