import { afterEach, describe, expect, it, vi } from "vitest";
import { userMessage, voiceConnectionErrorCode } from "../../apps/miniprogram/src/lib/errors";

afterEach(() => vi.unstubAllGlobals());
describe("native voice connection diagnostics", () => {
  it.each([
    ["connectSocket:fail url not in domain list", "VOICE_SOCKET_DOMAIN_NOT_ALLOWED"],
    ["WebSocket url not in domain list", "VOICE_SOCKET_DOMAIN_NOT_ALLOWED"],
    ["connectSocket:fail SSL handshake failed", "VOICE_SOCKET_CERTIFICATE_INVALID"],
    ["certificate expired", "VOICE_SOCKET_CERTIFICATE_INVALID"],
    ["WebSocket handshake failed: unexpected response 502", "VOICE_SOCKET_HANDSHAKE_FAILED"],
    ["connectSocket:fail network is down", "NETWORK_UNAVAILABLE"],
  ])("maps %s to an actionable code", (errMsg, code) => {
    expect(voiceConnectionErrorCode({ errMsg })).toBe(code);
  });
  it("returns only a code and renders only the public server origin, never raw error or ticket", () => {
    vi.stubGlobal("__MINIPROGRAM_CONFIG__", {
      apiBaseUrl: "https://api.example.cn/private?key=config-secret",
    });
    const raw =
      "connectSocket:fail url not in domain list wss://api.example.cn/v1/media/voice/stream?ticket=one-time-secret";
    const code = voiceConnectionErrorCode({ errMsg: raw });
    expect(code).toBe("VOICE_SOCKET_DOMAIN_NOT_ALLOWED");
    const message = userMessage({ code });
    expect(message).toContain("wss://api.example.cn");
    expect(message).toContain("socket 合法域名");
    expect(message).not.toMatch(/ticket|secret|private|stream|connectSocket:fail/);
  });
  it("does not expose URL userinfo and preserves the network fallback", () => {
    vi.stubGlobal("__MINIPROGRAM_CONFIG__", { apiBaseUrl: "https://private-key@api.example.cn" });
    expect(userMessage({ code: "VOICE_SOCKET_HANDSHAKE_FAILED" })).toContain("当前后端域名");
    expect(userMessage({ code: "VOICE_SOCKET_HANDSHAKE_FAILED" })).not.toContain("private-key");
    expect(voiceConnectionErrorCode(null)).toBe("NETWORK_UNAVAILABLE");
    expect(userMessage({ code: "NETWORK_UNAVAILABLE" })).toBe(
      "暂时连接不上，内容还在，请稍后重试。",
    );
  });
});
