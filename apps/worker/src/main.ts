import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createModelGateway } from "@life/agent-core";
import { OutboxWorker } from "./worker.js";
import { runRetentionLoop } from "./retention.js";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env"), quiet: true });

async function run() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
  const gateway = createModelGateway(process.env);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 5000,
  });
  const worker = new OutboxWorker(pool, gateway);
  let stopping = false;
  const maintenance = new AbortController();
  const shutdown = () => {
    stopping = true;
    maintenance.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log(
    JSON.stringify({
      level: "info",
      event: "worker_started",
      worker_id: worker.workerId,
      provider: gateway.providerName,
      concurrency: 2,
    }),
  );
  // Reserve one runner for new input and feedback so old-data AI repair cannot fill both slots.
  const runners = Array.from({ length: 2 }, async (_, index) => {
    while (!stopping) {
      if (!(await worker.processNext(index === 1)))
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
  runners.push(runRetentionLoop(pool, maintenance.signal));
  try {
    await Promise.all(runners);
  } finally {
    stopping = true;
    maintenance.abort();
    await Promise.allSettled(runners);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await pool.end();
  }
}

run().catch(() => {
  console.error(JSON.stringify({ level: "fatal", code: "WORKER_FATAL" }));
  process.exitCode = 1;
});
