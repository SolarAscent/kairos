import { observable, action } from "mobx-miniprogram";
import { ApiClient } from "./client";
import { wxPlatform } from "./platform";

export function createSessionServices() {
  const sessionStore = observable({
    userId: "",
    setUser: action(function (id: string | null) {
      sessionStore.userId = id ?? "";
    }),
  });
  const client = new ApiClient(__MINIPROGRAM_CONFIG__, wxPlatform, sessionStore.setUser);
  return { client, sessionStore };
}
export type AppServices = ReturnType<typeof createSessionServices>;
