import type { ApiClient } from "./client";

export type AppearanceSettings = { reduceMotion: boolean };
const defaults: AppearanceSettings = { reduceMotion: false };

function key(client: ApiClient) {
  const owner = client.userId;
  return owner ? `${client.storageKey}:appearance:${owner}` : null;
}

export function getAppearance(client: ApiClient): AppearanceSettings {
  const storageKey = key(client);
  if (!storageKey) return { ...defaults };
  try {
    const value = wx.getStorageSync(storageKey) as Partial<AppearanceSettings> | undefined;
    return { reduceMotion: typeof value?.reduceMotion === "boolean" ? value.reduceMotion : false };
  } catch {
    return { ...defaults };
  }
}

export function setReduceMotion(client: ApiClient, reduceMotion: boolean): boolean {
  const storageKey = key(client);
  if (!storageKey) return false;
  try {
    const value = getAppearance(client);
    wx.setStorageSync(storageKey, { ...value, reduceMotion });
    return true;
  } catch {
    return false;
  }
}
