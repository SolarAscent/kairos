import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { createApiApp } from "./bootstrap.js";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env"), quiet: true });

async function main() {
  const app = await createApiApp();
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

main().catch(() => {
  console.error(JSON.stringify({ level: "fatal", code: "API_STARTUP_FAILED" }));
  process.exitCode = 1;
});
