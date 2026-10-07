import { describe, expect, it, vi } from "vitest";
import { TencentLbsAdapter, canUseOriginCityForAddress, type GeoPoint } from "@life/integrations";
import { routeCheckSchema } from "@life/contracts";

const origin: GeoPoint = { latitude: 23.1, longitude: 113.3, coordinateSystem: "GCJ02" };
const destination: GeoPoint = { latitude: 23.2, longitude: 113.4, coordinateSystem: "GCJ02" };
const response = (status: number, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ status, message: "private-key=https://private", ...extra }));
const school = {
  id: "school-1",
  title: "松山湖中心小学",
  address: "广东省东莞市松山湖中心区",
  type: 0,
  location: { lat: 23.2, lng: 113.4 },
  ad_info: { city: "东莞市", province: "广东省", district: "" },
};

describe("Tencent official route status meanings", () => {
  it("diagnoses a rejection without leaking provider messages, URLs or location", async () => {
    const observe = vi.fn();
    const adapter = new TencentLbsAdapter(
      { key: "private-credential", onProviderStatus: observe },
      async () => response(190, { location: origin, url: "https://private" }),
    );
    expect(await adapter.route(origin, destination)).toEqual({
      ok: false,
      reason: "PROVIDER_REJECTED",
    });
    expect(observe.mock.calls).toEqual([[{ operation: "walking", status: 190 }]]);
  });
  it("keeps the provider result when diagnostics fail", async () => {
    const adapter = new TencentLbsAdapter(
      {
        key: "synthetic",
        onProviderStatus: () => {
          throw new Error("observer failed");
        },
      },
      async () => response(121),
    );
    expect(await adapter.route(origin, destination)).toEqual({
      ok: false,
      reason: "QUOTA_EXCEEDED",
    });
  });
  it.each([
    [326, "ROUTE_TOO_CLOSE"],
    ...[327, 328, 329, 335, 344, 377, 378, 379, 384].map((status) => [status, "NO_ROUTE"]),
    [373, "ROUTE_TOO_LONG"],
    [374, "INVALID_LOCATION"],
    [500, "TIMEOUT"],
    ...[510, 520, 530, 531, 599].map((status) => [status, "PROVIDER_UNAVAILABLE"]),
    [120, "RATE_LIMITED"],
    [121, "QUOTA_EXCEEDED"],
    [348, "PROVIDER_REJECTED"],
    [190, "PROVIDER_REJECTED"],
  ])("maps numeric status %s to %s without raw provider details", async (status, reason) => {
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, async () =>
      response(Number(status)),
    );
    const result = await adapter.route(origin, destination);
    expect(result).toEqual({ ok: false, reason });
    expect(routeCheckSchema.safeParse({ status: "UNAVAILABLE", reason }).success).toBe(true);
  });
  it("keeps malformed successful transit distinct from a provider no-route status", async () => {
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, async () =>
      response(0, { result: { routes: [{ distance: 1000, duration: 10, steps: [] }] } }),
    );
    expect(await adapter.routeForMode(origin, destination, "transit")).toEqual({
      ok: false,
      reason: "INVALID_RESPONSE",
    });
  });
});

