import { observable, action } from "mobx-miniprogram";
import { ApiClient } from "./client";
import { wxPlatform } from "./platform";

export const sessionStore = observable({
  userId: "",
  setUser: action(function (id: string | null) {
    sessionStore.userId = id ?? "";
  }),
});
export const client = new ApiClient(__MINIPROGRAM_CONFIG__, wxPlatform, sessionStore.setUser);
