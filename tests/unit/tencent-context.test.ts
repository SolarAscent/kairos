import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  isGeoPoint,
  isVerifiedGeocodedPlace,
  TencentLbsAdapter,
  tencentSignature,
  type GeoPoint,
} from "@life/integrations";
import { deriveCalendar } from "../../apps/api/dist/context/build-decision-context.service.js";
const origin: GeoPoint = { latitude: 23.1, longitude: 113.3, coordinateSystem: "GCJ02" };
const destination: GeoPoint = { latitude: 23.2, longitude: 113.4, coordinateSystem: "GCJ02" };
function reply(result: unknown, status = 0) {
  return new Response(JSON.stringify({ status, result }));
}

describe("Tencent official REST adapter", () => {
  it("does not send requests without a configured key or valid GCJ02 coordinates", async () => {
    const fetch = vi.fn();
    expect(await new TencentLbsAdapter({}, fetch).route(origin, destination)).toEqual({
      ok: false,
      reason: "NOT_CONFIGURED",
    });
    expect(
      await new TencentLbsAdapter({ key: "test" }, fetch).route(
        { ...origin, coordinateSystem: "WGS84" } as never,
        destination,
      ),
    ).toEqual({ ok: false, reason: "INVALID_LOCATION" });
    expect(isGeoPoint({ ...origin, latitude: Number.NaN })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses exact lat,lng and converts route minutes to seconds, with no invented opening fields", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(reply({ routes: [{ distance: 1200, duration: 18.5 }] }));
    const result = await new TencentLbsAdapter({ key: "test" }, fetch).route(origin, destination);
    expect(result.ok && result.value.durationSeconds).toBe(1110);
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.origin).toBe("https://apis.map.qq.com");
    expect(url.pathname).toBe("/ws/direction/v1/walking/");
    expect(url.searchParams.get("from")).toBe("23.1,113.3");
    expect(url.searchParams.get("to")).toBe("23.2,113.4");
    expect(result.ok && Object.keys(result.value)).not.toContain("openingHours");
  });
  it("rejects geocoded city centroids and low-reliability matches", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(reply({ location: { lat: 23, lng: 113 }, reliability: 9, level: 1 }));
    const adapter = new TencentLbsAdapter({ key: "test" }, fetch);
    expect(await adapter.geocode("广东", "广州")).toEqual({
      ok: false,
      reason: "AMBIGUOUS_ADDRESS",
    });
    fetch.mockResolvedValue(reply({ location: { lat: 23, lng: 113 }, reliability: 6, level: 10 }));
    expect((await adapter.geocode("广州某书店", "广州")).ok).toBe(false);
    fetch.mockResolvedValue(
      reply({
        location: { lat: 23, lng: 113 },
        reliability: 9,
        level: 10,
        address_components: { city: "广州市", province: "广东省" },
      }),
    );
    const place = await adapter.geocode("广州某书店", "广州");
    expect(place.ok && place.value.location.coordinateSystem).toBe("GCJ02");
  });
  it("signs unencoded sorted values and sends encoded values with the original path", async () => {
    const params = {
      region: "广州",
      address: "图书馆&阅览室",
      output: "json",
      policy: "0",
      key: "test",
    };
    const expected = createHash("md5")
      .update(
        "/ws/geocoder/v1/?address=图书馆&阅览室&key=test&output=json&policy=0&region=广州test-secret",
      )
      .digest("hex");
    expect(tencentSignature("/ws/geocoder/v1/", params, "test-secret")).toBe(expected);
    const fetch = vi.fn().mockResolvedValue(reply({}));
    await new TencentLbsAdapter({ key: "test", secret: "test-secret" }, fetch).geocode(
      "图书馆&阅览室",
      "广州",
    );
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.searchParams.get("sig")).toBe(expected);
    expect(url.searchParams.get("address")).toBe("图书馆&阅览室");
    expect(fetch.mock.calls[0]![1].headers["x-legacy-url-decode"]).toBe("no");
  });
  it("bounds timeout even when a transport fails to honor AbortSignal", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    expect(
      await new TencentLbsAdapter({ key: "test", timeoutMs: 10 }, fetch).route(origin, destination),
    ).toEqual({ ok: false, reason: "TIMEOUT" });
  });
  it("keeps provider errors generic instead of leaking provider message/key/URL", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 190, message: "test-secret key=https://private" })),
      );
    expect(await new TencentLbsAdapter({ key: "test" }, fetch).route(origin, destination)).toEqual({
      ok: false,
      reason: "PROVIDER_REJECTED",
    });
  });
});

