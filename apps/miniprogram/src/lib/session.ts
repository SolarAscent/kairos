import { observable, action } from "mobx-miniprogram";
import { ApiClient } from "./client";
import { wxPlatform } from "./platform";
import { ProfileClient } from "./profile";
import type { UserProfile } from "@life/contracts";

export function createSessionServices() {
  let profiles: ProfileClient | undefined;
  const sessionStore = observable({
    userId: "",
    nickname: "",
    avatarPath: "",
    setUser: action(function (id: string | null) {
      if (sessionStore.userId !== (id ?? "")) {
        profiles?.clear();
        sessionStore.nickname = sessionStore.avatarPath = "";
      }
      sessionStore.userId = id ?? "";
    }),
    setProfile: action(function (profile: UserProfile | null, path: string) {
      sessionStore.nickname = profile?.nickname ?? "";
      sessionStore.avatarPath = path;
    }),
  });
  const client = new ApiClient(__MINIPROGRAM_CONFIG__, wxPlatform, sessionStore.setUser);
  profiles = new ProfileClient(client, sessionStore.setProfile);
  return { client, sessionStore, profiles };
}
export type AppServices = ReturnType<typeof createSessionServices>;
