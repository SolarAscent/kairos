import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createModelGateway } from "@life/agent-core";
import { OutboxWorker } from "./worker.js";

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
  const shutdown = () => {
    stopping = true;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log(
    JSON.stringify({
      level: "info",
      event: "worker_started",
      worker_id: worker.workerId,
      provider: gateway.providerName,
    }),
  );
  try {
    while (!stopping) {
      if (!(await worker.processNext())) await new Promise((resolve) => setTimeout(resolve, 800));
    }
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await pool.end();
  }
}

run().catch(() => {
  console.error(JSON.stringify({ level: "fatal", code: "WORKER_FATAL" }));
  process.exitCode = 1;
});
