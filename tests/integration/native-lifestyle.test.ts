import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@life/db";
import {
  captureAcceptedSchema,
  captureImageResponseSchema,
  lifeDetailResponseSchema,
  lifeSearchResponseSchema,
  nowContextSchema,
  nowResponseSchema,
  recordExportPageSchema,
  uiCapabilitiesResponseSchema,
  userSettingsResponseSchema,
} from "@life/contracts";
import { migrate } from "../../packages/db/dist/migrations.js";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
const schema = "native_life_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(testUrl);
const scopedUrl = new URL(testUrl);
// The only schema in search_path is our disposable schema, including when a table is absent.
scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(scopedUrl.toString());
const pool = source.pool;
const originalEnv = { ...process.env };
let app: Awaited<ReturnType<typeof createApiApp>> | undefined;
let schemaCreated = false;

type Identity = { userId: string; accessToken: string };
async function request(
  method: "GET" | "POST" | "PATCH",
  path: string,
  identity?: Identity,
  body?: object,
  key: string | undefined = randomUUID(),
) {
  if (!app) throw new Error("TEST_APP_NOT_READY");
  return app.inject({
    method,
    url: path,
    headers: {
      ...(identity ? { authorization: `Bearer ${identity.accessToken}` } : {}),
      ...(key ? { "x-idempotency-key": key } : {}),
    },
    ...(body ? { payload: body } : {}),
  });
}
async function login(): Promise<Identity> {
  const response = await request("POST", "/v1/auth/wechat/login", undefined, {
    code: randomUUID(),
  });
  expect(response.statusCode).toBe(201);
  return response.json().data;
}
async function settings(identity: Identity) {
  const response = await request("GET", "/v1/settings", identity);
  expect(response.statusCode).toBe(200);
  return userSettingsResponseSchema.parse(response.json().data);
}
async function lifeObject(identity: Identity, title: string, summary: string | null = null) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO life_objects(id,user_id,title,summary,kind) VALUES($1,$2,$3,$4,'MEDIA')",
    [id, identity.userId, title, summary],
  );
  return id;
}
async function search(identity: Identity, query: string, cursor?: string, limit = 20) {
  const response = await request("POST", "/v1/life/search", identity, {
    query,
    limit,
    ...(cursor ? { cursor } : {}),
  });
  expect(response.statusCode).toBe(200);
  return lifeSearchResponseSchema.parse(response.json().data);
}

