import { describe, expect, it } from "vitest";
import { createRouteCache, type CachedRoute } from "../../apps/miniprogram/src/lib/route-cache";

const route = (longitude: number) =>
  ({ view: { longitude }, departureReason: "已核对" }) as CachedRoute;

describe("application-memory route cache", () => {
  it("isolates users and wish targets and replaces only an explicitly updated result", () => {
    const cache = createRouteCache();
    cache.set("user-a", "wish-a", route(113.1));
    cache.set("user-a", "wish-b", route(113.2));
    expect(cache.get("user-b", "wish-a")).toBeNull();
    expect(cache.get("user-a", "wish-c")).toBeNull();
    cache.set("user-a", "wish-a", route(114.1));
    expect(cache.get("user-a", "wish-a")?.view.longitude).toBe(114.1);
    expect(cache.get("user-a", "wish-b")?.view.longitude).toBe(113.2);
    cache.remove("user-a", "wish-a");
    expect(cache.get("user-a", "wish-a")).toBeNull();
    expect(cache.get("user-a", "wish-b")?.view.longitude).toBe(113.2);
  });
  it("discards coordinates on session clearing and never restores them into a new process cache", () => {
    const cache = createRouteCache();
    cache.set("user-a", "wish-a", route(113.1));
    expect(createRouteCache().get("user-a", "wish-a")).toBeNull();
    cache.clear();
    expect(cache.get("user-a", "wish-a")).toBeNull();
    expect(cache.get(null, "wish-a")).toBeNull();
  });
});
