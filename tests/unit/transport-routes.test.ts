import { describe, expect, it, vi } from "vitest";
import {
  TencentLbsAdapter,
  type GeoPoint,
  type LocationProvider,
  type RouteEstimate,
  type RouteMode,
} from "@life/integrations";
import { selectRouteForWindow, planActions } from "@life/domain";
import { BuildDecisionContextService } from "../../apps/api/dist/context/build-decision-context.service.js";

const origin: GeoPoint = { latitude: 23.1, longitude: 113.3, coordinateSystem: "GCJ02" };
const destination: GeoPoint = { latitude: 23.2, longitude: 113.4, coordinateSystem: "GCJ02" };
const transitStep = (vehicle = "BUS", duration = 10, running_status = 300) => ({
  mode: "TRANSIT",
  lines: [{ vehicle, duration, running_status }],
});
const response = (routes: unknown[]) =>
  new Response(JSON.stringify({ status: 0, result: { routes } }));
const estimate = (
  mode: RouteMode,
  durationSeconds: number,
  extra: Partial<RouteEstimate> = {},
): RouteEstimate => ({
  mode,
  durationSeconds,
  distanceMeters: 1000,
  provider: "TENCENT",
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 300000).toISOString(),
  costMinor: mode === "walking" ? 0 : mode === "transit" ? 200 : null,
  ...extra,
});
const target = {
  id: "target",
  title: "图书馆",
  kind: "PLACE",
  location: destination,
  activitySeconds: 600,
  activityCostMinor: 0,
};
const context = {
  availableMinutes: 60,
  budgetMinor: 10000,
  location: { ...origin, source: "DEVICE" as const },
};

describe("real Tencent transport modes", () => {
  it("uses bicycling endpoint without inventing bicycle-rental price", async () => {
    const transport = vi.fn().mockResolvedValue(response([{ distance: 4000, duration: 18.5 }]));
    const result = await new TencentLbsAdapter({ key: "synthetic" }, transport).routeForMode(
      origin,
      destination,
      "bicycling",
    );
    expect(new URL(transport.mock.calls[0]![0]).pathname).toBe("/ws/direction/v1/bicycling/");
    expect(result).toMatchObject({
      ok: true,
      value: { mode: "bicycling", durationSeconds: 1110, costMinor: null },
    });
  });
  it("requests real scheduled transit, unified minor-unit fare and no driving fallback", async () => {
    const transport = vi.fn().mockResolvedValue(
      response([
        {
          distance: 6000,
          duration: 25.5,
          price: 500,
          steps: [{ mode: "WALKING" }, transitStep("BUS", 8), transitStep("SUBWAY", 12)],
        },
      ]),
    );
    const time = new Date("2026-10-06T04:20:00Z");
    const result = await new TencentLbsAdapter({ key: "synthetic" }, transport).routeForMode(
      origin,
      destination,
      "transit",
      undefined,
      time,
    );
    const url = new URL(transport.mock.calls[0]![0]);
    expect(url.pathname).toBe("/ws/direction/v1/transit/");
    expect(url.searchParams.get("departure_time")).toBe(String(time.getTime() / 1000));
    expect(url.searchParams.get("price_unit")).toBe("1");
    expect(url.searchParams.get("driving_estimate")).toBe("0");
    expect(result).toMatchObject({
      ok: true,
      value: {
        mode: "transit",
        durationSeconds: 1530,
        costMinor: 500,
        transitKind: "SUBWAY",
        transitDurations: { BUS: 480, SUBWAY: 720 },
      },
    });
  });
  it.each([
    { steps: [{ mode: "WALKING" }] },
    { steps: [{ mode: "DRIVING" }] },
    { steps: [transitStep("BUS", 10, 301)] },
    { steps: [transitStep("SUBWAY", 10, 302)] },
    { steps: [transitStep("BUS", 10, 303)] },
    { steps: [{ mode: "TRANSIT", lines: [{ vehicle: "BUS", duration: 10 }] }] },
  ])(
    "rejects transit without normal operating public-transport evidence: %j",
    async ({ steps }) => {
      const transport = vi
        .fn()
        .mockResolvedValue(response([{ distance: 1000, duration: 10, price: 200, steps }]));
      expect(
        await new TencentLbsAdapter({ key: "synthetic" }, transport).routeForMode(
          origin,
          destination,
          "transit",
        ),
      ).toEqual({ ok: false, reason: "INVALID_RESPONSE" });
    },
  );
  it("rejects driving-estimate transit and does not fabricate missing fare", async () => {
    const transport = vi.fn().mockResolvedValue(
      response([
        {
          distance: 1000,
          duration: 10,
          price: 200,
          is_driving_estimate: 1,
          steps: [transitStep()],
        },
      ]),
    );
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, transport);
    expect((await adapter.routeForMode(origin, destination, "transit")).ok).toBe(false);
    transport.mockResolvedValue(
      response([{ distance: 1000, duration: 10, price: -1, steps: [transitStep()] }]),
    );
    expect(await adapter.routeForMode(origin, destination, "transit")).toMatchObject({
      ok: true,
      value: { costMinor: null, transitKind: "BUS" },
    });
  });
  it("selects the fastest normal provider route and enforces NO_SUBWAY rather than relabeling subway", async () => {
    const transport = vi.fn().mockImplementation(async () =>
      response([
        { distance: 1000, duration: 20, price: 200, steps: [transitStep("BUS", 16)] },
        { distance: 1000, duration: 12, price: 300, steps: [transitStep("SUBWAY", 8)] },
      ]),
    );
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, transport);
    expect(await adapter.routeForMode(origin, destination, "transit")).toMatchObject({
      ok: true,
      value: { transitKind: "SUBWAY", durationSeconds: 720 },
    });
    expect(
      await adapter.routeForMode(origin, destination, "transit", undefined, new Date(), {
        avoidSubway: true,
      }),
    ).toMatchObject({ ok: true, value: { transitKind: "BUS", durationSeconds: 1200 } });
    expect(new URL(transport.mock.calls[1]![0]).searchParams.get("policy")).toBe(
      "LEAST_TIME,NO_SUBWAY",
    );
  });
});

