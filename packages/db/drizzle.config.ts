import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

loadEnv({ path: resolve(import.meta.dirname, "../../.env") });

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  // Generated SQL is reviewed in this staging directory, then copied into migrations/.
  out: "./migration-drafts",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
