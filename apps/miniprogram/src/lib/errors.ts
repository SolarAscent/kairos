const messages: Record<string, string> = {
  AVATAR_READ_FAILED: "头像读取失败，请重新选择。",
  AVATAR_TOO_LARGE: "头像压缩后仍偏大，请换一张较小的图片。",
  AVATAR_FORMAT_OR_SIZE_INVALID: "请选择 JPG 或 PNG 头像，压缩后需小于 256 KB。",
  AVATAR_STORAGE_UNAVAILABLE: "资料已保存，头像暂时未显示。请清理本机空间后重新进入。",
  AVATAR_CHANGED: "头像刚刚有更新，请重新进入个人资料查看。",
  LOCATION_PERMISSION_REQUIRED: "可在微信设置中允许定位，原来的建议还在。",
  LOCATION_SYSTEM_DISABLED: "请在手机系统设置中开启定位，并允许微信使用位置后重试。",
  LOCATION_PRIVACY_REQUIRED: "请先在微信中确认位置相关的隐私授权，原来的建议还在。",
  LOCATION_API_NOT_ALLOWED: "当前位置功能暂时不可用，原来的建议还在。",
  LOCATION_RATE_LIMITED: "定位请求有些频繁，请稍后再试。",
  LOCATION_TIMEOUT: "获取位置超时，原来的建议还在，请重试或检查手机定位设置。",
  LOCATION_INVALID: "没有取得有效位置，原来的建议还在，请重新定位。",
  LOCATION_UNAVAILABLE: "暂时无法获取位置，原来的建议还在，请检查定位与网络后重试。",
  MEDIA_UNSUPPORTED: "当前微信版本暂不支持选择图片，请更新微信后重试。",
  IMAGE_PERMISSION_REQUIRED: "无法打开相机或相册。请在微信设置中允许访问，或先输入文字。",
  IMAGE_TOO_LARGE: "请选择不超过 2 MB 的图片。",
  IMAGE_FORMAT_UNSUPPORTED: "暂时支持 JPG 和 PNG 图片，请选择其他图片。",
  IMAGE_READ_FAILED: "图片读取失败，内容还在，可以重新选择。",
  VOICE_DEVICE_REQUIRED:
    "实时语音需要在手机微信中使用，请用开发工具的预览码在真机体验；这里可以先输入文字。",
  VOICE_PERMISSION_REQUIRED: "需要麦克风权限。请在小程序设置中允许录音，或先输入文字。",
  VOICE_RECORDING_BUSY: "上一段录音正在结束，请稍后再试。",
  VOICE_RECORDING_FAILED: "录音未能开始。请检查麦克风权限，或在手机微信中重试。",
  VOICE_INTERRUPTED: "录音被通话中断，已识别的文字仍保留在输入框中。",
  VOICE_STARTUP_SLOW: "语音暂时没准备好，请松手后重试。已识别的文字仍保留。",
  VOICE_TIMEOUT: "语音响应超时，已识别的文字仍保留，可以改用文字提交。",
  VOICE_NETWORK_SLOW: "网络暂时跟不上录音，已识别的文字仍保留，请稍后再试。",
  VOICE_CONNECTION_CLOSED: "语音连接已结束，已识别的文字仍保留。",
  AI_NOT_CONFIGURED: "模型服务尚未配置。可以先留下文字，稍后再整理。",
  VOICE_CONFIGURATION_MISSING: "语音服务尚未配置。可以先输入文字。",
  VOICE_RATE_LIMIT: "语音开启有些频繁，请稍等一分钟再试。文字仍保留。",
  VOICE_NOT_CONFIGURED: "语音服务尚未配置。可以先输入文字。",
  VOICE_TRANSCRIPT_INVALID_OR_EXPIRED: "这段语音的提交时间已过，文字仍保留。请切换文字输入后提交。",
  VOICE_SESSION_EXPIRED: "这段语音的提交时间已过，文字仍保留。请切换文字输入后提交。",

  DECISION_SESSION_EXPIRED: "这个建议已经过了一会儿，再看看现在适合做什么吧。",
  NOW_QUESTION_NOT_FOUND: "这次选择已经更新，请重新看看建议。",
  NOW_ANSWER_CONFLICT: "这个问题已经回答过，请重新看看建议。",
  NOW_QUESTION_NOT_PENDING: "这次选择已经更新，请重新看看建议。",
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
  ACTION_SOURCE_CHANGED: "这个事项已经更新，请重新获取建议。",
  ACTION_TIME_CONFLICT: "这段时间已有安排，请先完成当前行动，或重新获取建议。",
  RECOMMENDATION_EXPIRED: "这个建议的时间条件已变，请重新获取建议。",
  ACTION_NOT_STARTED: "请先开始这一步，再记录完成。",
  ACTION_ALREADY_FINISHED: "这一步已经结束，可以获取新的建议。",
  IDEMPOTENCY_CONFLICT: "这次操作的内容已改变，请关闭后重新操作。",
  STORAGE_UNAVAILABLE: "本机存储不可用，请清理空间后重试。",
};
/** Classify native failures without retaining their potentially secret socket URL. */
export function voiceConnectionErrorCode(error: unknown) {
  const text =
    typeof error === "object" &&
    error !== null &&
    "errMsg" in error &&
    typeof error.errMsg === "string"
      ? error.errMsg.toLowerCase()
      : "";
  if (/not in domain list|url not in domain list|域名.*(?:不合法|合法域名)/.test(text))
    return "VOICE_SOCKET_DOMAIN_NOT_ALLOWED";
  if (/ssl|tls|certificate|\bcert\b|证书/.test(text)) return "VOICE_SOCKET_CERTIFICATE_INVALID";
  if (/handshake|握手/.test(text)) return "VOICE_SOCKET_HANDSHAKE_FAILED";
  return "NETWORK_UNAVAILABLE";
}
function configuredSocketOrigin() {
  const configured =
    typeof __MINIPROGRAM_CONFIG__ !== "undefined" ? __MINIPROGRAM_CONFIG__.apiBaseUrl : "";
  // Extract only the public origin. Never echo a path, query, ticket or userinfo.
  const match = /^(https?):\/\/([a-z0-9.-]+(?::[0-9]{1,5})?)(?:[/?#]|$)/i.exec(configured);
  return match
    ? `${match[1]!.toLowerCase() === "https" ? "wss" : "ws"}://${match[2]}`
    : "当前后端域名";
}
export function userMessage(error: unknown) {
  // Pages are separate bundles; the app's ClientError constructor has a different identity.
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    if (error.code === "VOICE_SOCKET_DOMAIN_NOT_ALLOWED")
      return `微信未允许连接 ${configuredSocketOrigin()}。请在微信公众平台「开发管理 → 开发设置 → 服务器域名」添加该 socket 合法域名，再重新进入小程序。文字仍保留。`;
    if (error.code === "VOICE_SOCKET_CERTIFICATE_INVALID")
      return `${configuredSocketOrigin()} 的安全连接未通过证书校验。请检查服务器证书有效期和完整证书链后重试。文字仍保留。`;
    if (error.code === "VOICE_SOCKET_HANDSHAKE_FAILED")
      return `${configuredSocketOrigin()} 的语音连接未能完成握手。请检查后端和反向代理是否支持 WebSocket 后重试。文字仍保留。`;
    return messages[error.code] ?? "暂时无法完成，请稍后重试。";
  }
  return "暂时无法完成，请稍后重试。";
}