beforeAll(async () => {
  // Verify connectivity before creating or migrating the scoped database connection.
  expect((await admin.pool.query("SELECT 1 AS available")).rows[0].available).toBe(1);
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  expect((await pool.query("SHOW search_path")).rows[0].search_path).toBe(schema);
  await migrate(pool);
  Object.assign(process.env, {
    DATABASE_URL: scopedUrl.toString(),
    JWT_SECRET: "native-lifestyle-test-secret-over-32-characters",
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
  await pool.end();
  if (schemaCreated) await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
});

describe("native lifestyle API integration", () => {
  it("starts a new account with empty records and persists skipped onboarding across login", async () => {
    const code = randomUUID();
    const fresh = (await request("POST", "/v1/auth/wechat/login", undefined, { code })).json().data;
    const original = await settings(fresh);
    expect(original.onboardingCompleted).toBe(false);
    expect((await request("GET", "/v1/captures/page", fresh)).json().data.items).toEqual([]);
    expect((await request("GET", "/v1/life/stacks", fresh)).json().data).toEqual([]);
    expect((await request("GET", "/v1/users/me", fresh)).json().data.nickname).toBeNull();
    const skip = await request("POST", "/v1/settings/update", fresh, { onboardingCompleted: true });
    expect(skip.statusCode).toBe(200);
    const returning = (await request("POST", "/v1/auth/wechat/login", undefined, { code })).json()
      .data;
    expect(returning.userId).toBe(fresh.userId);
    const saved = await settings(returning);
    expect(saved.onboardingCompleted).toBe(true);
    expect(saved.recommendation).toEqual(original.recommendation);
    expect(saved.privacy).toEqual(original.privacy);
    expect((await settings(await login())).onboardingCompleted).toBe(false);
  });
  it("isolates settings and replays a lost PATCH response without resetting later changes", async () => {
    const owner = await login(),
      other = await login();
    const initial = await settings(other);
    expect(initial).toMatchObject({
      recommendation: { defaultMinutes: 30, defaultBudget: null, goingOut: "UNKNOWN" },
      onboardingCompleted: false,
      updatedAt: null,
    });
    expect((await request("GET", "/v1/settings")).statusCode).toBe(401);
    const key = randomUUID();
    const input = {
      recommendation: {
        defaultMinutes: 120,
        defaultBudget: 87.5,
        relaxation: "SOCIAL",
        homeRegion: "广州",
        frequentAreas: ["越秀"],
      },
      privacy: { useLocation: true },
      onboardingCompleted: true,
    };
    const written = await request("PATCH", "/v1/settings", owner, input, key);
    expect(written.statusCode).toBe(200);
    const first = userSettingsResponseSchema.parse(written.json().data);
    expect(first.recommendation).toMatchObject(input.recommendation);
    expect(first.onboardingCompleted).toBe(true);
    await request("PATCH", "/v1/settings", owner, { notifications: { enabled: true } });
    const replay = await request("PATCH", "/v1/settings", owner, input, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toEqual(written.json().data);
    expect((await settings(owner)).notifications.enabled).toBe(true);
    expect(await settings(other)).toEqual(initial);
    expect(
      (await request("PATCH", "/v1/settings", owner, { privacy: { useLocation: false } }, key))
        .statusCode,
    ).toBe(409);
    // An idempotency key belongs to the account, not the global settings route.
    expect(
      (await request("PATCH", "/v1/settings", other, { privacy: { useLocation: false } }, key))
        .statusCode,
    ).toBe(200);
  });

  it("merges sequential and concurrent partial preferences rather than losing untouched fields", async () => {
    const owner = await login();
    expect(
      (
        await request("PATCH", "/v1/settings", owner, {
          recommendation: {
            defaultMinutes: 120,
            defaultBudget: 21.75,
            homeRegion: "广州",
            frequentAreas: ["天河"],
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request("PATCH", "/v1/settings", owner, { recommendation: { relaxation: "QUIET" } }))
        .statusCode,
    ).toBe(200);
    expect((await settings(owner)).recommendation).toMatchObject({
      defaultMinutes: 120,
      defaultBudget: 21.75,
      relaxation: "QUIET",
      homeRegion: "广州",
      frequentAreas: ["天河"],
    });
    const responses = await Promise.all([
      request("PATCH", "/v1/settings", owner, { recommendation: { goingOut: "NO" } }),
      request("PATCH", "/v1/settings", owner, { recommendation: { defaultMinutes: 60 } }),
      request("PATCH", "/v1/settings", owner, { privacy: { useLocation: true } }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    const merged = await settings(owner);
    expect(merged.recommendation).toMatchObject({
      defaultMinutes: 60,
      defaultBudget: 21.75,
      relaxation: "QUIET",
      goingOut: "NO",
      homeRegion: "广州",
      frequentAreas: ["天河"],
    });
    expect(merged.privacy.useLocation).toBe(true);
  });

  it("feeds saved defaults into real decisions while explicit zero and false values override them", async () => {
    const owner = await login(),
      other = await login();
    await request("PATCH", "/v1/settings", owner, {
      recommendation: {
        defaultMinutes: 120,
        defaultBudget: 87.65,
        goingOut: "YES",
        relaxation: "SOCIAL",
        homeRegion: "广州",
        frequentAreas: ["天河"],
      },
    });
    const inherited = await request("GET", "/v1/context", owner);
    expect(inherited.statusCode).toBe(200);
    expect(nowContextSchema.parse(inherited.json().data)).toMatchObject({
      availableMinutes: 120,
      budgetMinor: 8765,
      willingToGoOut: true,
      mood: "SOCIAL",
    });
    // Neighborhood preferences are not current-location evidence.
    expect(inherited.json().data.location).toBeUndefined();
    const foreign = await request("GET", "/v1/context", other);
    expect(foreign.json().data).not.toMatchObject({ availableMinutes: 120, budgetMinor: 8765 });
    const explicit = {
      availableMinutes: 0,
      budgetMinor: 0,
      willingToGoOut: false,
      mood: "LOW_ENERGY",
    };
    const decision = await request("POST", "/v1/now/sessions", owner, { context: explicit });
    expect(decision.statusCode).toBe(201);
    const result = nowResponseSchema.parse(decision.json().data);
    const persisted = await pool.query(
      "SELECT context_summary FROM decision_sessions WHERE id=$1 AND user_id=$2",
      [result.sessionId, owner.userId],
    );
    expect(persisted.rows[0].context_summary).toMatchObject(explicit);
    const defaultDecision = await request("POST", "/v1/now/sessions", owner, {});
    expect(defaultDecision.statusCode).toBe(201);
    const defaults = await pool.query(
      "SELECT context_summary FROM decision_sessions WHERE id=$1 AND user_id=$2",
      [defaultDecision.json().data.sessionId, owner.userId],
    );
    expect(defaults.rows[0].context_summary).toMatchObject({
      availableMinutes: 120,
      budgetMinor: 8765,
      willingToGoOut: true,
      mood: "SOCIAL",
    });
  });

  it("searches summaries with literal percent/underscore characters and paginates only owned matches", async () => {
    const owner = await login(),
      other = await login();
    const percent = await lifeObject(owner, "折扣100%有意义");
    const underscore = await lifeObject(owner, "随手记", "用户_原样与 Paper LAMP");
    await lifeObject(owner, "折扣100A有意义", "用户Z原样");
    await lifeObject(other, "私人100%券", "用户_原样");
    expect((await search(owner, "%")).items.map((item) => item.id)).toEqual([percent]);
    expect((await search(owner, "_")).items.map((item) => item.id)).toEqual([underscore]);
    expect((await search(owner, "lamp")).items.map((item) => item.id)).toEqual([underscore]);
    const matched = await Promise.all(
      Array.from({ length: 9 }, (_, index) => lifeObject(owner, `手账${index}`, "唯一摘要关键词")),
    );
    await lifeObject(owner, "不匹配的手账");
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await search(owner, "唯一摘要关键词", cursor ?? undefined, 3);
      seen.push(...page.items.map((item) => item.id));
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBeLessThanOrEqual(matched.length);
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(9);
    expect(seen.sort()).toEqual(matched.sort());
  });

  it("returns the current rating in an owned detail without exposing another account's object", async () => {
    const owner = await login(),
      other = await login();
    const id = await lifeObject(owner, "需要在详情里翻开的记录");
    const initial = await request("GET", `/v1/life/${id}`, owner);
    expect(initial.statusCode).toBe(200);
    expect(lifeDetailResponseSchema.parse(initial.json().data)).toMatchObject({
      id,
      myRating: "NONE",
      verifiedDestination: null,
    });
    await request("POST", `/v1/life/${id}/rating`, owner, { rating: "LIKE" });
    expect((await request("GET", `/v1/life/${id}`, owner)).json().data.myRating).toBe("LIKE");
    await request("POST", `/v1/life/${id}/rating`, owner, { rating: "NONE" });
    expect((await request("GET", `/v1/life/${id}`, owner)).json().data.myRating).toBe("NONE");
    expect((await request("GET", `/v1/life/${id}`, other)).statusCode).toBe(404);
  });

  it("reads only retained owned source images and never returns an asset belonging to another user", async () => {
    const owner = await login(),
      other = await login();
    const image = {
      mimeType: "image/png",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==",
    };
    const created = await request("POST", "/v1/captures", owner, {
      type: "IMAGE",
      text: "真实原图",
      image,
    });
    expect(created.statusCode).toBe(201);
    const id = captureAcceptedSchema.parse(created.json().data).captureId;
    // A foreign asset row must not shadow the source's own image even with a newer timestamp.
    await pool.query(
      "INSERT INTO capture_assets(id,user_id,capture_id,asset_type,storage_key,mime_type,size_bytes,sha256,created_at) VALUES($1,$2,$3,'IMAGE',$4,'image/png',12,$5,now()+interval '1 day')",
      [randomUUID(), other.userId, id, "data:image/png;base64,aW52YWxpZA==", "0".repeat(64)],
    );
    const found = await request("GET", `/v1/captures/${id}/image`, owner);
    expect(found.statusCode).toBe(200);
    expect(captureImageResponseSchema.parse(found.json().data).image).toEqual(image);
    expect((await request("GET", `/v1/captures/${id}/image`, other)).statusCode).toBe(404);
    expect((await request("GET", `/v1/captures/${id}/image`)).statusCode).toBe(401);
    await pool.query(
      "UPDATE capture_assets SET retain_until=now()-interval '1 second' WHERE capture_id=$1 AND user_id=$2",
      [id, owner.userId],
    );
    expect((await request("GET", `/v1/captures/${id}/image`, owner)).json().data.image).toBeNull();
    await pool.query("UPDATE captures SET deleted_at=now() WHERE id=$1", [id]);
    expect((await request("GET", `/v1/captures/${id}/image`, owner)).statusCode).toBe(404);
  });

  it("exports all records across microsecond boundaries with one cutoff and no foreign/deleted/future records", async () => {
    const owner = await login(),
      other = await login();
    await pool.query(
      `INSERT INTO captures(id,user_id,capture_type,status,source_channel,text_content,created_at)
      SELECT gen_random_uuid(),$1,'TEXT','READY','API','export '||n,
      '2026-09-01T00:00:00.123000Z'::timestamptz + ((n % 3)::text||' microsecond')::interval
      FROM generate_series(1,405) n`,
      [owner.userId],
    );
    const forbidden = [randomUUID(), randomUUID(), randomUUID()];
    await pool.query(
      "INSERT INTO captures(id,user_id,capture_type,status,source_channel,text_content,created_at,deleted_at) VALUES($1,$2,'TEXT','READY','API','foreign','2026-08-01',NULL),($3,$4,'TEXT','READY','API','deleted','2026-08-01',now()),($5,$4,'TEXT','READY','API','future',now()+interval '1 day',NULL)",
      [forbidden[0], other.userId, forbidden[1], owner.userId, forbidden[2]],
    );
    const expected = (
      await pool.query(
        "SELECT id FROM captures WHERE user_id=$1 AND deleted_at IS NULL AND created_at<now() ORDER BY created_at DESC,id DESC",
        [owner.userId],
      )
    ).rows.map((row) => row.id);
    const firstResponse = await request("GET", "/v1/records/export", owner);
    expect(firstResponse.statusCode).toBe(200);
    const first = recordExportPageSchema.parse(firstResponse.json().data);
    expect(first.records).toHaveLength(200);
    expect(first.nextCursor).not.toBeNull();
    const seen = first.records.map((record) => record.id);
    const pageSizes = [first.records.length];
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await request(
        "GET",
        `/v1/records/export?cursor=${encodeURIComponent(cursor)}`,
        owner,
      );
      expect(next.statusCode).toBe(200);
      const page = recordExportPageSchema.parse(next.json().data);
      expect(page.exportedAt).toBe(first.exportedAt);
      seen.push(...page.records.map((record) => record.id));
      pageSizes.push(page.records.length);
      expect(pageSizes.length).toBeLessThanOrEqual(3);
      expect(new Set(seen).size).toBe(seen.length);
      cursor = page.nextCursor;
    }
    expect(pageSizes).toEqual([200, 200, 5]);
    expect(new Set(seen).size).toBe(405);
    expect(seen).toEqual(expected);
    expect(seen.some((id) => forbidden.includes(id))).toBe(false);
    // Replaying an owned pagination token under a different identity cannot leak its records.
    const isolated = await request(
      "GET",
      `/v1/records/export?cursor=${encodeURIComponent(first.nextCursor!)}`,
      other,
    );
    expect(isolated.statusCode).toBe(200);
    expect(isolated.json().data.records.map((record: { id: string }) => record.id)).toEqual([
      forbidden[0],
    ]);
    for (const bad of [
      "not-json",
      Buffer.from(
        JSON.stringify({ asOf: first.exportedAt, createdAt: first.exportedAt, id: "not-a-uuid" }),
      ).toString("base64url"),
    ]) {
      const invalid = await request(
        "GET",
        `/v1/records/export?cursor=${encodeURIComponent(bad)}`,
        owner,
      );
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("INVALID_EXPORT_CURSOR");
    }
    expect((await request("GET", "/v1/records/export")).statusCode).toBe(401);
  });

  it("reserves scheduling and nearby discovery without writing facts or exposing another account", async () => {
    const owner = await login(),
      other = await login();
    const captured = await request("POST", "/v1/captures", owner, {
      type: "TEXT",
      text: "待安排的原始记录",
    });
    expect(captured.statusCode).toBe(201);
    const captureId = captureAcceptedSchema.parse(captured.json().data).captureId;
    const body = { captureId, scheduledFor: "2026-12-01T12:00:00Z" };
    expect(
      (await request("POST", "/v1/captures/arrangements", owner, body)).json().error.code,
    ).toBe("CAPTURE_ARRANGEMENT_NOT_INTEGRATED");
    expect((await request("POST", "/v1/captures/arrangements", other, body)).statusCode).toBe(404);
    expect(
      (await request("POST", "/v1/captures/arrangements", owner, body, "invalid")).statusCode,
    ).toBe(400);
    const query =
      "/v1/places/discover?latitude=23&longitude=113&coordinateSystem=GCJ02&radiusMeters=1000";
    expect((await request("GET", query, owner)).json().error.code).toBe(
      "NEARBY_DISCOVERY_NOT_INTEGRATED",
    );
    expect((await request("GET", query)).statusCode).toBe(401);
    expect(
      (await request("GET", query.replace("radiusMeters=1000", "radiusMeters=-1"), owner))
        .statusCode,
    ).toBe(400);
    expect((await request("GET", `/v1/captures/${captureId}`, owner)).json().data.text).toBe(
      "待安排的原始记录",
    );
  });

  it("reports unavailable verification and reminders truthfully after ownership and input validation", async () => {
    const owner = await login(),
      other = await login();
    const id = await lifeObject(owner, "不能被假核销的凭证");
    const capabilities = await request("GET", "/v1/ui-capabilities", owner);
    expect(uiCapabilitiesResponseSchema.parse(capabilities.json().data)).toMatchObject({
      ticketVerification: { available: false },
      reminderDelivery: { available: false },
      mediaArchive: { available: true },
      recordExport: { available: true },
    });
    for (const [path, body, code] of [
      ["/v1/tickets/verify", { lifeObjectId: id }, "TICKET_VERIFICATION_NOT_INTEGRATED"],
      [
        "/v1/reminders/subscriptions",
        { lifeObjectId: id, remindAt: new Date(Date.now() + 600000).toISOString() },
        "REMINDER_DELIVERY_NOT_INTEGRATED",
      ],
    ] as const) {
      const unimplemented = await request("POST", path, owner, body);
      expect(unimplemented.statusCode).toBe(501);
      expect(unimplemented.json().error.code).toBe(code);
      expect((await request("POST", path, other, body)).statusCode).toBe(404);
      expect((await request("POST", path, owner, body, "invalid-key")).statusCode).toBe(400);
      expect((await request("POST", path, undefined, body)).statusCode).toBe(401);
    }
    expect(
      (await pool.query("SELECT status,object_version FROM life_objects WHERE id=$1", [id]))
        .rows[0],
    ).toMatchObject({ status: "ACTIVE", object_version: 1 });
  });
});

it("attaches an owned image cover to sections, search, ranked decks and detail even after several text sources", async () => {
  const owner = await login(),
    other = await login();
  const objectId = await lifeObject(owner, "有原始图片的生活记录");
  const foreignObject = await lifeObject(other, "另一位用户的图片记录");
  const image = { mimeType: "image/png", base64: "iVBORw0KGgoAAAAA" };
  const response = await request("POST", "/v1/captures", owner, {
    type: "IMAGE",
    image,
    sourceChannel: "MINIPROGRAM",
  });
  expect(response.statusCode).toBe(201);
  const captureId = response.json().data.captureId;
  for (let n = 0; n < 5; n++) {
    const text = await request("POST", "/v1/captures", owner, {
      type: "TEXT",
      text: "文字来源" + n,
    });
    await pool.query(
      "INSERT INTO life_object_sources(id,user_id,life_object_id,source_type,source_id,is_primary,confidence) VALUES($1,$2,$3,'CAPTURE',$4,true,1)",
      [randomUUID(), owner.userId, objectId, text.json().data.captureId],
    );
  }
  await pool.query(
    "INSERT INTO life_object_sources(id,user_id,life_object_id,source_type,source_id,is_primary,confidence) VALUES($1,$2,$3,'CAPTURE',$4,false,1),($5,$6,$7,'CAPTURE',$4,true,1)",
    [randomUUID(), owner.userId, objectId, captureId, randomUUID(), other.userId, foreignObject],
  );
  const owned = (await request("GET", `/v1/life/${objectId}`, owner)).json().data;
  expect(owned.imageCaptureId).toBe(captureId);
  expect((await search(owner, "有原始图片")).items[0].imageCaptureId).toBe(captureId);
  const sections = (await request("GET", "/v1/life/sections", owner)).json().data;
  expect(
    sections.flatMap((section: any) => section.items).find((item: any) => item.id === objectId)
      .imageCaptureId,
  ).toBe(captureId);
  const deck = (await request("POST", "/v1/life/deck", owner, { kind: "MEDIA", limit: 10 })).json()
    .data;
  expect(deck.items.find((item: any) => item.id === objectId).imageCaptureId).toBe(captureId);
  expect(
    (await request("GET", `/v1/life/${foreignObject}`, other)).json().data.imageCaptureId,
  ).toBeNull();
  expect((await request("GET", `/v1/captures/${captureId}/image`, other)).statusCode).toBe(404);
  await pool.query(
    "UPDATE capture_assets SET retain_until=now()-interval '1 second' WHERE capture_id=$1",
    [captureId],
  );
  expect(
    (await request("GET", `/v1/life/${objectId}`, owner)).json().data.imageCaptureId,
  ).toBeNull();
});
