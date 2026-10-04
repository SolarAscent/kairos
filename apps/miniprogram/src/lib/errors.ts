import { ClientError } from "./client";
const messages: Record<string, string> = {
  LOGIN_REQUIRED: "登录已过期，请重新登录。",
  SESSION_CHANGED: "登录状态已改变，请重新操作。",
  NETWORK_UNAVAILABLE: "暂时连接不上，内容还在，请稍后重试。",
  WECHAT_LOGIN_FAILED: "微信登录未完成，请重试。",
  WECHAT_CODE_INVALID: "登录凭证已过期，请重新登录。",
  WECHAT_LOGIN_RATE_LIMITED: "登录有些频繁，请稍后再试。",
  WECHAT_LOGIN_REJECTED: "暂时无法使用微信登录。",
  WECHAT_PROVIDER_UNAVAILABLE: "登录服务暂时不可用，请稍后再试。",
  WECHAT_APP_ID_REQUIRED: "尚未配置小程序 AppID。",
  WECHAT_LOGIN_NOT_CONFIGURED: "登录服务尚未配置完成。",
  MOCK_LOGIN_FORBIDDEN: "当前版本不支持开发登录。",
  RESPONSE_INVALID: "服务返回异常，请稍后重试。",
  IDEMPOTENCY_CONFLICT: "这次操作的内容已改变，请关闭后重新操作。",
  STORAGE_UNAVAILABLE: "本机存储不可用，请清理空间后重试。",
};
export function userMessage(error: unknown) {
  if (error instanceof ClientError) return messages[error.code] ?? "暂时无法完成，请稍后重试。";
  return "暂时无法完成，请稍后重试。";
}
