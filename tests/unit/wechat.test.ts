import { describe, expect, it, vi } from "vitest";
import { resolveWechatCode, checkWechatConfig } from "../../apps/api/dist/auth/wechat.provider.js";
import { validateConfig } from "../../apps/miniprogram/scripts/config.mjs";

const env = {
  NODE_ENV: "test",
  WECHAT_MOCK_LOGIN: "false",
  WECHAT_APP_ID: "wx0123456789abcdef",
  WECHAT_APP_SECRET: "test-only-secret",
};
const clientConfig = {
  environment: "staging",
  appId: env.WECHAT_APP_ID,
  apiBaseUrl: "https://api.example.org",
  loginMode: "wechat",
  appVersion: "0.2.0",
};
describe("WeChat provider boundary", () => {
  it("exchanges a code server-side and strips session_key", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ openid: "openid-1", unionid: "union-1", session_key: "never-return" }),
        ),
    );
    expect(await resolveWechatCode("one-use-code", env, fetcher)).toEqual({
      openId: "openid-1",
      unionId: "union-1",
    });
    const url = fetcher.mock.calls[0]![0] as URL;
    expect(url.origin).toBe("https://api.weixin.qq.com");
    expect(url.searchParams.get("js_code")).toBe("one-use-code");
  });
  it.each([
    [{ errcode: 40029 }, 400, "WECHAT_CODE_INVALID"],
    [{ errcode: 40163 }, 400, "WECHAT_CODE_INVALID"],
    [{ errcode: 45011 }, 429, "WECHAT_LOGIN_RATE_LIMITED"],
    [{ errcode: 40226 }, 403, "WECHAT_LOGIN_REJECTED"],
    [{ errcode: -1 }, 503, "WECHAT_PROVIDER_UNAVAILABLE"],
    [{ openid: 123 }, 503, "WECHAT_PROVIDER_UNAVAILABLE"],
    [{}, 503, "WECHAT_PROVIDER_UNAVAILABLE"],
  ])("maps provider response %j without exposing provider text", async (payload, status, code) => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ ...payload, errmsg: "secret diagnostics" })),
    );
    try {
      await resolveWechatCode("code", env, fetcher);
      throw new Error("expected rejection");
    } catch (error: any) {
      expect(error.getStatus()).toBe(status);
      expect(error.getResponse()).toEqual({ code });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    async () => {
      throw new Error("timeout with secret URL");
    },
    async () => new Response("not json"),
    async () => new Response("server error", { status: 502 }),
  ])("handles transport failures without retrying single-use codes", async (fetcher) => {
    const call = vi.fn(fetcher);
    await expect(resolveWechatCode("code", env, call)).rejects.toMatchObject({
      response: { code: "WECHAT_PROVIDER_UNAVAILABLE" },
    });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("rejects production mock and incomplete real configuration", async () => {
    expect(() =>
      checkWechatConfig({ ...env, NODE_ENV: "production", WECHAT_MOCK_LOGIN: "true" }),
    ).toThrow("MOCK_LOGIN_FORBIDDEN");
    expect(() => checkWechatConfig({ NODE_ENV: "production" })).toThrow(
      "WECHAT_LOGIN_NOT_CONFIGURED",
    );
    const fetcher = vi.fn();
    await expect(resolveWechatCode("code", { NODE_ENV: "test" }, fetcher)).rejects.toMatchObject({
      response: { code: "WECHAT_LOGIN_NOT_CONFIGURED" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe("Mini Program release configuration", () => {
  it("accepts a real app with HTTPS and rejects secrets in public config", () => {
    expect(validateConfig(clientConfig).apiBaseUrl).toBe("https://api.example.org");
    expect(() => validateConfig({ ...clientConfig, appSecret: "secret" })).toThrow(
      "MINIPROGRAM_CONFIG_INVALID",
    );
  });
  it.each([
    { loginMode: "mock" },
    { appId: "touristappid" },
    { apiBaseUrl: "http://api.example.org" },
    { apiBaseUrl: "https://localhost" },
    { apiBaseUrl: "https://user:secret@api.example.org" },
    { apiBaseUrl: "https://api.example.org?secret=x" },
    { apiBaseUrl: "https://api.example.org/v1" },
  ])("blocks invalid release settings %j", (patch) => {
    expect(() => validateConfig({ ...clientConfig, ...patch })).toThrow();
  });
});
