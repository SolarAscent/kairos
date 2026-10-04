import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool } from "pg";

export async function migrate(pool: Pool) {
  const directory = resolve(import.meta.dirname, "../migrations");
  const names = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/u.test(name)).sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(4812042026)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const appliedNames = new Set(applied.rows.map((row) => row.name));
    for (const name of names) {
      if (appliedNames.has(name)) continue;
      await client.query(await readFile(resolve(directory, name), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
