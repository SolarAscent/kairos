import { observable, action } from "mobx-miniprogram";
import { ApiClient } from "./client";
import { wxPlatform } from "./platform";
import { createRouteCache } from "./route-cache";

export function createSessionServices() {
  const routeCache = createRouteCache();
  const sessionStore = observable({
    userId: "",
    setUser: action(function (id: string | null) {
      if (sessionStore.userId !== (id ?? "")) routeCache.clear();
      sessionStore.userId = id ?? "";
    }),
  });
  const client = new ApiClient(__MINIPROGRAM_CONFIG__, wxPlatform, sessionStore.setUser);
  return { client, sessionStore, routeCache };
}
export type AppServices = ReturnType<typeof createSessionServices>;