const option = (
  mode: string,
  seconds: number,
  costMinor: number | null = 0,
  transitKind?: string,
) => ({ mode, durationSeconds: seconds, returnDurationSeconds: seconds, costMinor, transitKind });
describe("time-aware transport selection", () => {
  it("prefers short walking only when activity and both directions fit", () => {
    const routes = [option("walking", 600), option("transit", 420, 500)];
    expect(selectRouteForWindow(routes, 600, 1800, 10000)?.reason).toBe("WALKING_FITS");
    expect(selectRouteForWindow(routes, 600, 1500, 10000)?.route.mode).toBe("transit");
  });
  it("chooses faster verified transport instead of a long walk that happens to fit", () => {
    expect(
      selectRouteForWindow(
        [option("walking", 4020), option("transit", 1200, 500)],
        600,
        10800,
        10000,
      ),
    ).toMatchObject({ route: { mode: "transit" }, reason: "FASTER_MODE_FITS" });
  });
  it("does not treat unknown bicycle fees or unaffordable transit as zero within a budget", () => {
    expect(
      selectRouteForWindow(
        [option("walking", 1200), option("bicycling", 300, null), option("transit", 500, 600)],
        600,
        1800,
        0,
      ),
    ).toMatchObject({ route: { mode: "walking" }, reason: "NO_MODE_FITS" });
  });
  it("keeps unknown duration/window as a transport reference, never proof that the full action fits", () => {
    expect(
      selectRouteForWindow(
        [option("walking", 1200), option("bicycling", 300, null)],
        null,
        600,
        null,
      )?.reason,
    ).toBe("FASTEST_VERIFIED");
    expect(selectRouteForWindow([option("walking", 1200)], 600, null, null)?.reason).toBe(
      "FASTEST_VERIFIED",
    );
  });
  it("uses scenery preference only for a feasible bus within both 10 minutes and 20 percent", () => {
    const routes = [option("transit", 1000, 500, "SUBWAY"), option("transit", 1100, 400, "BUS")];
    expect(selectRouteForWindow(routes, 600, 3600, 10000, true)).toMatchObject({
      route: { transitKind: "BUS" },
      reason: "SCENIC_BUS_PREFERENCE",
    });
    expect(selectRouteForWindow(routes, 600, 2700, 10000, true)?.route.transitKind).toBe("SUBWAY");
    expect(selectRouteForWindow(routes, 600, 3600, 10000, false)?.route.transitKind).toBe("SUBWAY");
    expect(
      selectRouteForWindow(
        [routes[0]!, option("transit", 1300, 400, "BUS")],
        600,
        4000,
        10000,
        true,
      )?.route.transitKind,
    ).toBe("SUBWAY");
    expect(
      selectRouteForWindow(
        [option("transit", 3000, 500, "SUBWAY"), option("transit", 3400, 400, "BUS")],
        600,
        8000,
        10000,
        true,
      )?.route.transitKind,
    ).toBe("SUBWAY");
  });
});

