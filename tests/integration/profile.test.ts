import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@life/db";
import { userProfileSchema, userAvatarSchema, MAX_AVATAR_BYTES } from "@life/contracts";
import { migrate } from "../../packages/db/dist/migrations.js";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("Set TEST_DATABASE_URL to a disposable local PostgreSQL database.");
const schema = "profile_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(testUrl);
const scopedUrl = new URL(testUrl);
scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(scopedUrl.toString());
let app: Awaited<ReturnType<typeof createApiApp>>;
const png = {
  mimeType: "image/png",
  base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
};

beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(source.pool);
  await migrate(source.pool);
  process.env.DATABASE_URL = scopedUrl.toString();
  process.env.JWT_SECRET = "test-only-secret-at-least-32-bytes-long";
  process.env.WECHAT_MOCK_LOGIN = "true";
  process.env.NODE_ENV = "test";
  app = await createApiApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 30000);
afterAll(async () => {
  vi.unstubAllGlobals();
  if (app) await app.close();
  await source.pool.end();
  await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
});
async function login(code = randomUUID()) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/wechat/login",
    payload: { code },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data as { accessToken: string; refreshToken: string; userId: string };
}
function request(
  token: string,
  method: "GET" | "POST",
  url: string,
  payload?: object,
  key = randomUUID(),
) {
  return app.inject({
    method,
    url,
    headers: { authorization: "Bearer " + token, "x-idempotency-key": key },
    ...(payload ? { payload } : {}),
  });
}

