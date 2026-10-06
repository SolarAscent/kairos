import type { NowResponse, RouteCheck } from "@life/contracts";

export function departureMessage(result: NowResponse) {
  const detail = result.routeCheck?.detail;
  const candidate = result.candidates.find(
    (item) =>
      item.lifeObjectId === result.recommendation?.targetLifeObjectId && item.actionMode === "DO",
  );
  const blocker = detail?.departureBlocker ?? candidate?.filterReason;
  const required = detail?.requiredSeconds ?? candidate?.requiredSeconds;
  const available = detail?.availableSeconds;
  if (blocker === "TIME_LIMIT" || blocker === "TIME_WINDOW_LIMIT") {
    if (required != null && available != null)
      return `暂不适合出发：活动加往返至少需要约 ${Math.ceil(required / 60)} 分钟，当前可用约 ${Math.floor(available / 60)} 分钟。`;
    return "暂不适合出发：活动加往返所需时间超过当前可用时间。";
  }
  const messages: Record<string, string> = {
    DURATION_UNKNOWN: "往返路线已核对。你打算在那里待多久？确认停留时间后，就能核对完整安排。",
    CURRENTLY_BUSY: "暂不适合出发：已有正在进行的安排，请先完成或结束它。",
    BUDGET_LIMIT: "暂不适合出发：预计费用超过当前预算。",
    COST_UNKNOWN: "往返路线已核对。费用尚未确认，补充预计费用后就能核对当前预算。",
    NOT_GOING_OUT: "暂不适合出发：你当前选择了不外出。",
    EVENT_CONFLICT: "暂不适合出发：活动与已有日程冲突。",
    LONG_TERM_GOAL: "暂不适合出发：这是一项长期目标，需要先确定本次具体行动。",
    NOT_STARTED: "暂不适合出发：活动的可用时间尚未开始。",
    UNAVAILABLE: "暂不适合出发：已有活动信息标记为当前不可用，请先核实可参与时间。",
    BOOKING_UNCONFIRMED: "往返路线已核对。预约尚未确认，请先确认预约结果。",
    ADMISSION_UNCONFIRMED: "往返路线已核对。入场条件尚未确认，请先核实。",
    REGION_REQUIRES_TRAVEL: "暂不适合出发：目的地涉及跨地区出行，需要先确认交通安排。",
    ROUTE_UNVERIFIED: "暂不适合出发：本次活动的往返路线还没有核实。",
    EXPIRED: "暂不适合出发：已记录的活动时间已经结束，请先确认新的时间。",
  };
  if (blocker)
    return messages[blocker] ?? "往返路线已核对。还有出行条件尚未确认，请先完善本次安排。";
  return result.recommendation?.plan?.mode === "DO"
    ? "往返路线已核对，时间安排符合当前条件。出发前请确认开放或入场要求。"
    : "往返路线已核对；本次建议先完成准备步骤。";
}

export function createRouteView(check: RouteCheck | null | undefined) {
  const detail = check?.status === "READY" ? check.detail : undefined;
  if (!detail) return null;
  const points = [detail.origin, detail.destination].map(({ latitude, longitude }) => ({
    latitude,
    longitude,
  }));
  return {
    destinationLabel: detail.destinationLabel,
    latitude: detail.destination.latitude,
    longitude: detail.destination.longitude,
    points,
    markers: points.map((point, index) => ({
      ...point,
      id: index + 1,
      iconPath: index === 0 ? "/assets/map-origin.png" : "/assets/map-destination.png",
      width: 24,
      height: 30,
      callout: {
        content: index === 0 ? "当前位置" : detail.destinationLabel,
        display: "ALWAYS",
        color: "#233C35",
        bgColor: "#FFFFFF",
        fontSize: 11,
        borderRadius: 5,
        padding: 5,
      },
    })),
    durationText: `步行去程约 ${Math.ceil(detail.outwardSeconds / 60)} 分钟 · 返程约 ${Math.ceil(detail.returnSeconds / 60)} 分钟`,
  };
}
