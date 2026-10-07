import { ClientError } from "./client";

/** Keep native diagnostics free of coordinates, then map them to actionable errors. */
export function locationErrorCode(error: unknown) {
  const message =
    error && typeof error === "object" && "errMsg" in error
      ? String(error.errMsg).toLowerCase()
      : "";
  if (/privacy|隐私/.test(message)) return "LOCATION_PRIVACY_REQUIRED";
  if (/system permission|location service|gps.*(?:off|disabled)|系统.*(?:关闭|定位)/.test(message))
    return "LOCATION_SYSTEM_DISABLED";
  if (
    /api scope|not declared|requiredprivateinfos|not supported|接口.*(?:权限|未开通)/.test(message)
  )
    return "LOCATION_API_NOT_ALLOWED";
  if (
    /auth deny|auth denied|authorize.*deny|permission denied|^denied$|用户拒绝|拒绝授权/.test(
      message,
    )
  )
    return "LOCATION_PERMISSION_REQUIRED";
  if (/too frequent|frequency|频繁/.test(message)) return "LOCATION_RATE_LIMITED";
  if (/timeout|超时/.test(message)) return "LOCATION_TIMEOUT";
  return "LOCATION_UNAVAILABLE";
}

/** A native callback may never arrive; release the UI and ignore a late response. */
export function getCurrentLocation(timeoutMs = 20000) {
  return new Promise<WechatMiniprogram.GetLocationSuccessCallbackResult>((resolve, reject) => {
    let settled = false;
    const finish = (point?: WechatMiniprogram.GetLocationSuccessCallbackResult, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (point) resolve(point);
      else reject(new ClientError(code ?? "LOCATION_UNAVAILABLE"));
    };
    const timer = setTimeout(() => finish(undefined, "LOCATION_TIMEOUT"), timeoutMs);
    try {
      wx.getLocation({
        type: "gcj02",
        success: (point) => {
          if (
            Number.isFinite(point.latitude) &&
            Number.isFinite(point.longitude) &&
            Math.abs(point.latitude) <= 90 &&
            Math.abs(point.longitude) <= 180
          )
            finish(point);
          else finish(undefined, "LOCATION_INVALID");
        },
        fail: (error) => finish(undefined, locationErrorCode(error)),
      });
    } catch (error) {
      finish(undefined, locationErrorCode(error));
    }
  });
}

export function routeUnavailableMessage(reason?: string | null) {
  const messages: Record<string, string> = {
    DESTINATION_UNRESOLVED: "地点还不够具体，请补充城市和具体场所后再核对。",
    AMBIGUOUS_DESTINATION: "暂时不能唯一确定这个地点，请补充具体地址后再核对。",
    COARSE_DESTINATION: "这个地点范围较大，请先补充具体场所，当前不能核对往返路程。",
    TIMEOUT: "路线查询超时，原建议还在，可以重新核对。",
    QUOTA_EXCEEDED: "地图查询额度暂时不足，原建议还在，请稍后再试。",
    RATE_LIMITED: "地图查询有些频繁，原建议还在，请稍后再试。",
    NO_ROUTE: "地图暂未找到可用的往返路线，请确认目的地入口或在微信地图中核对。",
    ROUTE_TOO_CLOSE: "你与目的地距离很近，地图无需规划往返路线；请确认具体入口。",
    ROUTE_TOO_LONG: "目的地较远，已超出当前路线查询范围，请先确认跨城交通安排。",
    PROVIDER_REJECTED: "地点已保存，但地图暂未能规划这次路线；可重新核对或选择目的地的具体出入口。",
    PROVIDER_UNAVAILABLE: "地图服务暂时未响应，位置已取得，请稍后重新核对。",
    INVALID_RESPONSE: "地图返回的路线暂时无法核实，位置已取得，请稍后重新核对。",
    INVALID_LOCATION:
      "地图无法连接本次起点与目的地；请重新定位，或在地图中选择目的地的具体出入口。",
    LOOKUP_LIMIT: "本次尚未查询到这条心愿，请重新核对。",
    NOT_CONFIGURED: "路线服务暂时不可用，原建议还在。",
    ORIGIN_NOT_PRECISE: "还没有取得当前位置，请允许定位后重新核对。",
    AMBIGUOUS_ADDRESS: "暂时不能唯一确定这个地点，请补充具体地址后再核对。",
    CURRENTLY_BUSY: "当前已有正在进行的安排，结束后再核对新的出行。",
    NOT_GEOGRAPHIC: "这条心愿没有可核对的出行地点。",
  };
  return messages[reason ?? ""] ?? "暂时未能核实往返路线，原建议还在，可以重新核对。";
}