describe("persisted current-user profile and verified identity association", () => {
  it("requires authentication for metadata, avatar and writes", async () => {
    for (const url of ["/v1/users/me", "/v1/users/me/avatar"])
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/users/me/profile",
          payload: { nickname: "匿名", bio: "" },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("preserves profile, avatar and record ownership across installations and re-login", async () => {
    const code = randomUUID();
    const first = await login(code);
    const capture = await request(first.accessToken, "POST", "/v1/captures", {
      type: "TEXT",
      text: "留给自己的记录",
    });
    expect(capture.statusCode).toBe(201);
    const response = await request(first.accessToken, "POST", "/v1/users/me/profile", {
      nickname: "  海边散步  ",
      bio: " 最近想读书。 ",
      avatar: png,
    });
    expect(response.statusCode).toBe(201);
    const profile = userProfileSchema.parse(response.json().data);
    expect(profile).toMatchObject({
      userId: first.userId,
      nickname: "海边散步",
      bio: "最近想读书。",
      identityProvider: "DEVELOPMENT",
    });
    expect(profile.avatarVersion).toBeTruthy();
    expect(response.body).not.toContain(png.base64);
    const second = await login(code);
    expect(second.userId).toBe(first.userId);
    expect(
      userProfileSchema.parse(
        (await request(second.accessToken, "GET", "/v1/users/me")).json().data,
      ),
    ).toEqual(profile);
    expect(
      userAvatarSchema.parse(
        (await request(second.accessToken, "GET", "/v1/users/me/avatar")).json().data,
      ),
    ).toEqual({ avatarVersion: profile.avatarVersion, image: png });
    expect(
      (await request(second.accessToken, "GET", "/v1/captures"))
        .json()
        .data.map((item: any) => item.id),
    ).toContain(capture.json().data.captureId);
  });
  it("isolates accounts and rejects client-supplied identity fields and remote avatar URLs", async () => {
    const a = await login(),
      b = await login();
    expect(
      (
        await request(a.accessToken, "POST", "/v1/users/me/profile", {
          nickname: "甲",
          bio: "",
          avatar: png,
        })
      ).statusCode,
    ).toBe(201);
    for (const extra of [
      { userId: a.userId },
      { openId: "forged" },
      { unionId: "forged" },
      { avatarUrl: "https://example.com/avatar.jpg" },
    ])
      expect(
        (
          await request(b.accessToken, "POST", "/v1/users/me/profile", {
            nickname: "乙",
            bio: "",
            ...extra,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (await request(b.accessToken, "POST", "/v1/users/me/profile", { nickname: "乙", bio: "" }))
        .statusCode,
    ).toBe(201);
    expect((await request(a.accessToken, "GET", "/v1/users/me")).json().data.nickname).toBe("甲");
    expect((await request(b.accessToken, "GET", "/v1/users/me/avatar")).json().data).toEqual({
      avatarVersion: null,
      image: null,
    });
  });
  it("replays a lost save response without generating a second avatar version", async () => {
    const user = await login();
    const key = randomUUID();
    const input = { nickname: "重试用户", bio: "", avatar: png };
    const first = await request(user.accessToken, "POST", "/v1/users/me/profile", input, key);
    const replay = await request(user.accessToken, "POST", "/v1/users/me/profile", input, key);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data).toEqual(first.json().data);
    const conflict = await request(
      user.accessToken,
      "POST",
      "/v1/users/me/profile",
      { ...input, nickname: "修改请求" },
      key,
    );
    expect(conflict.statusCode).toBe(409);
    const missingKey = await app.inject({
      method: "POST",
      url: "/v1/users/me/profile",
      headers: { authorization: "Bearer " + user.accessToken },
      payload: input,
    });
    expect(missingKey.statusCode).toBe(400);
  });
  it("retains an omitted avatar, replaces it on upload and removes it only with null", async () => {
    const user = await login();
    const write = (extra: object) =>
      request(user.accessToken, "POST", "/v1/users/me/profile", {
        nickname: "用户",
        bio: "",
        ...extra,
      });
    const first = (await write({ avatar: png })).json().data;
    expect((await write({ bio: "有新简介" })).json().data.avatarVersion).toBe(first.avatarVersion);
    expect((await write({ avatar: png })).json().data.avatarVersion).not.toBe(first.avatarVersion);
    expect((await write({ avatar: null })).json().data.avatarVersion).toBeNull();
    expect(
      (await request(user.accessToken, "GET", "/v1/users/me/avatar")).json().data.image,
    ).toBeNull();
    const stored = await source.pool.query(
      "SELECT avatar_base64, avatar_mime_type FROM users WHERE id=$1",
      [user.userId],
    );
    expect(stored.rows[0]).toEqual({ avatar_base64: null, avatar_mime_type: null });
  });
  it("rejects empty/long nicknames, oversized images, malformed bytes and mismatched MIME", async () => {
    const user = await login();
    for (const extra of [
      { nickname: "  " },
      { nickname: "长".repeat(33) },
      { nickname: "控制\n字符" },
      { bio: "长".repeat(161) },
      { avatar: { ...png, base64: Buffer.from("not an image").toString("base64") } },
      { avatar: { ...png, mimeType: "image/jpeg" } },
      { avatar: { ...png, base64: Buffer.alloc(MAX_AVATAR_BYTES + 1).toString("base64") } },
    ])
      expect(
        (
          await request(user.accessToken, "POST", "/v1/users/me/profile", {
            nickname: "有效昵称",
            bio: "",
            ...extra,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (await request(user.accessToken, "GET", "/v1/users/me")).json().data.nickname,
    ).toBeNull();
  });
  it("uses verified OpenID for repeated login and records later UnionID without merging users", async () => {
    const oldMock = process.env.WECHAT_MOCK_LOGIN;
    const oldApp = process.env.WECHAT_APP_ID,
      oldSecret = process.env.WECHAT_APP_SECRET;
    try {
      process.env.WECHAT_MOCK_LOGIN = "false";
      process.env.WECHAT_APP_ID = "wx0123456789abcdef";
      process.env.WECHAT_APP_SECRET = "test-only-app-secret";
      const openid = "verified:" + randomUUID();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ openid }) })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ openid, unionid: "verified-union" }),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ openid: "other:" + randomUUID(), unionid: "verified-union" }),
          }),
      );
      const a = await login(),
        again = await login(),
        other = await login();
      expect(again.userId).toBe(a.userId);
      expect(other.userId).not.toBe(a.userId);
      expect(
        (await request(a.accessToken, "GET", "/v1/users/me")).json().data.identityProvider,
      ).toBe("WECHAT");
      expect(
        (
          await source.pool.query("SELECT union_subject FROM user_identities WHERE user_id=$1", [
            a.userId,
          ])
        ).rows[0].union_subject,
      ).toBe("verified-union");
      expect((await request(a.accessToken, "GET", "/v1/users/me")).body).not.toContain(openid);
    } finally {
      vi.unstubAllGlobals();
      for (const [name, value] of [
        ["WECHAT_MOCK_LOGIN", oldMock],
        ["WECHAT_APP_ID", oldApp],
        ["WECHAT_APP_SECRET", oldSecret],
      ])
        if (value === undefined) delete process.env[name!];
        else process.env[name!] = value;
    }
  });
  it("revokes access to profile and avatar after logout", async () => {
    const user = await login();
    expect((await request(user.accessToken, "POST", "/v1/auth/logout", {})).statusCode).toBe(201);
    for (const url of ["/v1/users/me", "/v1/users/me/avatar"])
      expect((await request(user.accessToken, "GET", url)).statusCode).toBe(401);
  });
});
