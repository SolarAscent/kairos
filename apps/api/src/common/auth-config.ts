import { z } from "zod";

const authConfigSchema = z.object({
  JWT_SECRET: z.string().refine((value) => Buffer.byteLength(value) >= 32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1200),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
});

export function readAuthConfig(env = process.env) {
  const result = authConfigSchema.safeParse(env);
  if (!result.success) throw new Error("AUTH_CONFIGURATION_INVALID");
  return result.data;
}
