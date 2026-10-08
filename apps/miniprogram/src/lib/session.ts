import { observable, action } from "mobx-miniprogram";
import { ApiClient } from "./client";
import { wxPlatform } from "./platform";
import { createRouteCache } from "./route-cache";
import { ProfileClient } from "./profile";
import { pruneLocalAccountFiles } from "./local-retention";
import type { UserProfile } from "@life/contracts";

export function createSessionServices() {
  const routeCache = createRouteCache();
  let profiles: ProfileClient | undefined;
  let sessionInitialized = false;
  const sessionStore = observable({
    userId: "",
    nickname: "",
    avatarPath: "",
    setUser: action(function (id: string | null) {
      const nextOwner = id ?? "";
      if (!sessionInitialized || sessionStore.userId !== nextOwner) pruneLocalAccountFiles(id);
      sessionInitialized = true;
      if (sessionStore.userId !== nextOwner) {
        routeCache.clear();
        profiles?.clear();
        sessionStore.nickname = sessionStore.avatarPath = "";
      }
      sessionStore.userId = nextOwner;
    }),
    setProfile: action(function (profile: UserProfile | null, path: string) {
      sessionStore.nickname = profile?.nickname ?? "";
      sessionStore.avatarPath = path;
    }),
  });
  const client = new ApiClient(__MINIPROGRAM_CONFIG__, wxPlatform, sessionStore.setUser);
  profiles = new ProfileClient(client, sessionStore.setProfile);
  return { client, sessionStore, routeCache, profiles };
}
export type AppServices = ReturnType<typeof createSessionServices>;
