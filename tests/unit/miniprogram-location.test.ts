import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCurrentLocation,
  locationErrorCode,
  routeUnavailableMessage,
} from "../../apps/miniprogram/src/lib/location";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("native location acquisition", () => {
  it("bounds a missing native callback and ignores a late success", async () => {
    vi.useFakeTimers();
    let success: any;
    vi.stubGlobal("wx", {
      getLocation: (options: any) => {
        success = options.success;
      },
    });
    const pending = getCurrentLocation();
    const check = expect(pending).rejects.toMatchObject({ code: "LOCATION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20000);
    await check;
    success({ latitude: 23.1, longitude: 113.2 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses GCJ02, rejects invalid coordinates, and clears the deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("wx", {
      getLocation: (options: any) => {
        expect(options.type).toBe("gcj02");
        options.success({ latitude: NaN, longitude: 113 });
      },
    });
    await expect(getCurrentLocation()).rejects.toMatchObject({ code: "LOCATION_INVALID" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains separate permission, platform, system and network diagnoses", () => {
    expect(locationErrorCode({ errMsg: "getLocation:fail auth deny" })).toBe(
      "LOCATION_PERMISSION_REQUIRED",
    );
    expect(locationErrorCode({ errMsg: "getLocation:fail system permission denied" })).toBe(
      "LOCATION_SYSTEM_DISABLED",
    );
    expect(locationErrorCode({ errMsg: "getLocation:fail api scope is not declared" })).toBe(
      "LOCATION_API_NOT_ALLOWED",
    );
    expect(locationErrorCode({ errMsg: "getLocation:fail privacy permission denied" })).toBe(
      "LOCATION_PRIVACY_REQUIRED",
    );
    expect(locationErrorCode({ errMsg: "getLocation:fail timeout" })).toBe("LOCATION_TIMEOUT");
  });
  it("explains provider failures without pretending a verified route exists", () => {
    expect(routeUnavailableMessage("TIMEOUT")).toContain("超时");
    expect(routeUnavailableMessage("QUOTA_EXCEEDED")).toContain("额度");
    expect(routeUnavailableMessage("DESTINATION_UNRESOLVED")).toContain("具体");
  });
});
