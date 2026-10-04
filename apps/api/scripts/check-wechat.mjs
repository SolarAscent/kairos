import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkWechatConfig } from "../dist/auth/wechat.provider.js";
import { readAuthConfig } from "../dist/common/auth-config.js";

const failures = [];
if (process.env.WECHAT_MOCK_LOGIN !== "false") failures.push("WECHAT_MOCK_LOGIN must be false");
try {
  checkWechatConfig({ ...process.env, NODE_ENV: "production" });
} catch {
  failures.push("Real WECHAT_APP_ID and server-only WECHAT_APP_SECRET are required");
}
try {
  readAuthConfig();
  if (/replace|example|test-only/i.test(process.env.JWT_SECRET ?? "")) throw new Error();
} catch {
  failures.push("A non-example JWT_SECRET of at least 32 bytes is required");
}
try {
  const db = new URL(process.env.DATABASE_URL ?? "");
  if (!["postgres:", "postgresql:"].includes(db.protocol)) throw new Error();
} catch {
  failures.push("A PostgreSQL DATABASE_URL is required");
}
try {
  const path = process.env.MINIPROGRAM_CONFIG
    ? resolve(process.env.MINIPROGRAM_CONFIG)
    : resolve("apps/miniprogram/config.local.json");
  const client = JSON.parse(await readFile(path, "utf8"));
  if (client.appId !== process.env.WECHAT_APP_ID)
    failures.push("Client and server AppIDs must match");
  if (client.loginMode !== "wechat") failures.push("Client loginMode must be wechat");
} catch {
  failures.push("Create a client config.local.json or set MINIPROGRAM_CONFIG");
}
if (failures.length) {
  failures.forEach((message) => console.error("[pending] " + message));
  process.exitCode = 1;
} else {
  console.log(
    "Real WeChat configuration checks passed. No network calls made; credentials, domain allowlist and deployment still need live verification.",
  );
}
