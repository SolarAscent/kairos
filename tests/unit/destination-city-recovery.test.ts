import { describe, expect, it, vi } from "vitest";
import type { GeoPoint, LocationProvider, RouteEstimate } from "@life/integrations";
import { BuildDecisionContextService } from "../../apps/api/dist/context/build-decision-context.service.js";

const origin: GeoPoint = { latitude: 23.02, longitude: 113.85, coordinateSystem: "GCJ02" };
const destination: GeoPoint = { latitude: 23.01, longitude: 113.86, coordinateSystem: "GCJ02" };
const route: RouteEstimate = {
  durationSeconds: 600,
  distanceMeters: 1000,
  mode: "walking",
  provider: "TENCENT",
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 300000).toISOString(),
};
function setup() {
  const cityForLocation = vi.fn().mockResolvedValue({ ok: true, value: { city: "东莞市" } });
  const geocode = vi.fn(async (_address: string, city?: string) =>
    city === "东莞市"
      ? { ok: true as const, value: { location: destination, reliability: 9, level: 10 } }
      : { ok: false as const, reason: "AMBIGUOUS_ADDRESS" as const },
  );
  const provider: LocationProvider = {
    configured: true,
    cityForLocation,
    geocode,
    route: vi.fn().mockResolvedValue({ ok: true, value: route }),
  };
  return {
    provider,
    geocode,
    cityForLocation,
    service: new BuildDecisionContextService({} as never, provider),
  };
}
const context = { availableMinutes: 60, location: { ...origin, source: "DEVICE" as const } };
const school = { id: "school", title: "松山湖中心小学", kind: "PLACE", address: "松山湖中心小学" };

describe("request-local destination city recovery", () => {
  it("uses verified origin city to resolve an otherwise unscoped exact place and checks both journeys", async () => {
    const { service, geocode, cityForLocation, provider } = setup();
    const result = await service.enrichCandidates(context, [school]);
    expect(result.school).toMatchObject({
      status: "READY",
      destination,
      route: { returnDurationSeconds: 600 },
    });
    expect(geocode.mock.calls.map((call) => call[1])).toEqual([undefined, "东莞市"]);
    expect(cityForLocation).toHaveBeenCalledWith(origin, expect.any(AbortSignal));
    expect(provider.route).toHaveBeenCalledTimes(2);
    expect(context.location).not.toHaveProperty("city");
  });
  it("shares the city lookup within one query without permanently caching the user's origin", async () => {
    const { service, cityForLocation } = setup();
    await service.enrichCandidates(context, [school, { ...school, id: "other" }]);
    expect(cityForLocation).toHaveBeenCalledTimes(1);
    await service.enrichCandidates(context, [school]);
    expect(cityForLocation).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...school, city: "广州市" },
    { ...school, address: "广州市松山湖中心小学" },
    { ...school, address: "新疆天山公园" },
    { ...school, address: "广东省松山湖中心小学" },
    { ...school, address: "图书馆" },
  ])(
    "does not substitute current city for an explicit region or generic place: $address",
    async (candidate) => {
      const { service, cityForLocation, provider } = setup();
      const result = await service.enrichCandidates(context, [candidate]);
      expect(result.school).toMatchObject({ status: "UNAVAILABLE", reason: "AMBIGUOUS_ADDRESS" });
      expect(cityForLocation).not.toHaveBeenCalled();
      expect(provider.route).not.toHaveBeenCalled();
    },
  );
  it("does not mistake reverse lookup failure for a precise destination", async () => {
    const { service, cityForLocation, provider } = setup();
    cityForLocation.mockResolvedValue({ ok: false, reason: "TIMEOUT" });
    const result = await service.enrichCandidates(context, [school]);
    expect(result.school).toMatchObject({ status: "UNAVAILABLE", reason: "TIMEOUT" });
    expect(provider.route).not.toHaveBeenCalled();
  });
  it("does not spend calls on origin city when coordinates are absent or quota has failed", async () => {
    const { service, geocode, cityForLocation } = setup();
    await service.enrichCandidates({ availableMinutes: 60 }, [school]);
    expect(geocode).not.toHaveBeenCalled();
    geocode.mockResolvedValue({ ok: false, reason: "QUOTA_EXCEEDED" } as never);
    const result = await service.enrichCandidates(context, [school]);
    expect(result.school).toMatchObject({ reason: "QUOTA_EXCEEDED" });
    expect(cityForLocation).not.toHaveBeenCalled();
  });
});
