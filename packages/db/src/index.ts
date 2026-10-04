import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";
export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
  const pool = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000 });
  return { db: drizzle(pool, { schema }), pool };
}
