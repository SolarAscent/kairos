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
  it("draws supplied route segments with distinct mode styles and fits all route bends without adding markers or invented connectors", () => {
    const response = result("DURATION_UNKNOWN");
    const segments = [
      {
        mode: "walking" as const,
        points: [
          { latitude: 23.1, longitude: 113.1 },
          { latitude: 23.15, longitude: 113.18 },
        ],
      },
      {
        mode: "bicycling" as const,
        points: [
          { latitude: 23.16, longitude: 113.19 },
          { latitude: 23.4, longitude: 113.5 },
          { latitude: 23.2, longitude: 113.2 },
        ],
      },
      {
        mode: "transit" as const,
        points: [
          { latitude: 23.21, longitude: 113.21 },
          { latitude: 23.25, longitude: 113.3 },
        ],
      },
    ];
    const view = createRouteView({
      ...response.routeCheck!,
      detail: {
        ...response.routeCheck!.detail!,
        origin: { latitude: 23.1, longitude: 113.1, coordinateSystem: "GCJ02" },
        destination: { latitude: 23.2, longitude: 113.2, coordinateSystem: "GCJ02" },
        destinationLabel: "书店",
        outwardSeconds: 900,
        returnSeconds: 1000,
        outwardMeters: 3000,
        returnMeters: 3100,
        segments,
      },
    });
    expect(view?.polyline.map((line) => line.points)).toEqual(
      segments.map((segment) => segment.points),
    );
    expect(view?.polyline.map((line) => line.dottedLine)).toEqual([true, false, false]);
    expect(view?.polyline.map((line) => line.arrowLine)).toEqual([false, true, true]);
    expect(new Set(view?.polyline.map((line) => line.color)).size).toBe(3);
    expect(view?.markers).toHaveLength(2);
    expect(view?.points).toEqual([
      { latitude: 23.1, longitude: 113.1 },
      { latitude: 23.2, longitude: 113.2 },
      ...segments.flatMap((segment) => segment.points),
    ]);
    expect(view?.points).toContainEqual({ latitude: 23.4, longitude: 113.5 });
    // Disconnected provider segments stay separate; no straight line bridges them.
    expect(view?.polyline).toHaveLength(segments.length);
  });
  it("keeps endpoint markers without drawing a fallback straight line when geometry is absent", () => {
    const response = result("DURATION_UNKNOWN");
    const detail = {
      ...response.routeCheck!.detail!,
      origin: { latitude: 23.1, longitude: 113.1, coordinateSystem: "GCJ02" as const },
      destination: { latitude: 23.2, longitude: 113.2, coordinateSystem: "GCJ02" as const },
      destinationLabel: "书店",
      outwardSeconds: 900,
      returnSeconds: 1000,
      outwardMeters: 3000,
      returnMeters: 3100,
    };
    for (const segments of [undefined, []]) {
      const view = createRouteView({ ...response.routeCheck!, detail: { ...detail, segments } });
      expect(view?.polyline).toEqual([]);
      expect(view?.points).toHaveLength(2);
      expect(view?.markers).toHaveLength(2);
    }
  });
  it.each([
    ["walking", "步行", undefined],
    ["bicycling", "骑行", undefined],
    ["transit", "路线", undefined],
    ["transit", "公交", "BUS"],
    ["transit", "地铁", "SUBWAY"],
    ["transit", "火车", "RAIL"],
    ["transit", "混合出行", "MIXED"],
  ] as const)(
    "shows only the selected %s mode and its verified outward duration",
    (mode, label, transitKind) => {
      const response = result("DURATION_UNKNOWN");
      const view = createRouteView({
        ...response.routeCheck!,
        detail: {
          ...response.routeCheck!.detail!,
          origin: { latitude: 23.1, longitude: 113.1, coordinateSystem: "GCJ02" },
          destination: { latitude: 23.2, longitude: 113.2, coordinateSystem: "GCJ02" },
          destinationLabel: "书店",
          mode,
          transitKind,
          selectionReason: transitKind === "BUS" ? "SCENIC_BUS_PREFERENCE" : "FASTEST_VERIFIED",
          observedAt: "2026-10-06T15:10:00.000Z",
          expiresAt: "2026-10-06T17:10:00.000Z",
          outwardSeconds: 901,
          returnSeconds: 1040,
          outwardMeters: 3000,
          returnMeters: 3100,
        },
      });
      expect(view?.durationText).toBe(`${label}约 16 分钟到达`);
      expect(view?.durationText).not.toContain("返程");
      expect(view?.durationText).not.toContain("公共交通");
      if (transitKind === "BUS") expect(view?.selectionText).toContain("看风景的偏好");
      else expect(view?.selectionText).toBe("");
      expect(view?.checkedAtText).toContain("2026-10-06");
      expect(view?.markers[0]?.callout.content).toBe("核对时的位置");
    },
  );
  it("does not treat a feasible time plan as verified venue opening or admission", () => {
    const response = result("");
    response.recommendation!.plan!.mode = "DO";
    expect(departureMessage(response)).toContain("时间安排符合当前条件");
    expect(departureMessage(response)).toContain("确认开放或入场要求");
    expect(departureMessage(response)).not.toContain("可以出发");
  });
});
