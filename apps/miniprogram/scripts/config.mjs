import { z } from "zod";

const schema = z
  .object({
    environment: z.enum(["develop", "staging", "production"]),
    appId: z.string(),
    apiBaseUrl: z.url(),
    loginMode: z.enum(["wechat", "mock"]),
    appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  })
  .strict();

export function validateConfig(raw) {
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error("MINIPROGRAM_CONFIG_INVALID: check config.example.json");
  const config = result.data;
  const url = new URL(config.apiBaseUrl);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("API_BASE_URL_MUST_BE_ORIGIN");
  if (config.appId !== "touristappid" && !/^wx[0-9a-f]{16}$/i.test(config.appId))
    throw new Error("APP_ID_INVALID");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (config.environment !== "develop") {
    if (config.loginMode !== "wechat") throw new Error("MOCK_LOGIN_FORBIDDEN");
    if (config.appId === "touristappid") throw new Error("REAL_APP_ID_REQUIRED");
    if (
      url.protocol !== "https:" ||
      local ||
      url.hostname.endsWith(".invalid") ||
      url.hostname.endsWith(".example")
    )
      throw new Error("PUBLIC_HTTPS_API_REQUIRED");
  }
  return { ...config, apiBaseUrl: url.origin };
}
