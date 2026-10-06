import type { createRouteView } from "./route-view";

export type CachedRoute = {
  view: NonNullable<ReturnType<typeof createRouteView>>;
  departureReason: string;
};

/** Created once by App; never serialized or restored from device storage. */
export function createRouteCache() {
  const entries = new Map<string, CachedRoute>();
  const key = (owner: string, target: string) => `${owner}:${target}`;
  return {
    get(owner: string | null, target: string | undefined) {
      return owner && target ? (entries.get(key(owner, target)) ?? null) : null;
    },
    set(owner: string, target: string, route: CachedRoute) {
      if (!owner || !target) return;
      entries.delete(key(owner, target));
      entries.set(key(owner, target), route);
    },
    remove(owner: string, target: string) {
      entries.delete(key(owner, target));
    },
    clear() {
      entries.clear();
    },
  };
}
