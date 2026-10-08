import { randomBytes, randomUUID } from "node:crypto";
import { createContext } from "node:vm";
import { createNativeModuleLoader } from "../helpers/native-module-loader";
import { describe, expect, it } from "vitest";

const userId = randomUUID();
const requestId = randomUUID();
const settings = () => ({
  recommendation: {
    relaxation: "ANY",
    defaultMinutes: 30,
    defaultBudget: null,
    goingOut: "UNKNOWN",
    homeRegion: "",
    frequentAreas: [],
  },
  privacy: { useLocation: false },
  notifications: { enabled: false },
  onboardingCompleted: false,
  updatedAt: null,
});
const capabilities = () => ({
  ticketVerification: { available: false, reason: "NOT_INTEGRATED" },
  reminderDelivery: { available: false, reason: "NOT_INTEGRATED" },
  mediaArchive: { available: true, reason: "AVAILABLE" },
  recordExport: { available: true, reason: "AVAILABLE" },
});
function success(options: any, data: unknown) {
  options.success({ statusCode: 200, data: { data, request_id: requestId } });
}
function mount(
  route: "life-list" | "life-detail",
  send: (options: any) => void,
  extras: Record<string, any> = {},
) {
  let app: any;
  let definition: any;
  const storage = new Map<string, unknown>();
  const navigations: string[] = [];
  const removedFiles: string[] = [];
  const writtenFiles: { path: string; text: string }[] = [];
  let sessionKey: string | null = null;
  const initialSession = {
    userId,
    accessToken: "test-access",
    refreshToken: "test-refresh-" + "x".repeat(40),
    expiresIn: 1200,
    expiresAt: Date.now() + 1200000,
  };
  const fileSystem = {
    writeFile(options: any) {
      writtenFiles.push({ path: options.filePath, text: options.data });
      options.success?.();
    },
    appendFile(options: any) {
      const existing = writtenFiles.find((entry) => entry.path === options.filePath);
      if (existing) existing.text += options.data;
      options.success?.();
    },
    unlink(options: any) {
      removedFiles.push(options.filePath);
      options.success?.();
    },
    readdirSync: () => [],
  };
  const context = createContext(
    {
      console,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      Behavior: (value: unknown) => value,
      App: (value: unknown) => {
        app = value;
      },
      getApp: () => app,
      getCurrentPages: () => [{ route: "home" }, { route }],
      Page: (value: unknown) => {
        definition = value;
      },
      wx: {
        env: { USER_DATA_PATH: "/user-data" },
        getStorageSync: (key: string) => {
          // Seed the compiled client's actual session namespace exactly once.
          // Local staging builds must exercise the same authenticated flows as CI.
          if (
            sessionKey === null &&
            /^kairos:(develop|staging|production):[^:]+:https?:\/\//.test(key)
          ) {
            sessionKey = key;
            storage.set(key, initialSession);
          }
          return storage.get(key);
        },
        setStorageSync: (key: string, value: unknown) => storage.set(key, value),
        removeStorageSync: (key: string) => storage.delete(key),
        getAppBaseInfo: () => ({ SDKVersion: "3.7.1" }),
        getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
        getWindowInfo: () => ({
          statusBarHeight: 44,
          screenHeight: 812,
          safeArea: { bottom: 778 },
        }),
        getMenuButtonBoundingClientRect: () => ({ bottom: 76 }),
        getRandomValues: ({ success: done }: any) =>
          done({ randomValues: new Uint8Array(randomBytes(16)).buffer }),
        nextTick: (callback: () => void) => Promise.resolve().then(callback),
        request: send,
        getFileSystemManager: () => fileSystem,
        navigateTo: ({ url }: any) => navigations.push(url),
        redirectTo: ({ url }: any) => navigations.push(url),
        reLaunch: ({ url }: any) => navigations.push(url),
        navigateBack: () => navigations.push("back"),
        shareFileMessage: extras.shareFileMessage ?? (() => Promise.resolve({})),
        ...extras.wx,
      },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  const native = createNativeModuleLoader(context);
  native.runEntry("app.js");
  native.runEntry(`pages/${route}/index.js`);
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(values: object) {
      Object.assign(this.data, values);
    },
    services: app.globalData,
    navigations,
    removedFiles,
    writtenFiles,
    onLoad: definition.onLoad,
  };
  if (route === "life-detail") page.onLoad({ id: randomUUID() });
  else page.onLoad(extras.loadOptions ?? {});
  return page;
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function detail(overrides: Record<string, any> = {}) {
  return {
    id: randomUUID(),
    title: "广州图书馆",
    summary: "真实正文",
    kind: "PLACE",
    status: "ACTIVE",
    objectVersion: 1,
    createdAt: "2026-10-07T08:00:00.000Z",
    updatedAt: "2026-10-07T08:00:00.000Z",
    myRating: "NONE",
    facets: [],
    sources: [],
    verifiedDestination: null,
    selectedDestination: null,
    ...overrides,
  };
}
function detailSend(record: any, fallback: (options: any) => void) {
  return (options: any) => {
    if (options.url.endsWith("/ui-capabilities")) success(options, capabilities());
    else if (options.url.includes("/v1/life/") && options.method === "GET")
      success(options, record);
    else fallback(options);
  };
}

describe("native life list and detail closed flows", () => {
  it("searches all recorded statuses server-side across filters and continuation pages", async () => {
    const requests: any[] = [];
    const page = mount(
      "life-list",
      (options) => {
        requests.push(options);
        success(options, { items: [], nextCursor: "next-page" });
      },
      { loadOptions: { mode: "search", kind: "PLACE" } },
    );
    await flush();
    expect(page.data.title).toBe("搜索");
    expect(requests[0].url).toContain("/life/search");
    expect(requests[0].data.scope).toBe("ALL_RECORDED");
    page.searchInput({ detail: { value: "原始关键词" } });
    page.submitSearch();
    await flush();
    expect(requests.at(-1).data).toMatchObject({
      query: "原始关键词",
      scope: "ALL_RECORDED",
      kind: "PLACE",
    });
    page.loadMore();
    await flush();
    expect(requests.at(-1).data.cursor).toBe("next-page");
    page.selectKind({ currentTarget: { dataset: { index: 0 } } });
    await flush();
    expect(requests.at(-1).data.kind).toBeUndefined();
    expect(requests.at(-1).data.cursor).toBeUndefined();
    expect(page.data.title).toBe("搜索");
    page.onUnload();
  });
  it.each([false, true])(
    "honors one-time location consent without writing preferences (confirm=%s)",
    async (confirm) => {
      let gps = 0,
        prompts = 0;
      const writes: any[] = [];
      const page = mount(
        "life-list",
        (options) => {
          if (options.url.endsWith("/settings")) success(options, settings());
          else {
            writes.push(options);
            success(options, { items: [], nextCursor: null });
          }
        },
        {
          wx: {
            showModal: () => {
              prompts++;
              return Promise.resolve({ confirm });
            },
            getLocation: (options: any) => {
              gps++;
              options.success({ latitude: 23.1, longitude: 113.2 });
            },
          },
        },
      );
      await flush();
      await page.setLocation({ detail: { value: "3" } });
      await flush();
      expect(prompts).toBe(1);
      expect(gps).toBe(confirm ? 1 : 0);
      expect(page.data.locationIndex).toBe(confirm ? 3 : 0);
      expect(writes.every((request) => request.url.endsWith("/life/search"))).toBe(true);
      page.onHide();
      page.onShow();
      await flush();
      expect(gps).toBe(confirm ? 1 : 0);
      page.onUnload();
    },
  );
  it("fails closed before GPS when settings cannot be read or the owner changes while consent is pending", async () => {
    let gps = 0;
    const page = mount(
      "life-list",
      (options) => {
        if (options.url.endsWith("/settings")) options.fail({ errMsg: "request:fail" });
        else success(options, { items: [], nextCursor: null });
      },
      { wx: { getLocation: () => gps++ } },
    );
    await flush();
    await page.setLocation({ detail: { value: "3" } });
    expect(gps).toBe(0);
    expect(page.data.error).toContain("未获取位置");
    page.onUnload();
    let decide!: (result: any) => void;
    const second = mount(
      "life-list",
      (options) =>
        success(
          options,
          options.url.endsWith("/settings") ? settings() : { items: [], nextCursor: null },
        ),
      {
        wx: {
          showModal: () =>
            new Promise((resolve) => {
              decide = resolve;
            }),
          getLocation: () => gps++,
        },
      },
    );
    await flush();
    const operation = second.setLocation({ detail: { value: "3" } });
    await flush();
    second.services.client.clear();
    second.onHide();
    second.onShow();
    decide({ confirm: true });
    await operation;
    await flush();
    expect(gps).toBe(0);
    expect(second.data.loggedIn).toBe(false);
    second.onUnload();
  });
  it("keeps expired coordinates for pagination and resets nearby after an account change without requesting GPS", async () => {
    let gps = 0;
    const queries: any[] = [];
    const page = mount(
      "life-list",
      (options) => {
        if (options.url.endsWith("/settings"))
          success(options, { ...settings(), privacy: { useLocation: true } });
        else {
          queries.push(options);
          success(options, { items: [], nextCursor: "next" });
        }
      },
      {
        wx: {
          getLocation: (options: any) => {
            gps++;
            options.success({ latitude: 23.1, longitude: 113.2 });
          },
        },
      },
    );
    await flush();
    await page.setLocation({ detail: { value: "3" } });
    await flush();
    expect(gps).toBe(1);
    page.runtime.center.acquiredAt = Date.now() - 10 * 60000;
    await page.loadItems();
    expect(gps).toBe(1);
    expect(queries.at(-1).data.location).toBe("NEARBY");
    page.services.client.clear();
    page.onHide();
    page.onShow();
    await flush();
    expect(page.data.locationIndex).toBe(0);
    expect(gps).toBe(1);
    page.onUnload();
  });
  it("keeps a native picker result across hide/show, saves only after confirmation, and retries the same write key", async () => {
    let native: any;
    const writes: any[] = [],
      opened: any[] = [];
    const record = detail();
    const page = mount(
      "life-detail",
      detailSend(record, (options) => {
        if (options.url.endsWith("/picker-intents"))
          success(options, {
            lifeObjectId: options.data.lifeObjectId,
            intentToken: "real-test-intent",
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          });
        else if (options.url.endsWith("/map-select")) {
          writes.push(options);
          if (writes.length === 1) options.fail({ errMsg: "lost receipt" });
          else {
            record.selectedDestination = {
              ...options.data.location,
              name: options.data.name,
              address: options.data.address,
              source: "USER_SELECTED_MAP",
            };
            success(options, {
              lifeObjectId: options.data.lifeObjectId,
              selected: true,
              replayed: true,
            });
          }
        }
      }),
      {
        wx: {
          chooseLocation: (options: any) => {
            native = options;
          },
          openLocation: (options: any) => opened.push(options),
        },
      },
    );
    await flush();
    page.services.routeCache.set(userId, page.runtime.id, { view: {}, departureReason: "旧路线" });
    await page.choosePlace();
    expect(writes).toHaveLength(0);
    page.onHide();
    native.success({
      name: "广州图书馆",
      address: "珠江东路4号",
      latitude: 23.117,
      longitude: 113.325,
    });
    expect(page.data.mapSelection).toBeNull();
    page.onShow();
    await flush();
    expect(page.data.mapSelection.name).toBe("广州图书馆");
    await page.confirmMapSelection();
    await flush();
    expect(writes).toHaveLength(1);
    expect(page.data.locationNotice).toBe("");
    expect(page.data.mapSelection).not.toBeNull();
    expect(page.services.routeCache.get(userId, page.runtime.id)).toBeNull();
    await page.confirmMapSelection();
    await flush();
    expect(writes).toHaveLength(2);
    expect(writes[0].header["X-Idempotency-Key"]).toBe(writes[1].header["X-Idempotency-Key"]);
    expect(page.data.detail.selectedDestination.source).toBe("USER_SELECTED_MAP");
    expect(page.data.detail.verifiedDestination).toBeNull();
    expect(page.data.mapSelection).toBeNull();
    page.openMap();
    expect(opened[0]).toMatchObject({
      latitude: 23.117,
      longitude: 113.325,
      name: "广州图书馆",
      address: "珠江东路4号",
    });
    page.onUnload();
  });
  it("does not save or display an old account's native selection after switching accounts", async () => {
    let native: any;
    const writes: any[] = [];
    const page = mount(
      "life-detail",
      detailSend(detail(), (options) => {
        if (options.url.endsWith("/picker-intents"))
          success(options, {
            lifeObjectId: options.data.lifeObjectId,
            intentToken: "intent",
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          });
        else writes.push(options);
      }),
      {
        wx: {
          chooseLocation: (options: any) => {
            native = options;
          },
        },
      },
    );
    await flush();
    await page.choosePlace();
    page.services.client.clear();
    page.onHide();
    page.onShow();
    native.success({ name: "旧账户地点", address: "旧地址", latitude: 23.1, longitude: 113.2 });
    await page.confirmMapSelection();
    await flush();
    expect(writes).toHaveLength(0);
    expect(page.data.mapSelection).toBeNull();
    expect(page.data.detail).toBeNull();
    page.onUnload();
  });
  it("restores an available secondary image and deletes its temporary file on unload", async () => {
    const textSource = randomUUID(),
      imageSource = randomUUID();
    const record = detail({
      sources: [textSource, imageSource].map((id, i) => ({
        id: randomUUID(),
        sourceType: "CAPTURE",
        sourceId: id,
        isPrimary: i === 0,
        createdAt: "2026-10-07T08:00:00.000Z",
      })),
    });
    const imageRequests: string[] = [];
    const page = mount(
      "life-detail",
      detailSend(record, (options) => {
        imageRequests.push(options.url);
        success(options, {
          image: options.url.includes(textSource)
            ? null
            : {
                mimeType: "image/png",
                base64:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==",
              },
        });
      }),
    );
    await flush();
    await flush();
    expect(imageRequests).toHaveLength(2);
    expect(page.data.heroImagePath).not.toBe("");
    const path = page.data.heroImagePath;
    page.onUnload();
    expect(page.removedFiles).toContain(path);
  });
  it("resumes a source read interrupted by native page hiding and ignores the earlier response", async () => {
    const id = randomUUID(),
      pending: any[] = [];
    const record = detail({
      sources: [
        {
          id: randomUUID(),
          sourceType: "CAPTURE",
          sourceId: id,
          isPrimary: true,
          createdAt: "2026-10-07T08:00:00.000Z",
        },
      ],
    });
    const page = mount(
      "life-detail",
      detailSend(record, (options) => {
        if (options.url.endsWith("/image")) success(options, { image: null });
        else pending.push(options);
      }),
    );
    await flush();
    const opened = page.openSource({ currentTarget: { dataset: { id } } });
    await flush();
    expect(pending).toHaveLength(1);
    page.onHide();
    page.onShow();
    await flush();
    expect(pending).toHaveLength(2);
    const source = {
      id,
      type: "TEXT",
      status: "READY",
      title: "原文",
      text: "返回后原文",
      summary: null,
      createdAt: "2026-10-07T08:00:00.000Z",
      updatedAt: "2026-10-07T08:00:00.000Z",
    };
    success(pending[1], source);
    await flush();
    success(pending[0], { ...source, text: "迟到的原文" });
    await opened;
    await flush();
    expect(page.data.sourceText).toBe("返回后原文");
    expect(page.data.sourceLoading).toBe(false);
    page.onUnload();
  });
  it.each(["life-list", "life-detail"] as const)(
    "clears private data and loading immediately when %s session refresh fails",
    async (route) => {
      let expired = false;
      const sourceId = randomUUID();
      const record = detail({
        sources: [
          {
            id: randomUUID(),
            sourceType: "CAPTURE",
            sourceId,
            isPrimary: true,
            createdAt: "2026-10-07T08:00:00.000Z",
          },
        ],
      });
      const item = {
        ...record,
        importance: 0.5,
        searchText: null,
        displayKind: null,
        nextAt: null,
        expiresAt: null,
        hasLocation: false,
        distanceMeters: null,
      };
      const page = mount(route, (options) => {
        if (expired) {
          options.success({ statusCode: 401, data: { error: { code: "TOKEN_EXPIRED" } } });
          return;
        }
        if (options.url.endsWith("/ui-capabilities")) success(options, capabilities());
        else if (options.url.endsWith("/image"))
          success(options, {
            image: {
              mimeType: "image/png",
              base64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==",
            },
          });
        else success(options, route === "life-list" ? { items: [item], nextCursor: null } : record);
      });
      await flush();
      await flush();
      if (route === "life-list") expect(page.data.items).toHaveLength(1);
      else expect(page.data.heroImagePath).not.toBe("");
      expired = true;
      if (route === "life-list") await page.loadItems(true);
      else await page.loadDetail();
      await flush();
      expect(page.services.client.userId).toBeNull();
      expect(page.data.loggedIn).toBe(false);
      expect(page.data.loading).toBe(false);
      if (route === "life-list") {
        expect(page.data.items).toEqual([]);
        expect(page.data.groups).toEqual([]);
        expect(page.data.locating).toBe(false);
      } else {
        expect(page.data.detail).toBeNull();
        expect(page.data.busy).toBe(false);
        expect(page.data.heroImagePath).toBe("");
        expect(page.removedFiles).toHaveLength(1);
      }
      page.onUnload();
      expect(page.runtime.identityDispose).toBeUndefined();
    },
  );
  it("confirms deletion, invalidates the old route and retries a lost receipt using the same key", async () => {
    const writes: any[] = [];
    const page = mount(
      "life-detail",
      detailSend(detail(), (options) => {
        writes.push(options);
        if (writes.length === 1) options.fail({ errMsg: "lost delete receipt" });
        else success(options, { id: page.runtime.id, deleted: true, replayed: true });
      }),
      { wx: { showModal: () => Promise.resolve({ confirm: true }) } },
    );
    await flush();
    page.services.routeCache.set(userId, page.runtime.id, { view: {}, departureReason: "旧路线" });
    await page.remove();
    expect(page.navigations).toEqual([]);
    expect(page.services.routeCache.get(userId, page.runtime.id)).toBeNull();
    await page.remove();
    expect(writes).toHaveLength(2);
    expect(writes[0].method).toBe("DELETE");
    expect(writes[0].header["X-Idempotency-Key"]).toBe(writes[1].header["X-Idempotency-Key"]);
    expect(page.navigations).toEqual(["back"]);
    page.onUnload();
  });
  it.each(["windowEnd", "eventEnd"])(
    "shows a ticket's explicit %s as its expiry without inventing a reminder time",
    async (field) => {
      const record = detail({
        kind: "ASSET",
        facets: [
          {
            id: randomUUID(),
            facetType: "ASSET",
            facetKey: "voucher",
            confidence: 1,
            data: {
              facts: {
                origin: "USER_STATED",
                evidence: "原券有效至10月20日",
                time: { [field]: "2026-10-20" },
              },
            },
          },
        ],
      });
      const page = mount(
        "life-detail",
        detailSend(record, () => {}),
      );
      await flush();
      expect(page.data.view.deadline).toBe("2026-10-20");
      expect(page.data.view.remindAt).toBe("");
      page.onUnload();
    },
  );
  it("finds an explicit deadline across facets instead of letting a start-only or inferred facet hide it", async () => {
    const facet = (key: string, origin: string, time: object) => ({
      id: randomUUID(),
      facetType: "ASSET",
      facetKey: key,
      confidence: 1,
      data: { facts: { origin, evidence: "原券时间", time } },
    });
    const deadline = "2026-10-20T12:00:00.000Z";
    const record = detail({
      kind: "ASSET",
      facets: [
        facet("opens", "USER_STATED", { windowStart: "2026-10-01" }),
        facet("guess", "INFERRED", { deadline: "2026-10-30T12:00:00.000Z" }),
        facet("expiry", "USER_STATED", { deadline }),
      ],
    });
    const page = mount(
      "life-detail",
      detailSend(record, () => {}),
    );
    await flush();
    expect(page.data.view.deadline).toContain("2026年10月20日");
    expect(page.data.view.deadline).not.toContain("待核对");
    expect(page.data.view.remindAt).toBe(deadline);
    page.onUnload();
    const inferred = mount(
      "life-detail",
      detailSend(
        detail({ kind: "ASSET", facets: [facet("guess", "INFERRED", { windowEnd: deadline })] }),
        () => {},
      ),
    );
    await flush();
    expect(inferred.data.view.deadline).toContain("待核对");
    expect(inferred.data.view.remindAt).toBe("");
    inferred.onUnload();
  });
  it("labels an event's start and cutoff separately rather than showing its start as expiry", async () => {
    const record = detail({
      kind: "EVENT",
      facets: [
        {
          id: randomUUID(),
          facetType: "EVENT",
          facetKey: "event",
          confidence: 1,
          data: {
            facts: {
              origin: "USER_STATED",
              evidence: "活动时间",
              time: {
                eventStart: "2026-10-20T12:00:00.000Z",
                eventEnd: "2026-10-21T12:00:00.000Z",
              },
            },
          },
        },
      ],
    });
    const page = mount(
      "life-detail",
      detailSend(record, () => {}),
    );
    await flush();
    expect(page.data.view.deadline).toContain("开始：2026年10月20日");
    expect(page.data.view.deadline).toContain("截止：2026年10月21日");
    expect(page.data.view.remindAt).toBe("2026-10-20T12:00:00.000Z");
    page.onUnload();
  });
  it("does not submit ratings for an archived detail", async () => {
    const writes: any[] = [];
    const page = mount(
      "life-detail",
      detailSend(detail({ status: "ARCHIVED" }), (options) => writes.push(options)),
    );
    await flush();
    await page.rate({ currentTarget: { dataset: { rating: "LIKE" } } });
    expect(writes).toHaveLength(0);
    page.onUnload();
  });
});
