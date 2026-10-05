import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { isGeoPoint, TencentLbsAdapter, tencentSignature, type GeoPoint } from "@life/integrations";
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
