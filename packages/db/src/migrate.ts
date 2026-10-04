import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { Pool } from "pg";
import { migrate } from "./migrations.js";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env"), quiet: true });
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 5000,
});
try {
  await migrate(pool);
  console.log("Database is up to date.");
} finally {
  await pool.end();
}