describe("missing-city geocoder recovery", () => {
  it.each([347, 348])("uses a unique exact scoped POI after geocode status %s", async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response(0, { count: 1, data: [school] }));
    const found = await new TencentLbsAdapter({ key: "synthetic" }, fetch).geocode(
      "松山湖中心小学",
      "东莞市",
    );
    expect(found).toMatchObject({
      ok: true,
      value: { verificationMethod: "POI_SEARCH", city: "东莞市", poi: { id: "school-1" } },
    });
    const url = new URL(fetch.mock.calls[1]![0]);
    expect(url.pathname).toBe("/ws/place/v1/search");
    expect(url.searchParams.get("boundary")).toBe("region(东莞市,0)");
    expect(url.searchParams.get("keyword")).toBe("松山湖中心小学");
  });
  it.each([347, 348])("never guesses city after status %s without scope", async (status) => {
    const fetch = vi.fn().mockResolvedValue(response(status));
    expect(
      await new TencentLbsAdapter({ key: "synthetic" }, fetch).geocode("松山湖中心小学"),
    ).toEqual({ ok: false, reason: "AMBIGUOUS_ADDRESS" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { rows: [school, { ...school, id: "school-2" }] },
    { rows: [{ ...school, title: "松山湖第二小学" }] },
    { rows: [{ ...school, ad_info: { city: "深圳市", province: "广东省" } }] },
  ])("rejects ambiguous, fuzzy or cross-city POIs", async ({ rows }) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(348))
      .mockResolvedValueOnce(response(0, { count: rows.length, data: rows }));
    expect(
      await new TencentLbsAdapter({ key: "synthetic" }, fetch).geocode("松山湖中心小学", "东莞市"),
    ).toEqual({ ok: false, reason: "AMBIGUOUS_ADDRESS" });
  });
  it("does not recurse or reclassify a search parameter rejection", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(348)).mockResolvedValueOnce(response(348));
    expect(
      await new TencentLbsAdapter({ key: "synthetic" }, fetch).geocode("松山湖中心小学", "东莞市"),
    ).toEqual({ ok: false, reason: "PROVIDER_REJECTED" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("provider-observed city lookup", () => {
  it("requests GCJ02 reverse geocoding without POIs and reads only address_component.city", async () => {
    const fetch = vi.fn().mockResolvedValue(
      response(0, {
        result: { address_component: { city: "东莞市", province: "广东省" }, address: "private" },
      }),
    );
    expect(
      await new TencentLbsAdapter({ key: "synthetic" }, fetch).cityForLocation(origin),
    ).toEqual({ ok: true, value: { city: "东莞市" } });
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.pathname).toBe("/ws/geocoder/v1/");
    expect(url.searchParams.get("location")).toBe("23.1,113.3");
    expect(url.searchParams.get("get_poi")).toBe("0");
    expect(url.searchParams.has("address")).toBe(false);
  });
  it.each(["阿里地区", "阿坝藏族羌族自治州", "香港特别行政区"])(
    "accepts valid city-level administrative name %s returned by the provider",
    async (city) => {
      const adapter = new TencentLbsAdapter({ key: "synthetic" }, async () =>
        response(0, {
          result: { address_component: { city } },
        }),
      );
      expect(await adapter.cityForLocation(origin)).toEqual({ ok: true, value: { city } });
    },
  );
  it.each([undefined, "", "广东省", "广东", "南山区", "https://private", "23.1,113.3", 123])(
    "rejects missing or malformed city %s without province substitution",
    async (city) => {
      const fetch = vi.fn().mockResolvedValue(
        response(0, {
          result: { address_component: { city, province: "广东省" }, ad_info: { city: "东莞市" } },
        }),
      );
      expect(
        await new TencentLbsAdapter({ key: "synthetic" }, fetch).cityForLocation(origin),
      ).toEqual({ ok: false, reason: "INVALID_RESPONSE" });
    },
  );
  it("refuses unconfigured/invalid coordinates and bounds a stuck response", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    expect(await new TencentLbsAdapter({}, fetch).cityForLocation(origin)).toEqual({
      ok: false,
      reason: "NOT_CONFIGURED",
    });
    expect(
      await new TencentLbsAdapter({ key: "synthetic" }, fetch).cityForLocation({
        ...origin,
        latitude: 91,
      }),
    ).toEqual({ ok: false, reason: "INVALID_LOCATION" });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await new TencentLbsAdapter({ key: "synthetic", timeoutMs: 10 }, fetch).cityForLocation(
        origin,
      ),
    ).toEqual({ ok: false, reason: "TIMEOUT" });
  });
  it("preserves quota and cancellation errors without retrying", async () => {
    const fetch = vi.fn().mockResolvedValue(response(121));
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, fetch);
    expect(await adapter.cityForLocation(origin)).toEqual({ ok: false, reason: "QUOTA_EXCEEDED" });
    const abort = new AbortController();
    abort.abort();
    expect(await adapter.cityForLocation(origin, abort.signal)).toEqual({
      ok: false,
      reason: "TIMEOUT",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("origin-city assistance boundaries", () => {
  it.each(["松山湖中心小学", "星光书店"])(
    "allows only unqualified specific venues: %s",
    (address) => {
      expect(canUseOriginCityForAddress(address)).toBe(true);
    },
  );
  it.each([
    "",
    "学校",
    "附近学校",
    "任意一家书店",
    "广东",
    "广东松山湖中心小学",
    "新疆星光书店",
    "西藏某小学",
    "内蒙古星光书店",
    "北京市星光书店",
    "东莞松山湖中心小学",
    "广东省松山湖中心小学",
    "广西壮族自治区某小学",
    "香港特别行政区某小学",
    "南山区星光书店",
    "阳山县某小学",
    "阿坝藏族羌族自治州某小学",
    "阿里地区某小学",
    "松山湖中心区小学",
  ])("does not reinterpret explicit regions or generic venue %s", (address) => {
    expect(canUseOriginCityForAddress(address)).toBe(false);
  });
  it("preserves an existing supplied city and rejects overlong input", () => {
    expect(canUseOriginCityForAddress("松山湖中心小学", "东莞市")).toBe(false);
    expect(canUseOriginCityForAddress("书".repeat(241))).toBe(false);
  });
});