describe("bounded real round-trip comparisons", () => {
  it("retains verified walking at the shared deadline even when alternate transports ignore cancellation", async () => {
    vi.useFakeTimers();
    try {
      const provider: LocationProvider = {
        configured: true,
        geocode: vi.fn(),
        route: vi.fn(),
        routeForMode: async (_from, _to, mode) =>
          mode === "walking" ? { ok: true, value: estimate(mode, 1200) } : new Promise(() => {}),
      };
      const pending = new BuildDecisionContextService({} as never, provider).enrichCandidates(
        context,
        [target],
        { compareModesForId: target.id },
      );
      await vi.advanceTimersByTimeAsync(4000);
      const result = (await pending)[target.id]!;
      expect(result).toMatchObject({
        status: "READY",
        route: { mode: "walking", comparisonComplete: false },
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("makes six focused calls and schedules the transit return after outward travel and activity", async () => {
    const calls: Array<{ mode: RouteMode; from: GeoPoint; time: Date }> = [];
    const provider: LocationProvider = {
      configured: true,
      geocode: vi.fn(),
      route: vi.fn(),
      routeForMode: async (from, to, mode, _signal, time) => {
        calls.push({ mode, from, time: time! });
        const durations = { walking: 4020, bicycling: 2000, transit: 900 };
        return {
          ok: true,
          value: estimate(mode, durations[mode], {
            ...(mode === "transit"
              ? { transitKind: "SUBWAY", transitDurations: { SUBWAY: 600 } }
              : {}),
          }),
        };
      },
    };
    const result = (
      await new BuildDecisionContextService({} as never, provider).enrichCandidates(
        context,
        [target],
        { compareModesForId: target.id },
      )
    )[target.id]!;
    expect(calls).toHaveLength(6);
    expect(result.route).toMatchObject({
      mode: "transit",
      transitKind: "SUBWAY",
      durationSeconds: 900,
      returnDurationSeconds: 900,
      costMinor: 400,
      returnTimingVerified: true,
      comparisonComplete: true,
    });
    const transit = calls.filter((call) => call.mode === "transit");
    expect(transit[1]!.time.getTime() - transit[0]!.time.getTime()).toBe(1500000);
    expect(transit[1]!.from).toEqual(destination);
  });
  it("does not promote a successful one-way mode when the return fails or when another mode exceeds quota", async () => {
    const calls: RouteMode[] = [];
    const provider: LocationProvider = {
      configured: true,
      geocode: vi.fn(),
      route: vi.fn(),
      routeForMode: async (from, to, mode) => {
        calls.push(mode);
        if (mode === "bicycling" && from.latitude === destination.latitude)
          return { ok: false, reason: "PROVIDER_REJECTED" };
        if (mode === "transit") return { ok: false, reason: "QUOTA_EXCEEDED" };
        return { ok: true, value: estimate(mode, mode === "walking" ? 1200 : 300) };
      },
    };
    const result = (
      await new BuildDecisionContextService({} as never, provider).enrichCandidates(
        context,
        [target],
        { compareModesForId: target.id },
      )
    )[target.id]!;
    expect(calls).toHaveLength(5);
    expect(result.route).toMatchObject({ mode: "walking", comparisonComplete: false });
    calls.length = 0;
    provider.routeForMode = async (_from, _to, mode) => {
      calls.push(mode);
      return mode === "transit"
        ? { ok: false, reason: "QUOTA_EXCEEDED" }
        : { ok: true, value: estimate(mode, mode === "walking" ? 1200 : 300) };
    };
    const availableBike = (
      await new BuildDecisionContextService({} as never, provider).enrichCandidates(
        { ...context, budgetMinor: undefined },
        [target],
        { compareModesForId: target.id },
      )
    )[target.id]!;
    expect(availableBike.route).toMatchObject({ mode: "bicycling", comparisonComplete: false });
    expect(calls).toHaveLength(5);
  });
  it("preserves the ten-call walking budget in ordinary five-target Now enrichment", async () => {
    const calls: RouteMode[] = [];
    const provider: LocationProvider = {
      configured: true,
      geocode: vi.fn(),
      route: vi.fn(),
      routeForMode: async (_from, _to, mode) => {
        calls.push(mode);
        return { ok: true, value: estimate(mode, 60) };
      },
    };
    await new BuildDecisionContextService({} as never, provider).enrichCandidates(
      context,
      Array.from({ length: 5 }, (_, i) => ({ ...target, id: String(i) })),
    );
    expect(calls).toEqual(Array(10).fill("walking"));
  });
  it("adds at most one bus-only round trip for scenery and uses it only when all hard conditions fit", async () => {
    const calls: Array<{ mode: RouteMode; avoid?: boolean }> = [];
    const provider: LocationProvider = {
      configured: true,
      geocode: vi.fn(),
      route: vi.fn(),
      routeForMode: async (_from, _to, mode, _signal, _at, options) => {
        calls.push({ mode, avoid: options?.avoidSubway });
        return {
          ok: true,
          value: estimate(
            mode,
            mode === "walking"
              ? 4020
              : mode === "bicycling"
                ? 2000
                : options?.avoidSubway
                  ? 1100
                  : 1000,
            {
              ...(mode === "transit"
                ? {
                    transitKind: options?.avoidSubway ? "BUS" : "SUBWAY",
                    transitDurations: options?.avoidSubway ? { BUS: 900 } : { SUBWAY: 800 },
                  }
                : {}),
            },
          ),
        };
      },
    };
    const result = (
      await new BuildDecisionContextService({} as never, provider).enrichCandidates(
        context,
        [target],
        { compareModesForId: target.id, preferScenicBus: true },
      )
    )[target.id]!;
    expect(calls).toHaveLength(8);
    expect(calls.filter((call) => call.avoid)).toHaveLength(2);
    expect(result.route).toMatchObject({
      mode: "transit",
      transitKind: "BUS",
      selectionReason: "SCENIC_BUS_PREFERENCE",
      comparisonComplete: true,
    });
  });
  it("keeps unknown-visit transit return as a reference and does not loosen direct duration or budget blockers", async () => {
    const provider: LocationProvider = {
      configured: true,
      geocode: vi.fn(),
      route: vi.fn(),
      routeForMode: async (_from, _to, mode) =>
        mode === "bicycling"
          ? { ok: false, reason: "PROVIDER_REJECTED" }
          : {
              ok: true,
              value: estimate(mode, mode === "walking" ? 4020 : 600, {
                ...(mode === "transit"
                  ? { transitKind: "BUS", transitDurations: { BUS: 500 } }
                  : {}),
              }),
            },
    };
    const result = (
      await new BuildDecisionContextService({} as never, provider).enrichCandidates(
        { ...context, budgetMinor: undefined },
        [{ ...target, activitySeconds: null }],
        { compareModesForId: target.id, preferScenicBus: true },
      )
    )[target.id]!;
    expect(result.route).toMatchObject({
      mode: "transit",
      returnTimingVerified: false,
      selectionReason: "FASTEST_VERIFIED",
    });
    const candidate = {
      id: "goal",
      title: "图书馆",
      summary: null,
      kind: "PLACE",
      importance: 1,
      createdAt: new Date(),
      expiresAt: null,
      costMinMinor: null,
      costMaxMinor: null,
      durationMinSeconds: null,
      ...destination,
      route: { ...result.route!, verification: "PROVIDER_VERIFIED" as const },
      actionFacts: [
        {
          origin: "USER_STATED" as const,
          evidence: "想去图书馆",
          activityKind: "LOCAL_OUTING" as const,
          duration: null,
          money: { role: "COST" as const, currency: "CNY", minMinor: 0 },
        },
      ],
    };
    const actions = planActions(candidate, { ...context, budgetMinor: undefined });
    expect(actions.find((action) => action.actionMode === "DO")?.filterReason).toBe(
      "DURATION_UNKNOWN",
    );
    expect(actions.find((action) => action.actionMode === "PREPARE")?.reasonText).toContain(
      "返程公交目前仅为参考",
    );
    const known = {
      ...candidate,
      actionFacts: [
        {
          ...candidate.actionFacts[0]!,
          duration: { role: "REQUIRED" as const, minSeconds: 600 },
          money: { role: "COST" as const, currency: "CNY", minMinor: 1000 },
        },
      ],
      route: { ...candidate.route, mode: "bicycling", costMinor: null, returnTimingVerified: true },
    };
    expect(
      planActions(known, { ...context, budgetMinor: 0 }).find(
        (action) => action.actionMode === "DO",
      )?.filterReason,
    ).toBe("BUDGET_LIMIT");
    expect(
      planActions(
        {
          ...known,
          actionFacts: [
            { ...known.actionFacts[0]!, money: { role: "COST", currency: "CNY", minMinor: 0 } },
          ],
        },
        { ...context, budgetMinor: 1000 },
      ).find((action) => action.actionMode === "DO")?.filterReason,
    ).toBe("COST_UNKNOWN");
  });
});
