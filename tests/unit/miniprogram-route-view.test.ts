import { describe, expect, it } from "vitest";
import type { NowResponse } from "@life/contracts";
import { createRouteView, departureMessage } from "../../apps/miniprogram/src/lib/route-view";

function result(
  blocker: string,
  requiredSeconds: number | null = null,
  availableSeconds: number | null = null,
) {
  return {
    recommendation: { targetLifeObjectId: "target", plan: { mode: "PREPARE" } },
    routeCheck: {
      status: "READY",
      reason: null,
      detail: { departureBlocker: blocker, requiredSeconds, availableSeconds },
    },
    candidates: [],
  } as unknown as NowResponse;
}

describe("route interpretation", () => {
  it("compares the original complete activity duration against the actual available window", () => {
    expect(departureMessage(result("TIME_LIMIT", 5400, 1800))).toContain(
      "至少需要约 90 分钟，当前可用约 30 分钟",
    );
    expect(departureMessage(result("TIME_WINDOW_LIMIT", 5400))).not.toContain("可用约");
  });
  it("distinguishes duration, reservation and cost gaps without inventing opening hours", () => {
    expect(departureMessage(result("DURATION_UNKNOWN"))).toContain("你打算在那里待多久");
    for (const blocker of [
      "DURATION_UNKNOWN",
      "BOOKING_UNCONFIRMED",
      "ADMISSION_UNCONFIRMED",
      "COST_UNKNOWN",
    ])
      expect(departureMessage(result(blocker))).not.toContain("暂不适合出发");
    expect(departureMessage(result("BOOKING_UNCONFIRMED"))).toContain("预约尚未确认");
    expect(departureMessage(result("COST_UNKNOWN"))).toContain("费用尚未确认");
    expect(departureMessage(result("UNAVAILABLE"))).not.toContain("闭馆");
  });
  it("never builds map coordinates from unavailable or historical checks without fresh detail", () => {
    expect(createRouteView({ status: "READY", reason: null })).toBeNull();
    expect(createRouteView({ status: "UNAVAILABLE", reason: "TIMEOUT" })).toBeNull();
  });
  it("does not treat a feasible time plan as verified venue opening or admission", () => {
    const response = result("");
    response.recommendation!.plan!.mode = "DO";
    expect(departureMessage(response)).toContain("时间安排符合当前条件");
    expect(departureMessage(response)).toContain("确认开放或入场要求");
    expect(departureMessage(response)).not.toContain("可以出发");
  });
});
