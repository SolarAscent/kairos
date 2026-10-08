import "./zod-runtime";
import type { z } from "zod";
import { userSettingsResponseSchema, patchUserSettingsRequestSchema } from "@life/contracts";
import type { ApiClient } from "./client";

export type UserSettings = z.infer<typeof userSettingsResponseSchema>;
export type PatchUserSettings = z.infer<typeof patchUserSettingsRequestSchema>;

export function getUserSettings(client: ApiClient): Promise<UserSettings> {
  return client.request("/v1/settings", userSettingsResponseSchema);
}

export async function patchUserSettings(
  client: ApiClient,
  changes: PatchUserSettings,
  key: string,
): Promise<UserSettings> {
  const data = patchUserSettingsRequestSchema.parse(changes);
  return client.request("/v1/settings", userSettingsResponseSchema, {
    method: "PATCH",
    key,
    data,
  });
}
