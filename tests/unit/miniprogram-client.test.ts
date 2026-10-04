import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiClient, type ClientPlatform } from "../../apps/miniprogram/src/lib/client";

const userId = randomUUID();
const token = (n = 1) => ({
  userId,
  accessToken: "access-" + n,
  refreshToken: "refresh-" + n + "x".repeat(40),
  expiresIn: 1200,
});
const ok = (data: unknown) => ({ status: 200, body: { data, request_id: randomUUID() } });
const denied = () => ({
  status: 401,
  body: { error: { code: "INVALID_TOKEN", request_id: randomUUID() } },
});
const config = {
  environment: "develop" as const,
  appId: "wx0123456789abcdef",
  apiBaseUrl: "https://api.example.org",
  loginMode: "wechat" as const,
  appVersion: "0.2.0",
};
function setup(handler: ClientPlatform["send"] = async () => ok(token())) {
  const storage = new Map<string, unknown>();
  const platform: ClientPlatform = {
    send: vi.fn(handler),
    login: vi.fn(async () => "wx-code"),
    uuid: async () => randomUUID(),
    read: (key) => storage.get(key),
    write: (key, data) => {
      storage.set(key, data);
    },
    remove: (key) => {
      storage.delete(key);
    },
    envVersion: () => "develop",
    sdkVersion: () => "3.7.1",
  };
  const client = new ApiClient(config, platform);
  return { client, platform, storage };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("native client sessions and network recovery", () => {
  it("uses wx.login once for concurrent login and restores environment-scoped credentials", async () => {
    const { client, platform } = setup();
    await Promise.all([client.login(), client.login()]);
    expect(platform.login).toHaveBeenCalledTimes(1);
    expect(new ApiClient(config, platform).userId).toBe(userId);
    expect(
      new ApiClient({ ...config, apiBaseUrl: "https://another.example.org" }, platform).userId,
    ).toBeNull();
  });
  it("refreshes only once when several protected requests return 401", async () => {
    let refreshes = 0;
    const { client } = setup(async (input) => {
      if (input.url.endsWith("/login")) return ok(token());
      if (input.url.endsWith("/refresh")) {
        refreshes++;
        return ok(token(2));
      }
      return input.headers.authorization === "Bearer access-2" ? ok({ saved: true }) : denied();
    });
    await client.login();
    const schema = z.object({ saved: z.boolean() });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.request("/v1/life", schema)),
    );
    expect(results.every((r) => r.saved)).toBe(true);
    expect(refreshes).toBe(1);
  });
  it("keeps the operation UUID and body through an authenticated retry", async () => {
    const writes: any[] = [];
    const { client } = setup(async (input) => {
      if (input.url.endsWith("/login")) return ok(token());
      if (input.url.endsWith("/refresh")) return ok(token(2));
      writes.push(input);
      return writes.length === 1 ? denied() : ok({ saved: true });
    });
    await client.login();
    const key = randomUUID();
    await client.request("/v1/captures", z.object({ saved: z.boolean() }), {
      method: "POST",
      key,
      data: { text: "hello" },
    });
    expect(writes.map((i) => i.headers["X-Idempotency-Key"])).toEqual([key, key]);
    expect(writes[0].data).toEqual(writes[1].data);
    expect(writes[0].headers["x-platform"]).toBe("MINIPROGRAM");
  });
  it("drops ambiguous refresh credentials and requires an explicit new login", async () => {
    let refreshes = 0;
    const { client } = setup(async (input) => {
      if (input.url.endsWith("/login")) return ok(token());
      if (input.url.endsWith("/refresh")) {
        refreshes++;
        throw new Error("response lost");
      }
      return denied();
    });
    await client.login();
    await expect(client.request("/v1/life", z.array(z.unknown()))).rejects.toMatchObject({
      code: "LOGIN_REQUIRED",
    });
    expect(client.userId).toBeNull();
    expect(refreshes).toBe(1);
  });
  it("does not restore a session when a login response arrives after logout", async () => {
    const response = deferred<ReturnType<typeof ok>>();
    const entered = deferred<void>();
    const { client } = setup(async () => {
      entered.resolve();
      return response.promise;
    });
    const login = client.login();
    await entered.promise;
    client.clear();
    response.resolve(ok(token()));
    await expect(login).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(client.userId).toBeNull();
  });
  it("ignores a refresh response after logout", async () => {
    const response = deferred<ReturnType<typeof ok>>();
    const entered = deferred<void>();
    const { client } = setup(async (input) => {
      if (input.url.endsWith("/login")) return ok(token());
      if (input.url.endsWith("/refresh")) {
        entered.resolve();
        return response.promise;
      }
      return denied();
    });
    await client.login();
    const pending = client.request("/v1/life", z.array(z.unknown()));
    await entered.promise;
    client.clear();
    response.resolve(ok(token(2)));
    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(client.userId).toBeNull();
  });
  it("does not overwrite a new login with an older refresh response", async () => {
    const response = deferred<ReturnType<typeof ok>>();
    const entered = deferred<void>();
    const nextUserId = randomUUID();
    let logins = 0;
    const { client } = setup(async (input) => {
      if (input.url.endsWith("/login"))
        return ok(++logins === 1 ? token() : { ...token(3), userId: nextUserId });
      if (input.url.endsWith("/refresh")) {
        entered.resolve();
        return response.promise;
      }
      return input.headers.authorization === "Bearer access-3" ? ok([]) : denied();
    });
    await client.login();
    const pending = client.request("/v1/life", z.array(z.unknown()));
    await entered.promise;
    await client.login();
    response.resolve(ok(token(2)));
    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(client.userId).toBe(nextUserId);
    expect(await client.request("/v1/life", z.array(z.unknown()))).toEqual([]);
  });
  it("does not automatically retry network errors or accept malformed success envelopes", async () => {
    const { client, platform } = setup();
    await client.login();
    platform.send = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(client.request("/v1/life", z.array(z.unknown()))).rejects.toMatchObject({
      code: "NETWORK_UNAVAILABLE",
    });
    expect(platform.send).toHaveBeenCalledTimes(1);
    platform.send = async () => ok("unexpected");
    await expect(client.request("/v1/life", z.array(z.unknown()))).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
    });
  });
  it("forbids development login in trial and release runtimes", async () => {
    const { platform } = setup();
    platform.envVersion = () => "trial";
    const client = new ApiClient({ ...config, loginMode: "mock" }, platform);
    await expect(client.login()).rejects.toMatchObject({ code: "MOCK_LOGIN_FORBIDDEN" });
    expect(platform.send).not.toHaveBeenCalled();
  });
  it("clears the local session even when remote logout fails", async () => {
    const { client, platform } = setup();
    await client.login();
    platform.send = async () => {
      throw new Error("offline");
    };
    await expect(client.logout()).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    expect(client.userId).toBeNull();
    expect(new ApiClient(config, platform).userId).toBeNull();
  });
});
