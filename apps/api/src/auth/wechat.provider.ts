import { BadRequestException, HttpException, ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";

const responseSchema = z.object({
  openid: z.string().min(1).optional(),
  unionid: z.string().min(1).optional(),
  errcode: z.number().int().optional(),
});

export function checkWechatConfig(env = process.env) {
  if (env.WECHAT_MOCK_LOGIN && !["true", "false"].includes(env.WECHAT_MOCK_LOGIN))
    throw new Error("WECHAT_MOCK_LOGIN_INVALID");
  const appId = env.WECHAT_APP_ID ?? "";
  const appSecret = env.WECHAT_APP_SECRET;
  const credentials =
    /^wx[0-9a-f]{16}$/i.test(appId) && appSecret?.trim() ? { appId, appSecret } : null;
  if (env.NODE_ENV === "production") {
    if (env.WECHAT_MOCK_LOGIN === "true") throw new Error("MOCK_LOGIN_FORBIDDEN_IN_PRODUCTION");
    if (!credentials) throw new Error("WECHAT_LOGIN_NOT_CONFIGURED");
  }
  return credentials;
}

export async function resolveWechatCode(code: string, env = process.env, fetcher = fetch) {
  const credentials = checkWechatConfig(env);
  if (env.WECHAT_MOCK_LOGIN === "true") return { openId: "local-demo:" + code };
  if (!credentials) throw new ServiceUnavailableException({ code: "WECHAT_LOGIN_NOT_CONFIGURED" });
  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.searchParams.set("appid", credentials.appId);
  url.searchParams.set("secret", credentials.appSecret);
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");
  // A login code is single-use. Never retry this exchange or log its URL/payload.
  let raw: unknown;
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: "error" });
    if (!response.ok) throw new Error("HTTP_FAILURE");
    raw = await response.json();
  } catch {
    throw new ServiceUnavailableException({ code: "WECHAT_PROVIDER_UNAVAILABLE" });
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success)
    throw new ServiceUnavailableException({ code: "WECHAT_PROVIDER_UNAVAILABLE" });
  const payload = parsed.data;
  if (payload.errcode === 40029 || payload.errcode === 40163)
    throw new BadRequestException({ code: "WECHAT_CODE_INVALID" });
  if (payload.errcode === 45011)
    throw new HttpException({ code: "WECHAT_LOGIN_RATE_LIMITED" }, 429);
  if (payload.errcode === 40226) throw new HttpException({ code: "WECHAT_LOGIN_REJECTED" }, 403);
  if (payload.errcode || !payload.openid)
    throw new ServiceUnavailableException({ code: "WECHAT_PROVIDER_UNAVAILABLE" });
  return { openId: payload.openid, unionId: payload.unionid };
}
