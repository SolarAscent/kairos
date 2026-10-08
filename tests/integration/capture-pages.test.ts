import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase } from "@life/db";
import { capturePageResponseSchema } from "@life/contracts";
import { migrate } from "../../packages/db/dist/migrations.js";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL_REQUIRED");
const schema = "capture_pages_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(url);
const scoped = new URL(url);
scoped.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(scoped.toString());
const originalEnv = { ...process.env };
let app: Awaited<ReturnType<typeof createApiApp>> | undefined;
let created = false;

beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  expect((await source.pool.query("SHOW search_path")).rows[0].search_path).toBe(schema);
  await migrate(source.pool);
  Object.assign(process.env, {
    DATABASE_URL: scoped.toString(),
    JWT_SECRET: "capture-page-local-test-secret-more-than-32-characters",
    WECHAT_MOCK_LOGIN: "true",
    NODE_ENV: "test",
  });
  app = await createApiApp({
    locationProvider: {
      configured: false,
      geocode: async () => ({ ok: false, reason: "NOT_CONFIGURED" }),
      route: async () => ({ ok: false, reason: "NOT_CONFIGURED" }),
    },
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 30000);

afterAll(async () => {
  if (app) await app.close();
  await source.pool.end();
  if (created) await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
});

async function login() {
  const response = await app!.inject({
    method: "POST",
    url: "/v1/auth/wechat/login",
    payload: { code: randomUUID() },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data as { userId: string; accessToken: string };
}

it("browses every owned original across tied microseconds without duplicates or new inserts", async () => {
  const owner = await login();
  const other = await login();
  await source.pool.query(
    `INSERT INTO captures(id,user_id,capture_type,status,source_channel,text_content,created_at)
     SELECT gen_random_uuid(),$1,'TEXT','READY','API','original '||n,
       '2026-09-01T00:00:00.123000Z'::timestamptz + ((n % 3)::text||' microsecond')::interval
     FROM generate_series(1,103) n`,
    [owner.userId],
  );
  await source.pool.query(
    `INSERT INTO captures(id,user_id,capture_type,status,source_channel,text_content,created_at,deleted_at)
     VALUES($1,$2,'TEXT','READY','API','foreign','2026-08-01',NULL),
           ($3,$4,'TEXT','READY','API','deleted','2026-08-01',now())`,
    [randomUUID(), other.userId, randomUUID(), owner.userId],
  );
  const expected = (
    await source.pool.query(
      "SELECT id FROM captures WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC,id DESC",
      [owner.userId],
    )
  ).rows.map((row) => row.id);
  const get = (identity: typeof owner, cursor?: string) =>
    app!.inject({
      method: "GET",
      url: "/v1/captures/page" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      headers: { authorization: `Bearer ${identity.accessToken}` },
    });
  const firstResponse = await get(owner);
  expect(firstResponse.statusCode).toBe(200);
  const first = capturePageResponseSchema.parse(firstResponse.json().data);
  expect(first.items).toHaveLength(50);
  expect(first.nextCursor).not.toBeNull();
  // A record saved after the first page belongs to the next explicit refresh.
  await source.pool.query(
    "INSERT INTO captures(id,user_id,capture_type,status,source_channel,text_content,created_at) VALUES($1,$2,'TEXT','UPLOADED','API','late insert',now()+interval '1 second')",
    [randomUUID(), owner.userId],
  );
  const seen = first.items.map((item) => item.id);
  const sizes = [first.items.length];
  let cursor = first.nextCursor;
  while (cursor) {
    const response = await get(owner, cursor);
    expect(response.statusCode).toBe(200);
    const page = capturePageResponseSchema.parse(response.json().data);
    seen.push(...page.items.map((item) => item.id));
    sizes.push(page.items.length);
    expect(sizes.length).toBeLessThanOrEqual(3);
    cursor = page.nextCursor;
  }
  expect(sizes).toEqual([50, 50, 3]);
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(103);
  const foreignCursor = await get(other, first.nextCursor!);
  expect(foreignCursor.statusCode).toBe(200);
  expect(
    foreignCursor.json().data.items.every((item: { text: string }) => item.text === "foreign"),
  ).toBe(true);
  const bad = await get(owner, "not-json");
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error.code).toBe("INVALID_CAPTURE_CURSOR");
  expect((await app!.inject({ method: "GET", url: "/v1/captures/page" })).statusCode).toBe(401);
});
