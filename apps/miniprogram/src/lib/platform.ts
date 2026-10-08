import type { ClientPlatform } from "./client";

export const wxPlatform: ClientPlatform = {
  send: ({ url, method, data, headers }) =>
    new Promise((resolve, reject) => {
      wx.request({
        // wx.request does not expose PATCH. The API supplies POST update aliases
        // with the same validation, owner checks and idempotency operation.
        url: method === "PATCH" ? url + "/update" : url,
        method: method === "PATCH" ? "POST" : method,
        data: data as WechatMiniprogram.IAnyObject,
        header: headers,
        timeout: 15000,
        success: (result) => resolve({ status: result.statusCode, body: result.data }),
        fail: reject,
      });
    }),
  login: () =>
    new Promise((resolve, reject) => {
      wx.login({
        timeout: 10000,
        success: (result) => (result.code ? resolve(result.code) : reject(new Error("NO_CODE"))),
        fail: reject,
      });
    }),
  uuid: () =>
    new Promise((resolve, reject) => {
      wx.getRandomValues({
        length: 16,
        success: ({ randomValues }) => {
          const bytes = new Uint8Array(randomValues);
          bytes[6] = (bytes[6]! & 15) | 64;
          bytes[8] = (bytes[8]! & 63) | 128;
          const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
          resolve(
            `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
          );
        },
        fail: reject,
      });
    }),
  read: (key) => wx.getStorageSync(key),
  write: (key, value) => wx.setStorageSync(key, value),
  remove: (key) => wx.removeStorageSync(key),
  envVersion: () => wx.getAccountInfoSync().miniProgram.envVersion,
  sdkVersion: () => wx.getAppBaseInfo().SDKVersion,
};