describe("conservative city-scoped POI fallback", () => {
  const venue = {
    id: "public-poi-1",
    title: "广州图书馆",
    address: "广东省广州市天河区珠江东路4号",
    type: 0,
    location: { lat: 23.11627, lng: 113.32604 },
    ad_info: { city: "广州市", province: "广东省", district: "天河区" },
  };
  function transport(rows: unknown[], count = rows.length) {
    return vi
      .fn()
      .mockResolvedValueOnce(
        reply({ location: { lat: 23.1, lng: 113.3 }, reliability: 3, level: 11 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 0, count, data: rows })));
  }
  it("uses exact unique POI with real provenance instead of forged geocoder precision", async () => {
    const fetch = transport([venue, { ...venue, id: "gate", title: "广州图书馆北门" }]);
    const place = await new TencentLbsAdapter({ key: "test", secret: "fixture-sk" }, fetch).geocode(
      "广州图书馆",
      "广州市",
    );
    expect(place.ok).toBe(true);
    if (!place.ok) return;
    expect(place.value.verificationMethod).toBe("POI_SEARCH");
    expect(place.value.reliability).toBeUndefined();
    expect(place.value.level).toBeUndefined();
    expect(place.value.poi).toMatchObject({
      id: venue.id,
      match: "EXACT_NAME",
      query: "广州图书馆",
      searchCity: "广州市",
      resultCount: 2,
    });
    expect(isVerifiedGeocodedPlace(place.value, { address: "广州图书馆", city: "广州" })).toBe(
      true,
    );
    const url = new URL(fetch.mock.calls[1]![0]);
    expect(url.pathname).toBe("/ws/place/v1/search");
    expect(url.searchParams.get("boundary")).toBe("region(广州市,0)");
    expect(url.searchParams.get("keyword")).toBe("广州图书馆");
    expect(url.searchParams.get("page_size")).toBe("20");
    const params = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "sig"));
    expect(url.searchParams.get("sig")).toBe(
      tencentSignature("/ws/place/v1/search", params, "fixture-sk"),
    );
  });
  it("keeps reliable geocoding unchanged with no search call", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        reply({ location: { lat: 23.11627, lng: 113.32604 }, reliability: 7, level: 11 }),
      );
    const place = await new TencentLbsAdapter({ key: "test" }, fetch).geocode(
      "广州市天河区广州图书馆",
      "广州市",
    );
    expect(place.ok && place.value.verificationMethod).toBe("GEOCODE");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not accept a reliable geocoder match from a conflicting explicitly supplied city", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        reply({
          location: { lat: 22.5, lng: 114.1 },
          reliability: 9,
          level: 11,
          address_components: { city: "深圳市" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 0, count: 1, data: [venue] })));
    const result = await new TencentLbsAdapter({ key: "test" }, fetch).geocode(
      "广州图书馆",
      "广州",
    );
    expect(result.ok && result.value.verificationMethod).toBe("POI_SEARCH");
    expect(result.ok && result.value.city).toBe("广州市");
    const conflicting = vi.fn().mockResolvedValue(
      reply({
        location: { lat: 22.5, lng: 114.1 },
        reliability: 9,
        level: 11,
        address_components: { city: "深圳市" },
      }),
    );
    expect(
      await new TencentLbsAdapter({ key: "test" }, conflicting).geocode("深圳图书馆", "广州市"),
    ).toEqual({ ok: false, reason: "AMBIGUOUS_ADDRESS" });
    expect(conflicting).toHaveBeenCalledTimes(1);
  });
  it("accepts exact complete address and only a query's explicit city when separate city is missing", async () => {
    for (const address of ["广州图书馆", venue.address]) {
      const place = await new TencentLbsAdapter({ key: "test" }, transport([venue])).geocode(
        address,
      );
      expect(place.ok).toBe(true);
      expect(place.ok && place.value.poi?.match).toBe(
        address === venue.address ? "EXACT_ADDRESS" : "EXACT_NAME",
      );
    }
    const unknown = transport([venue]);
    expect(await new TencentLbsAdapter({ key: "test" }, unknown).geocode("合成图书馆")).toEqual({
      ok: false,
      reason: "AMBIGUOUS_ADDRESS",
    });
    expect(unknown).toHaveBeenCalledTimes(1);
  });
  it("refuses incomplete pages, hidden possible matches, clusters and distinct duplicate exact POIs", async () => {
    for (const [rows, count] of [
      [[venue], 1111],
      [[venue], 21],
      [[venue], 2],
      [[venue, { ...venue, id: "other-exact" }], 2],
    ] as const)
      expect(
        await new TencentLbsAdapter({ key: "test" }, transport([...rows], count)).geocode(
          "广州图书馆",
          "广州",
        ),
      ).toEqual({ ok: false, reason: "AMBIGUOUS_ADDRESS" });
    const fetch = transport([venue]);
    fetch
      .mockReset()
      .mockResolvedValueOnce(
        reply({ location: { lat: 23.1, lng: 113.3 }, reliability: 3, level: 11 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 0, count: 1, data: [venue], cluster: [{}] })),
      );
    expect(
      await new TencentLbsAdapter({ key: "test" }, fetch).geocode("广州图书馆", "广州"),
    ).toEqual({ ok: false, reason: "AMBIGUOUS_ADDRESS" });
  });
  it("rejects cross-city, contradictory administrative scope, administrative POI, malformed/abnormal points", async () => {
    for (const row of [
      { ...venue, ad_info: { ...venue.ad_info, city: "深圳市" } },
      { ...venue, type: 4 },
      { ...venue, location: { lat: 0, lng: 0 } },
      { ...venue, location: { lat: 90, lng: 120 } },
      { ...venue, ad_info: { ...venue.ad_info, province: "海南省" } },
      { ...venue, ad_info: { ...venue.ad_info, district: "越秀区" } },
    ]) {
      const query = "广东省广州市天河区广州图书馆";
      const result = await new TencentLbsAdapter({ key: "test" }, transport([row])).geocode(
        query,
        "广州市",
      );
      expect(result).toEqual({ ok: false, reason: "AMBIGUOUS_ADDRESS" });
    }
    const conflicting = transport([venue]);
    expect(
      await new TencentLbsAdapter({ key: "test" }, conflicting).geocode("广州图书馆", "深圳市"),
    ).toEqual({ ok: false, reason: "AMBIGUOUS_ADDRESS" });
    expect(conflicting).toHaveBeenCalledTimes(1);
  });
  it("does not search generic categories or exceed the official UTF8 keyword limit", async () => {
    for (const address of [
      "图书馆",
      "附近的公园",
      "广州市",
      "广东省",
      "广州" + "合成".repeat(20),
    ]) {
      const fetch = transport([venue]);
      expect(await new TencentLbsAdapter({ key: "test" }, fetch).geocode(address, "广州")).toEqual({
        ok: false,
        reason: "AMBIGUOUS_ADDRESS",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    expect(
      await new TencentLbsAdapter(
        { key: "test" },
        transport([{ ...venue, title: "图书馆" }]),
      ).geocode("广东省广州市天河区图书馆", "广州"),
    ).toEqual({ ok: false, reason: "AMBIGUOUS_ADDRESS" });
  });
  it("propagates search quotas and cancellation, with no second attempt for nonambiguous failures", async () => {
    const fetch = transport([venue]);
    fetch
      .mockReset()
      .mockResolvedValueOnce(
        reply({ location: { lat: 23.1, lng: 113.3 }, reliability: 3, level: 11 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 121, message: "private-diagnostics" })),
      );
    expect(
      await new TencentLbsAdapter({ key: "test" }, fetch).geocode("广州图书馆", "广州"),
    ).toEqual({ ok: false, reason: "QUOTA_EXCEEDED" });
    const denied = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 190 })));
    expect(
      (await new TencentLbsAdapter({ key: "test" }, denied).geocode("广州图书馆", "广州")).ok,
    ).toBe(false);
    expect(denied).toHaveBeenCalledTimes(1);
    const abort = new AbortController();
    const cancelled = vi.fn().mockImplementation(async () => {
      abort.abort();
      return reply({ location: { lat: 23.1, lng: 113.3 }, reliability: 3, level: 11 });
    });
    expect(
      await new TencentLbsAdapter({ key: "test" }, cancelled).geocode(
        "广州图书馆",
        "广州",
        abort.signal,
      ),
    ).toEqual({ ok: false, reason: "TIMEOUT" });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});

