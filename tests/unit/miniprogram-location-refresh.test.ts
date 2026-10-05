import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const owner = randomUUID();
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function item(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    title: "广州书店",
    summary: null,
    kind: "PLACE",
    status: "ACTIVE",
    importance: 0.5,
    createdAt: new Date().toISOString(),
    searchText: "书店",
    displayKind: "PLACE",
    nextAt: null,
    expiresAt: null,
    hasLocation: false,
    placeLabel: "广州书店",
    distanceMeters: null,
    ...overrides,
  };
}
function mount(send: (request: any) => void) {
  let app: any,
    definition: any,
    locationCalls = 0,
    timerId = 0;
  const requests: any[] = [],
    timers = new Map<number, () => Promise<void> | void>(),
    toasts: unknown[] = [];
  const session = {
    userId: owner,
    accessToken: "test-access",
    refreshToken: "test-refresh-" + "x".repeat(40),
    expiresIn: 1200,
    expiresAt: Date.now() + 1200000,
  };
  const context = createContext(
    {
      console,
      Behavior: (input: unknown) => input,
      App: (input: unknown) => {
        app = input;
      },
      getApp: () => app,
      Page: (input: unknown) => {
        definition = input;
      },
      setTimeout: (callback: () => Promise<void> | void) => {
        const id = ++timerId;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
      wx: {
        getStorageSync: () => session,
        setStorageSync: () => {},
        removeStorageSync: () => {},
        getAppBaseInfo: () => ({ SDKVersion: "3.7.1" }),
        getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
        getWindowInfo: () => ({
          statusBarHeight: 44,
          screenHeight: 812,
          safeArea: { bottom: 778 },
        }),
        getMenuButtonBoundingClientRect: () => ({ bottom: 76 }),
        getRandomValues: ({ success }: any) =>
          success({ randomValues: new Uint8Array(randomBytes(16)).buffer }),
        nextTick: (callback: () => void) => Promise.resolve().then(callback),
        request: (request: any) => {
          requests.push(request);
          send(request);
        },
        showToast: (input: unknown) => toasts.push(input),
        navigateBack: () => {},
        getLocation: ({ fail }: any) => {
          locationCalls++;
          fail({ errMsg: "denied" });
        },
      },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  for (const path of [
    "apps/miniprogram/dist/app.js",
    "apps/miniprogram/dist/pages/life-list/index.js",
  ])
    runInContext("(function(){" + readFileSync(path, "utf8") + "\n})();", context);
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(values: object) {
      Object.assign(this.data, values);
    },
  };
  page.onLoad({ section: "RECENT" });
  return {
    page,
    requests,
    timers,
    toasts,
    locationCalls: () => locationCalls,
    async tick() {
      const entry = timers.entries().next().value;
      if (!entry) return;
      timers.delete(entry[0]);
      await entry[1]();
      await flush();
    },
  };
}
function success(request: any, data: unknown) {
  request.success({ statusCode: 200, data: { data, request_id: randomUUID() } });
}
const status = (configured: boolean) => ({
  provider: "TENCENT",
  configured,
  geocoding: configured,
  walkingRoutes: configured,
  destinationPersistence: true,
});

describe("optional location completion in the real Mini Program list bundle", () => {
  it("silently skips a missing map configuration and never obtains GPS", async () => {
    const record = item();
    const view = mount((request) =>
      success(
        request,
        request.url.endsWith("/status") ? status(false) : { items: [record], nextCursor: null },
      ),
    );
    await flush();
    expect(view.requests.some((request) => request.url.endsWith("/locations/refresh"))).toBe(false);
    expect(view.locationCalls()).toBe(0);
    expect(view.toasts).toHaveLength(0);
    expect(view.timers.size).toBe(0);
    expect(view.page.data.items[0].locationLabel).toBe("广州书店 · 待定位");
    expect(view.page.data.error).toBe("");
    view.page.onUnload();
  });
  it("limits one visit to five active unlocated objects and exactly two background reads without GPS or duplicate jobs", async () => {
    const records = [
      item({ status: "RESOLVED" }),
      item({ hasLocation: true }),
      ...Array.from({ length: 8 }, () => item()),
    ];
    let located = false;
    const view = mount((request) => {
      if (request.url.endsWith("/locations/status")) success(request, status(true));
      else if (request.url.endsWith("/locations/refresh")) {
        expect(request.data.objectIds).toHaveLength(5);
        expect(request.data.objectIds.includes(records[0]!.id)).toBe(false);
        expect(request.data.objectIds.includes(records[1]!.id)).toBe(false);
        expect(Object.keys(request.data)).toEqual(["objectIds"]);
        expect(request.header["X-Idempotency-Key"]).toMatch(/^[a-f0-9-]{36}$/);
        success(request, {
          items: request.data.objectIds.map((lifeObjectId: string) => ({
            lifeObjectId,
            eventId: randomUUID(),
            status: "QUEUED",
          })),
          replayed: false,
        });
      } else
        success(request, {
          items: records.map((record) => ({
            ...record,
            hasLocation: located || record.hasLocation,
          })),
          nextCursor: null,
        });
    });
    await flush();
    expect(
      view.requests.filter((request) => request.url.endsWith("/locations/refresh")),
    ).toHaveLength(1);
    expect(view.timers.size).toBe(1);
    located = true;
    await view.tick();
    await view.tick();
    expect(view.requests.filter((request) => request.url.endsWith("/life/search"))).toHaveLength(3);
    expect(view.timers.size).toBe(0);
    expect(view.page.data.items.every((record: any) => record.locationLabel === "已有坐标")).toBe(
      true,
    );
    await view.page.loadItems(true);
    expect(
      view.requests.filter((request) => request.url.endsWith("/locations/refresh")),
    ).toHaveLength(1);
    expect(view.locationCalls()).toBe(0);
    expect(view.toasts).toHaveLength(0);
    view.page.onUnload();
  });
  it("does not schedule polling or mutate an unloaded page after a delayed refresh receipt", async () => {
    let pending: any;
    const record = item();
    const view = mount((request) => {
      if (request.url.endsWith("/locations/status")) success(request, status(true));
      else if (request.url.endsWith("/locations/refresh")) pending = request;
      else success(request, { items: [record], nextCursor: null });
    });
    await flush();
    expect(pending).toBeDefined();
    view.page.onUnload();
    const before = JSON.parse(JSON.stringify(view.page.data));
    success(pending, {
      items: [{ lifeObjectId: record.id, eventId: randomUUID(), status: "QUEUED" }],
      replayed: false,
    });
    await flush();
    expect(view.page.data).toEqual(before);
    expect(view.timers.size).toBe(0);
    expect(view.locationCalls()).toBe(0);
  });
});