describe("calendar budget from server time", () => {
  const now = new Date("2026-10-05T10:00:00Z");
  it("caps a declared hour at the next actual event, without inventing an event end", () => {
    expect(
      deriveCalendar([{ id: "next", startAt: "2026-10-05T10:20:00Z" }], now, 60),
    ).toMatchObject({ isBusy: false, effectiveAvailableMinutes: 20 });
  });
  it("merges overlapping current events and reports zero usable time", () => {
    const windows = [
      { id: "a", startAt: "2026-10-05T09:50:00Z", endAt: "2026-10-05T10:20:00Z" },
      { id: "b", startAt: "2026-10-05T10:15:00Z", endAt: "2026-10-05T10:40:00Z" },
    ];
    expect(deriveCalendar(windows, now, 60)).toMatchObject({
      isBusy: true,
      busyUntil: "2026-10-05T10:40:00.000Z",
      effectiveAvailableMinutes: 0,
    });
  });
  it("ignores expired, invalid and timezone-free dates", () => {
    expect(
      deriveCalendar(
        [
          { id: "old", startAt: "2026-10-05T08:00:00Z", endAt: "2026-10-05T09:00:00Z" },
          { id: "ambiguous", startAt: "2026-10-05T10:20:00" },
        ],
        now,
        15,
      ),
    ).toEqual({ isBusy: false, effectiveAvailableMinutes: 15, eventIds: [] });
  });
});
