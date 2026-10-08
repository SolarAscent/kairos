import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { createContext } from "node:vm";
import { createNativeModuleLoader } from "../helpers/native-module-loader";
import { describe, expect, it } from "vitest";
import { userSettingsResponseSchema } from "@life/contracts";

const requestId = randomUUID();
const userId = randomUUID();
function mount(
  send: (options: any) => void,
  nonCallableFunction = false,
  route = "home",
  wxExtras: Record<string, unknown> = {},
  runtimeExtras: Record<string, unknown> = {},
  loadOptions: Record<string, string> = { section: "RECENT" },
) {
  let definition: any;
  let app: any;
  const navigations: string[] = [];
  const toasts: any[] = [];
  let locationCalls = 0;
  const storage = new Map<string, unknown>();
  storage.set("kairos:develop:touristappid:http://127.0.0.1:3000", {
    userId,
    accessToken: "test-access",
    refreshToken: "test-refresh-" + "x".repeat(40),
    expiresIn: 1200,
    expiresAt: Date.now() + 1200000,
  });
  const context = createContext(
    {
      console,
      ...(nonCallableFunction
        ? {
            Function: function () {
              return {};
            },
          }
        : {}),
      setTimeout,
      clearTimeout,
      ...runtimeExtras,
      Behavior: (options: unknown) => options,
      App: (options: unknown) => {
        app = options;
      },
      getApp: () => app,
      Page: (options: unknown) => {
        definition = options;
      },
      wx: {
        getStorageSync: (key: string) => storage.get(key) ?? storage.values().next().value,
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
        getRandomValues: ({ success }: any) =>
          success({ randomValues: new Uint8Array(randomBytes(16)).buffer }),
        nextTick: (callback: () => void) => Promise.resolve().then(callback),
        request: (options: any) => {
          // Existing route fixtures assume explicit long-term location consent.
          // Tests for consent denial override wx.request rather than this default.
          if (options.url.endsWith("/v1/settings"))
            success(
              options,
              userSettingsResponseSchema.parse({
                recommendation: {},
                privacy: { useLocation: true },
                notifications: {},
                onboardingCompleted: true,
                updatedAt: null,
              }),
            );
          else send(options);
        },
        showToast: (options: any) => toasts.push(options),
        navigateTo: ({ url }: any) => navigations.push(url),
        navigateBack: () => {},
        getLocation: ({ fail }: any) => {
          locationCalls++;
          fail({ errMsg: "denied" });
        },
        ...wxExtras,
      },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  const native = createNativeModuleLoader(context);
  native.runEntry("app.js");
  function loadRoute(name: string) {
    native.runEntry(
      name === "home" && process.env.MINIPROGRAM_TEST_BUNDLE
        ? resolve(process.env.MINIPROGRAM_TEST_BUNDLE)
        : `pages/${name}/index.js`,
    );
  }
  loadRoute(route);
  const initialDefinition = definition;
  function openRoute(name: string) {
    loadRoute(name);
    return createInstance(definition);
  }
  function createInstance(pageDefinition = initialDefinition) {
    const page = {
      ...pageDefinition,
      data: JSON.parse(JSON.stringify(pageDefinition.data)),
      setData(values: object) {
        Object.assign(this.data, values);
      },
      createInstance: () => createInstance(pageDefinition),
      openRoute,
      navigations,
      toasts,
      locationCalls: () => locationCalls,
      services: app.globalData,
    };
    page.onLoad(loadOptions);
    return page;
  }
  return createInstance();
}
function success(options: any, data: unknown) {
  if (/\/captures\/page(?:\?|$)/.test(options.url) && Array.isArray(data))
    data = { items: data, nextCursor: null };
  options.success({ statusCode: 200, data: { data, request_id: requestId } });
}
describe("compiled personal-profile page", () => {
  function profile(extra: object = {}) {
    return {
      userId,
      nickname: "散步的人",
      bio: "喜欢阅读",
      avatarVersion: null,
      identityProvider: "WECHAT",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-06T00:00:00.000Z",
      ...extra,
    };
  }
  it("loads account metadata, preserves edits across native picker hide/show, and saves into the shared home state", async () => {
    const writes: any[] = [];
    const page = mount(
      (options) => {
        if (options.method === "POST") {
          writes.push(options);
          success(options, profile(options.data));
        } else success(options, profile());
      },
      true,
      "profile",
    );
    await page.loadProfile();
    expect(page.data.nickname).toBe("散步的人");
    expect(page.data.wechatLinked).toBe(true);
    page.editNickname({ detail: { value: "新的称呼" } });
    page.editBio({ detail: { value: "新的简介" } });
    page.onShow();
    expect(page.data.nickname).toBe("新的称呼");
    await page.saveProfile();
    expect(writes[0].data).toEqual({ nickname: "新的称呼", bio: "新的简介" });
    expect(page.data.dirty).toBe(false);
    expect(page.data.notice).toBe("个人资料已保存");
    expect(page.services.sessionStore.nickname).toBe("新的称呼");
    page.onUnload();
  });
  it("preserves a failed draft and its operation key, then uses a new key after edits", async () => {
    const writes: any[] = [];
    const page = mount(
      (options) => {
        if (options.method === "POST") {
          writes.push(options);
          options.fail({ errMsg: "offline" });
        } else success(options, profile());
      },
      false,
      "profile",
    );
    await page.loadProfile();
    page.editNickname({ detail: { value: "暂未保存" } });
    await page.saveProfile();
    await page.saveProfile();
    expect(page.data.nickname).toBe("暂未保存");
    expect(page.data.dirty).toBe(true);
    expect(writes[0].header["X-Idempotency-Key"]).toBe(writes[1].header["X-Idempotency-Key"]);
    page.editNickname({ detail: { value: "另一个称呼" } });
    await page.saveProfile();
    expect(writes[2].header["X-Idempotency-Key"]).not.toBe(writes[1].header["X-Idempotency-Key"]);
    expect(page.toasts).toHaveLength(0);
    page.onUnload();
  });
  it("does not label a development account as linked to WeChat", async () => {
    const page = mount(
      (options) => success(options, profile({ identityProvider: "DEVELOPMENT" })),
      false,
      "profile",
    );
    await page.loadProfile();
    expect(page.data.wechatLinked).toBe(false);
    expect(page.data.identityLabel).toBe("开发体验账号");
    page.onUnload();
  });
  it("downloads private avatar bytes to a local image and removes the cache on logout", async () => {
    const version = randomUUID(),
      files = new Map<string, string>();
    const image = { mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" };
    const page = mount(
      (options) =>
        success(
          options,
          options.url.endsWith("/avatar")
            ? { avatarVersion: version, image }
            : profile({ avatarVersion: version }),
        ),
      false,
      "profile",
      {
        env: { USER_DATA_PATH: "/user-data" },
        getFileSystemManager: () => ({
          writeFileSync: (path: string, bytes: string) => files.set(path, bytes),
          unlinkSync: (path: string) => files.delete(path),
        }),
      },
    );
    await page.loadProfile();
    expect(page.data.avatarPath).toContain(`${userId}-${version}.png`);
    expect(files.get(page.data.avatarPath)).toBe(image.base64);
    page.services.client.clear();
    expect(files.size).toBe(0);
    expect(page.services.sessionStore.avatarPath).toBe("");
    page.onUnload();
  });
  it("ignores a delayed load after logout without restoring user content", async () => {
    let pending: any;
    const page = mount(
      (options) => {
        pending = options;
      },
      false,
      "profile",
    );
    const loading = page.loadProfile();
    await new Promise((resolve) => setTimeout(resolve, 0));
    page.services.client.clear();
    success(pending, profile());
    await loading;
    expect(page.data.nickname).toBe("");
    expect(page.services.sessionStore.nickname).toBe("");
    page.onUnload();
  });
  it("blocks an oversized nickname and confirms leaving unsaved edits", async () => {
    const modals: any[] = [];
    const page = mount((options) => success(options, profile()), false, "profile", {
      showModal: (options: any) => modals.push(options),
    });
    await page.loadProfile();
    page.editNickname({ detail: { value: "长".repeat(33) } });
    await page.saveProfile();
    expect(page.data.error).toContain("昵称最多");
    page.goBack();
    expect(modals[0].title).toBe("还有未保存的修改");
    page.onUnload();
  });
  it("returns to a clean home after logout from the separate profile page", async () => {
    const home = mount((options) => success(options, []));
    home.setData({
      draft: "旧账号内容",
      recommendation: { headline: "旧建议" },
      cards: [{ id: "old" }],
    });
    home.services.client.clear();
    home.onShow();
    expect(home.data.draft).toBe("");
    expect(home.data.recommendation).toBeNull();
    expect(home.data.cards).toEqual([]);
    home.onUnload();
  });
});
describe("compiled Mini Program page in a restricted JS runtime", () => {
  it("disables Zod JIT before contracts when Function returns a non-callable object", async () => {
    const page = mount((options) => {
      if (options.method === "POST")
        success(options, {
          captureId: randomUUID(),
          status: "UPLOADED",
          accepted: true,
          replayed: false,
        });
      else success(options, []);
    }, true);
    expect(page.data.userId).toBe(userId);
    page.setData({ draft: "微信运行时仍能留下文字" });
    await page.saveCapture();
    expect(page.data.draft).toBe("");
    expect(page.data.notice).toBe("收纳好了");
    expect(page.data.error).toBe("");
    page.onUnload();
  });
  it("initializes MobX and Zod without eval, browser globals or Node globals", () => {
    const page = mount(() => {});
    expect(page.data.userId).toBe(userId);
    expect(page.data.topInset).toBe(92);
    page.onUnload();
  });
  it("preserves text and UUID after a lost save response, then clears only after receipt", async () => {
    const writes: any[] = [];
    const page = mount((options) => {
      if (options.method === "POST") {
        writes.push(options);
        if (writes.length === 1) options.fail({ errMsg: "offline" });
        else
          success(options, {
            captureId: randomUUID(),
            status: "UPLOADED",
            accepted: true,
            replayed: true,
          });
      } else success(options, []);
    });
    page.setData({ draft: "想去看海", sheet: true });
    await page.saveCapture();
    expect(page.data.draft).toBe("想去看海");
    expect(page.data.sheet).toBe(false);
    expect(page.data.cards[0].phase).toBe("FAILED_LOCAL");
    expect(page.toasts).toHaveLength(0);
    expect(page.data.error).toContain("暂时连接不上");
    await page.saveCapture();
    expect(writes).toHaveLength(2);
    expect(writes[0].header["X-Idempotency-Key"]).toBe(writes[1].header["X-Idempotency-Key"]);
    expect(writes[1].data.sourceChannel).toBe("MINIPROGRAM");
    expect(page.data.draft).toBe("");
    expect(page.data.notice).toBe("收纳好了");
    page.onUnload();
  });
  it("creates a new operation key when a failed draft is changed", async () => {
    const writes: any[] = [];
    const page = mount((options) => {
      writes.push(options);
      options.fail({ errMsg: "offline" });
    });
    page.setData({ draft: "第一句话" });
    await page.saveCapture();
    page.setData({ draft: "另一句话" });
    await page.saveCapture();
    expect(writes[0].header["X-Idempotency-Key"]).not.toBe(writes[1].header["X-Idempotency-Key"]);
    page.onUnload();
  });
  it("keeps retry identities independent across page instances", async () => {
    const writes: any[] = [];
    const first = mount((options) => {
      writes.push(options);
      options.fail({ errMsg: "offline" });
    });
    first.setData({ draft: "同样的内容" });
    await first.saveCapture();
    const second = first.createInstance();
    second.setData({ draft: "同样的内容" });
    await second.saveCapture();
    first.onUnload();
    await second.saveCapture();
    expect(writes[0].header["X-Idempotency-Key"]).not.toBe(writes[1].header["X-Idempotency-Key"]);
    expect(writes[1].header["X-Idempotency-Key"]).toBe(writes[2].header["X-Idempotency-Key"]);
    second.onUnload();
  });
  it("ignores a save receipt after unload and does not start list requests", async () => {
    let receive!: (options: any) => void;
    const sent = new Promise<any>((resolve) => {
      receive = resolve;
    });
    let requests = 0;
    const page = mount((options) => {
      requests++;
      receive(options);
    });
    page.setData({ draft: "稍后收到回执" });
    const saving = page.saveCapture();
    const options = await sent;
    page.onUnload();
    const before = { ...page.data };
    success(options, {
      captureId: randomUUID(),
      status: "UPLOADED",
      accepted: true,
      replayed: false,
    });
    await saving;
    expect(page.data).toEqual(before);
    expect(requests).toBe(1);
  });
  it("does not request a new decision when a skip receipt arrives after unload", async () => {
    let receive!: (options: any) => void;
    const sent = new Promise<any>((resolve) => {
      receive = resolve;
    });
    let requests = 0;
    const page = mount((options) => {
      requests++;
      receive(options);
    });
    page.setData({ sessionId: randomUUID(), recommendation: { targetLifeObjectId: randomUUID() } });
    const feedback = page.feedback({ currentTarget: { dataset: { type: "SKIP" } } });
    const options = await sent;
    page.onUnload();
    success(options, {
      feedbackId: randomUUID(),
      eventType: "SKIP",
      replayedClientEvent: false,
      replayed: false,
    });
    await feedback;
    expect(requests).toBe(1);
  });
  it("keeps feedback identity on retry and does not resend an acknowledged skip", async () => {
    const feedback: any[] = [];
    const decisions: any[] = [];
    const target = randomUUID();
    const page = mount((options) => {
      if (options.url.endsWith("/feedback")) {
        feedback.push(options);
        if (feedback.length === 1) options.fail({ errMsg: "offline" });
        else
          success(options, {
            feedbackId: randomUUID(),
            eventType: "SKIP",
            replayedClientEvent: true,
            replayed: true,
          });
      } else {
        decisions.push(options);
        if (decisions.length === 1) options.fail({ errMsg: "offline" });
        else
          success(options, {
            sessionId: randomUUID(),
            status: "QUIET",
            recommendation: null,
            candidates: [],
            replayed: true,
          });
      }
    });
    page.setData({ sessionId: randomUUID(), recommendation: { targetLifeObjectId: target } });
    const event = { currentTarget: { dataset: { type: "SKIP" } } };
    await page.feedback(event);
    await page.feedback(event);
    await page.decide();
    expect(feedback).toHaveLength(2);
    expect(feedback[0].data.clientEventId).toBe(feedback[1].data.clientEventId);
    expect(decisions[0].data.excludeObjectIds).toEqual([target]);
    expect(decisions[0].header["X-Idempotency-Key"]).toBe(decisions[1].header["X-Idempotency-Key"]);
    expect(page.data.decided).toBe(true);
    page.onUnload();
  });
});

function lifeItem(title: string) {
  return {
    id: randomUUID(),
    title,
    summary: null,
    kind: "DESIRE",
    status: "ACTIVE",
    importance: 0.58,
    createdAt: new Date().toISOString(),
    searchText: title,
    displayKind: "DESIRE",
    nextAt: null,
    expiresAt: null,
    hasLocation: false,
    distanceMeters: null,
  };
}
const flushPage = () => new Promise<void>((resolve) => setImmediate(resolve));
describe("Category stacks, persisted preference and wish removal", () => {
  const group = (items: any[], nextCursor: string | null = null) => ({
    kind: items[0].kind,
    title: items[0].kind === "MEDIA" ? "内容" : "愿望",
    items,
    nextCursor,
    asOf: new Date().toISOString(),
  });
  it("preserves backend preference order, keeps every loaded card and pages each category independently", async () => {
    const wishes = Array.from({ length: 10 }, (_, i) => lifeItem(`念头 ${i}`));
    const media = { ...lifeItem("一部可能喜欢的纪录片"), kind: "MEDIA", preferenceScore: 0.8 };
    const extra = lifeItem("第十一张");
    const pages: any[] = [];
    const page = mount((options) => {
      if (options.url.endsWith("/stacks"))
        success(options, [group(wishes, "desire-cursor"), group([media])]);
      else {
        pages.push(options.data);
        success(options, {
          items: [wishes[9], extra],
          nextCursor: null,
          asOf: new Date().toISOString(),
        });
      }
    });
    await page.loadLifeStacks();
    expect(page.data.lifeStacks.map((item: any) => item.kind)).toEqual(["DESIRE", "MEDIA"]);
    expect(page.data.lifeStacks[0].items.map((item: any) => item.id)).toEqual(
      wishes.map((item) => item.id),
    );
    expect(page.locationCalls()).toBe(0);
    page.stackTouchStart();
    expect(page.data.stackDragging).toBe(true);
    page.setStackCurrent("DESIRE", 8);
    page.stackTouchEnd();
    await flushPage();
    expect(pages).toEqual([{ kind: "DESIRE", cursor: "desire-cursor", limit: 20 }]);
    expect(page.data.lifeStacks[0].items).toHaveLength(11);
    expect(page.data.lifeStacks[0].current).toBe(8);
    expect(page.data.lifeStacks[1].items[0].id).toBe(media.id);
    expect(page.data.stackDragging).toBe(false);
    page.onUnload();
  });
  it("persists votes before selecting them, reuses lost-response keys and sends NONE when tapping the selected vote", async () => {
    const item = lifeItem("想读的书");
    const writes: any[] = [];
    const page = mount((options) => {
      if (options.url.endsWith("/stacks")) success(options, [group([item])]);
      else {
        writes.push(options);
        if (writes.length === 1) options.fail({ errMsg: "response lost" });
        else
          success(options, {
            id: item.id,
            rating: options.data.rating,
            updated: true,
            replayed: false,
          });
      }
    });
    await page.loadLifeStacks();
    const vote = (rating: string) =>
      page.rateLifeItem({ currentTarget: { dataset: { id: item.id, rating } } });
    await vote("LIKE");
    expect(page.data.lifeStacks[0].items[0].myRating).toBe("NONE");
    await vote("LIKE");
    expect(writes[0].header["X-Idempotency-Key"]).toBe(writes[1].header["X-Idempotency-Key"]);
    expect(page.data.lifeStacks[0].items[0].myRating).toBe("LIKE");
    await vote("LIKE");
    expect(writes[2].data.rating).toBe("NONE");
    expect(writes[2].header["X-Idempotency-Key"]).not.toBe(writes[1].header["X-Idempotency-Key"]);
    await vote("DISLIKE");
    expect(page.data.lifeStacks[0].items[0].myRating).toBe("DISLIKE");
    page.onUnload();
  });
  it("ignores a vote response after hide and a category response after logout", async () => {
    const item = lifeItem("未完成的念头");
    let ratingRequest: any;
    let stackRequest: any;
    const page = mount((options) => {
      if (options.url.endsWith("/rating")) ratingRequest = options;
      else if (!stackRequest) {
        stackRequest = true;
        success(options, [group([item])]);
      } else stackRequest = options;
    });
    await page.loadLifeStacks();
    const voting = page.rateLifeItem({
      currentTarget: { dataset: { id: item.id, rating: "LIKE" } },
    });
    await flushPage();
    page.onHide();
    success(ratingRequest, { id: item.id, rating: "LIKE", updated: true, replayed: false });
    await voting;
    expect(page.data.lifeStacks[0].items[0].myRating).toBe("NONE");
    const loading = page.loadLifeStacks(true);
    await flushPage();
    page.services.client.clear();
    success(stackRequest, [group([lifeItem("另一账号的卡")])]);
    await loading;
    expect(page.data.lifeStacks).toEqual([]);
    expect(page.data.cards).toEqual([]);
    expect(page.data.recommendation).toBeNull();
    page.onUnload();
  });
  it("keeps an active wish until the real delete receipt, then clears it and requests another suggestion", async () => {
    const target = randomUUID();
    let deletion: any;
    const decisions: any[] = [];
    const removedKeys: string[] = [];
    const page = mount(
      (options) => {
        if (options.method === "DELETE") deletion = options;
        else if (options.url.endsWith("/now/sessions")) {
          decisions.push(options.data);
          success(options, {
            sessionId: randomUUID(),
            status: "QUIET",
            recommendation: null,
            candidates: [],
            question: null,
            replayed: false,
          });
        } else success(options, []);
      },
      false,
      "home",
      { removeStorageSync: (key: string) => removedKeys.push(key) },
    );
    page.setData({
      sessionId: randomUUID(),
      recommendation: { targetLifeObjectId: target, progress: { state: "ACTIVE" } },
    });
    const deleting = page.deleteWish();
    await flushPage();
    expect(page.data.recommendation.targetLifeObjectId).toBe(target);
    expect(decisions).toHaveLength(0);
    expect(deletion.data).toEqual({});
    success(deletion, { id: target, deleted: true, replayed: false });
    await deleting;
    expect(page.data.recommendation).toBeNull();
    expect(page.data.notice).toContain("已删除");
    expect(decisions[0].excludeObjectIds).toContain(target);
    expect(removedKeys.some((key) => key.includes(":active:"))).toBe(true);
    page.onUnload();
  });
  it("preserves the wish and its delete key when the server receipt is lost", async () => {
    const target = randomUUID();
    const writes: any[] = [];
    const page = mount((options) => {
      writes.push(options);
      options.fail({ errMsg: "offline" });
    });
    page.setData({ sessionId: randomUUID(), recommendation: { targetLifeObjectId: target } });
    await page.deleteWish();
    await page.deleteWish();
    expect(page.data.recommendation.targetLifeObjectId).toBe(target);
    expect(writes[0].header["X-Idempotency-Key"]).toBe(writes[1].header["X-Idempotency-Key"]);
    expect(page.data.notice).not.toContain("已删除");
    page.onUnload();
  });
  it("releases deletion busy state on hide and confirms the closed session before replacing the returned card", async () => {
    const target = randomUUID(),
      sessionId = randomUUID();
    let deletion: any;
    let freshReads = 0,
      suggestions = 0;
    const page = mount((options) => {
      if (options.method === "DELETE") deletion = options;
      else if (options.url.includes("/now/sessions/")) {
        freshReads++;
        success(options, {
          sessionId,
          status: "QUIET",
          recommendation: null,
          candidates: [],
          question: null,
          replayed: false,
        });
      } else if (options.url.endsWith("/now/sessions")) {
        suggestions++;
        success(options, {
          sessionId: randomUUID(),
          status: "QUIET",
          recommendation: null,
          candidates: [],
          question: null,
          replayed: false,
        });
      } else success(options, []);
    });
    page.setData({
      sessionId,
      recommendation: { targetLifeObjectId: target, progress: { state: "ACTIVE" } },
    });
    const deleting = page.deleteWish();
    await flushPage();
    page.onHide();
    expect(page.data.busy).toBe(false);
    success(deletion, { id: target, deleted: true, replayed: false });
    await deleting;
    expect(page.data.recommendation.targetLifeObjectId).toBe(target);
    expect(freshReads).toBe(0);
    page.onShow();
    await flushPage();
    expect(freshReads).toBe(1);
    expect(suggestions).toBe(1);
    expect(page.data.recommendation).toBeNull();
    expect(page.data.busy).toBe(false);
    page.onUnload();
  });
  it("opens a category deck with preference order, continues its cursor and uses a filtered search only when needed", async () => {
    const first = lifeItem("偏好较高的一张"),
      second = lifeItem("更多内容");
    const requests: any[] = [];
    const page = mount(
      (options) => {
        requests.push(options);
        const items = options.data.cursor ? [second] : [first];
        success(
          options,
          options.url.endsWith("/deck")
            ? {
                items,
                nextCursor: options.data.cursor ? null : "deck-page-two",
                asOf: new Date().toISOString(),
              }
            : { items, nextCursor: null },
        );
      },
      false,
      "life-list",
      {},
      {},
      { kind: "DESIRE" },
    );
    await flushPage();
    expect(requests[0].url).toContain("/life/deck");
    expect(page.data.groups[0].items).toHaveLength(1);
    await page.loadItems();
    expect(requests[1].data.cursor).toBe("deck-page-two");
    expect(page.data.groups[0].items).toHaveLength(2);
    await page.setTime({ detail: { value: "1" } });
    expect(requests.at(-1).url).toContain("/life/search");
    expect(requests.at(-1).data.savedWithinDays).toBe(7);
    expect(page.locationCalls()).toBe(0);
    page.onUnload();
  });
});
describe("Life sections and paginated secondary page", () => {
  it("keeps earlier records in section previews after refresh and opens the full-list route", async () => {
    const items = [lifeItem("新留下的"), lifeItem("之前留下的"), lifeItem("更早的念头")];
    const page = mount(
      (options) =>
        success(
          options,
          options.url.endsWith("/sections")
            ? [{ section: "RECENT", title: "最近留下", items }]
            : [],
        ),
      true,
    );
    await page.refreshLists();
    await page.refreshLists();
    expect(page.data.sections[0].items.map((item: any) => item.title)).toEqual(
      items.map((item) => item.title),
    );
    expect(page.data.recommendation).toBeNull();
    page.openSection({ currentTarget: { dataset: { section: "RECENT" } } });
    expect(page.navigations).toEqual(["/pages/life-list/index?section=RECENT"]);
    page.onUnload();
  });
  it("shares the same authenticated client and refresh flight across both compiled pages", async () => {
    const home = mount((options) => success(options, { items: [], nextCursor: null }));
    const list = home.openRoute("life-list");
    await flushPage();
    expect(list.services.client).toBe(home.services.client);
    expect(list.data.error).toBe("");
    home.onUnload();
    list.onUnload();
  });
  it("appends pages and resets the cursor when time or kind changes", async () => {
    const calls: any[] = [];
    const first = lifeItem("第一张"),
      second = lifeItem("更早的一张");
    const page = mount(
      (options) => {
        calls.push(options.data);
        success(
          options,
          options.data.cursor
            ? { items: [second], nextCursor: null }
            : { items: [first], nextCursor: "opaque-page-two" },
        );
      },
      true,
      "life-list",
    );
    await flushPage();
    await page.loadItems();
    expect(page.data.items.map((item: any) => item.id)).toEqual([first.id, second.id]);
    await page.setTime({ detail: { value: "1" } });
    expect(calls.at(-1).savedWithinDays).toBe(7);
    expect(calls.at(-1).cursor).toBeUndefined();
    expect(page.data.items).toHaveLength(1);
    await page.setKind({ detail: { value: "1" } });
    expect(calls.at(-1).kind).toBe("PLACE");
    expect(page.locationCalls()).toBe(0);
    page.onUnload();
  });
  it("does not let a delayed previous filter replace the current result", async () => {
    const requests: any[] = [];
    const page = mount(
      (options) => {
        requests.push(options);
      },
      false,
      "life-list",
    );
    await flushPage();
    const changing = page.setTime({ detail: { value: "2" } });
    await flushPage();
    const current = lifeItem("最近30天");
    success(requests[1], { items: [current], nextCursor: null });
    await changing;
    success(requests[0], { items: [lifeItem("旧筛选结果")], nextCursor: "old" });
    await flushPage();
    expect(page.data.items.map((item: any) => item.id)).toEqual([current.id]);
    expect(page.data.nextCursor).toBeNull();
    page.onUnload();
  });
  it("recovers an interrupted first list load after hide without accepting the stale response", async () => {
    const requests: any[] = [];
    const page = mount((options) => requests.push(options), false, "life-list");
    page.onShow();
    await flushPage();
    expect(requests).toHaveLength(1);
    expect(page.data.loaded).toBe(false);
    expect(page.data.loading).toBe(true);
    page.onHide();
    expect(page.data.loading).toBe(false);
    page.onShow();
    await flushPage();
    expect(requests).toHaveLength(2);
    success(requests[0], { items: [lifeItem("隐藏前的迟到结果")], nextCursor: "stale" });
    await flushPage();
    expect(page.data.items).toEqual([]);
    expect(page.data.loading).toBe(true);
    const current = lifeItem("返回后恢复的记录");
    success(requests[1], { items: [current], nextCursor: null });
    await flushPage();
    expect(page.data.items.map((item: any) => item.id)).toEqual([current.id]);
    expect(page.data.loaded).toBe(true);
    expect(page.data.loading).toBe(false);
    expect(page.data.nextCursor).toBeNull();
    expect(page.locationCalls()).toBe(0);
    page.onUnload();
  });
  it("resumes an interrupted nearby query with existing coordinates instead of requesting GPS again", async () => {
    const requests: any[] = [];
    let gpsCalls = 0;
    const page = mount(
      (options) => {
        requests.push(options);
        if (requests.length === 1) success(options, { items: [], nextCursor: null });
      },
      false,
      "life-list",
      {
        getLocation: (options: any) => {
          gpsCalls++;
          options.success({ latitude: 23.1, longitude: 113.2 });
        },
      },
    );
    page.onShow();
    await flushPage();
    const choosing = page.setLocation({ detail: { value: "3" } });
    await flushPage();
    expect(gpsCalls).toBe(1);
    expect(requests).toHaveLength(2);
    // Returning later must not renew GPS even after the normal coordinate cache TTL.
    page.runtime.center.acquiredAt = Date.now() - 10 * 60000;
    page.onHide();
    page.onShow();
    await flushPage();
    expect(requests).toHaveLength(3);
    expect(gpsCalls).toBe(1);
    expect(requests[2].data.center).toEqual(requests[1].data.center);
    const current = { ...lifeItem("附近的记录"), hasLocation: true, distanceMeters: 120 };
    success(requests[2], { items: [current], nextCursor: null });
    await flushPage();
    success(requests[1], { items: [lifeItem("旧的附近结果")], nextCursor: "stale" });
    await choosing;
    await flushPage();
    expect(page.data.items.map((item: any) => item.id)).toEqual([current.id]);
    expect(page.data.loading).toBe(false);
    expect(page.data.locating).toBe(false);
    expect(gpsCalls).toBe(1);
    page.onUnload();
  });
  it("keeps all records available when explicit nearby permission is denied", async () => {
    const calls: any[] = [];
    const page = mount(
      (options) => {
        calls.push(options);
        success(options, { items: [lifeItem("未定位的念头")], nextCursor: null });
      },
      false,
      "life-list",
    );
    await flushPage();
    expect(page.locationCalls()).toBe(0);
    await page.setLocation({ detail: { value: "3" } });
    expect(page.locationCalls()).toBe(1);
    expect(page.data.locationIndex).toBe(0);
    expect(page.data.items).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(page.data.error).toContain("全部地点");
    page.onUnload();
  });
  it("ignores secondary-page responses after unload", async () => {
    let pending: any;
    const page = mount(
      (options) => {
        pending = options;
      },
      false,
      "life-list",
    );
    await flushPage();
    page.onUnload();
    const before = JSON.parse(JSON.stringify(page.data));
    success(pending, { items: [lifeItem("迟到的响应")], nextCursor: null });
    await flushPage();
    expect(page.data).toEqual(before);
  });
});

describe("Home context and multimodal input interactions", () => {
  function routePreparation() {
    const target = randomUUID();
    return {
      selectedDestination: {
        lifeObjectId: target,
        name: "书店",
        address: "广州市天河区体育东路 10 号",
        source: "USER_SELECTED_MAP",
      },
      sessionId: randomUUID(),
      status: "RECOMMENDED",
      replayed: false,
      question: null,
      recommendation: {
        id: randomUUID(),
        targetLifeObjectId: target,
        headline: "先核对书店的往返路程",
        body: "看看现在是否来得及去一趟。",
        reasonText: "还没有核对当前位置到书店的路程。",
        executionType: "NAVIGATE",
        score: 0.6,
        plan: {
          mode: "PREPARE",
          startAt: new Date().toISOString(),
          endAt: new Date(Date.now() + 300000).toISOString(),
          totalSeconds: 300,
          activitySeconds: 300,
          travelSeconds: 0,
          returnSeconds: 0,
          basis: "PLANNING_ESTIMATE",
          steps: ["核对往返交通"],
          requiresGoOut: false,
          targetRegion: "广东",
          verification: "UNVERIFIED",
          label: "约 5 分钟",
        },
      },
      candidates: [
        {
          lifeObjectId: target,
          actionMode: "DO",
          title: "去书店",
          totalScore: 0,
          rank: null,
          filtered: true,
          filterReason: "ROUTE_UNVERIFIED",
          scores: { value: 0, fit: 0, urgency: 0, friction: 0, uncertainty: 0 },
        },
      ],
    };
  }
  function destinationChoices(
    config: {
      choices?: any[];
      choicesSend?: (options: any, result: any) => void;
      selectSend?: (options: any, result: any) => void;
    } = {},
  ) {
    const response = routePreparation();
    const target = response.recommendation.targetLifeObjectId;
    const choices = config.choices ?? [
      {
        token: "guangzhou-secret-token",
        title: "同名书店",
        city: "广州市",
        district: "天河区",
        address: "体育东路 10 号",
      },
      {
        token: "shanghai-secret-token",
        title: "同名书店",
        city: "上海市",
        district: "徐汇区",
        address: "漕溪北路 10 号",
      },
    ];
    const writes: any[] = [];
    let locations = 0;
    let nowCount = 0;
    const stored: unknown[] = [];
    const page = mount(
      (options) => {
        if (options.method !== "POST") return success(options, []);
        writes.push(options);
        if (options.url.endsWith("/locations/choices")) {
          const result = {
            lifeObjectId: target,
            choices,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            reason: "AMBIGUOUS_ADDRESS",
          };
          return config.choicesSend
            ? config.choicesSend(options, result)
            : success(options, result);
        }
        if (options.url.endsWith("/locations/select")) {
          const result = { lifeObjectId: target, selected: true, replayed: false };
          return config.selectSend ? config.selectSend(options, result) : success(options, result);
        }
        nowCount++;
        success(
          options,
          nowCount === 1
            ? response
            : nowCount === 2
              ? {
                  ...response,
                  routeCheck: { status: "UNAVAILABLE", reason: "AMBIGUOUS_ADDRESS" },
                }
              : {
                  ...response,
                  sessionId: randomUUID(),
                  routeCheck: {
                    status: "READY",
                    reason: null,
                    detail: {
                      origin: { latitude: 23.1, longitude: 113.2, coordinateSystem: "GCJ02" },
                      destination: { latitude: 31.2, longitude: 121.4, coordinateSystem: "GCJ02" },
                      destinationLabel: "上海同名书店",
                      mode: "walking",
                      outwardSeconds: 600,
                      returnSeconds: 700,
                      outwardMeters: 900,
                      returnMeters: 1000,
                      departureBlocker: "DURATION_UNKNOWN",
                      requiredSeconds: null,
                    },
                  },
                },
        );
      },
      false,
      "home",
      {
        getLocation: (options: any) => {
          locations++;
          options.success({ latitude: 23.1, longitude: 113.2 });
        },
        setStorageSync: (_key: string, value: unknown) => stored.push(value),
      },
    );
    return { page, writes, target, response, choices, stored, locations: () => locations };
  }
  const choiceTap = (index: number) => ({ currentTarget: { dataset: { index } } });
  // The legacy list remains callable for compatibility, but is no longer requested by the route UI.
  async function openLegacyChoices(page: any) {
    await page.verifyCurrentRoute();
    await page
      .loadLocationChoices({
        owner: userId,
        target: page.data.recommendation.targetLifeObjectId,
        generation: page.runtime.locationGeneration,
        expiresAt: Date.now() + 120000,
        location: {
          latitude: 23.1,
          longitude: 113.2,
          coordinateSystem: "GCJ02",
          source: "DEVICE",
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        },
      })
      .catch((error: any) => {
        if (error.code !== "SESSION_CHANGED") throw error;
      });
  }
  function nativeDestination(
    config: {
      intentSend?: (options: any, result: any) => void;
      mapSend?: (options: any, result: any) => void;
    } = {},
  ) {
    const response = { ...routePreparation(), selectedDestination: null };
    const target = response.recommendation.targetLifeObjectId;
    const picked = {
      name: "暨南大学（石牌校区）",
      address: "广东省广州市天河区黄埔大道西 601 号",
      latitude: 23.13001,
      longitude: 113.35002,
    };
    const writes: any[] = [];
    const stored: unknown[] = [];
    const native: any[] = [];
    let locations = 0;
    let selected: any = null;
    const page = mount(
      (options) => {
        if (options.method !== "POST") return success(options, []);
        writes.push(options);
        if (options.url.endsWith("/picker-intents")) {
          const result = {
            lifeObjectId: target,
            intentToken: "runtime-only-picker-token",
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          };
          return config.intentSend ? config.intentSend(options, result) : success(options, result);
        }
        if (options.url.endsWith("/map-select")) {
          selected = {
            lifeObjectId: target,
            name: options.data.name,
            address: options.data.address,
            source: "USER_SELECTED_MAP",
          };
          const result = { lifeObjectId: target, selected: true, replayed: false };
          return config.mapSend ? config.mapSend(options, result) : success(options, result);
        }
        success(options, {
          ...response,
          selectedDestination: selected,
          sessionId: randomUUID(),
          ...(options.data.context.location
            ? { routeCheck: { status: "UNAVAILABLE", reason: "AMBIGUOUS_ADDRESS" } }
            : {}),
        });
      },
      false,
      "home",
      {
        chooseLocation: (options: any) => native.push(options),
        getLocation: (options: any) => {
          locations++;
          options.success({ latitude: 23.1, longitude: 113.2 });
        },
        setStorageSync: (_key: string, value: unknown) => stored.push(value),
      },
    );
    return { page, response, target, picked, writes, native, stored, locations: () => locations };
  }
  it("opens native map search without GPS or preset coordinates, preserves its result over hide/show, and saves only after confirmation", async () => {
    const { page, target, picked, writes, native, stored, locations } = nativeDestination();
    await page.decide();
    const oldSession = page.data.sessionId;
    page.services.routeCache.set(userId, target, {
      view: { longitude: 100, destinationLabel: "旧位置" },
      departureReason: "旧路线",
    });
    page.updateData({ recommendation: page.data.recommendation });
    await page.chooseDestination();
    expect(native).toHaveLength(1);
    expect(native[0].latitude).toBeUndefined();
    expect(native[0].longitude).toBeUndefined();
    expect(locations()).toBe(0);
    expect(writes.find((item) => item.url.endsWith("/picker-intents")).data).toEqual({
      lifeObjectId: target,
    });
    page.onHide();
    page.onShow();
    native[0].success(picked);
    expect(page.data.mapSelection).toEqual({ name: picked.name, address: picked.address });
    expect(page.data.routeView.destinationLabel).toBe("旧位置");
    expect(writes.some((item) => item.url.endsWith("/map-select"))).toBe(false);
    expect(JSON.stringify(page.data)).not.toContain("runtime-only-picker-token");
    expect(JSON.stringify(page.data)).not.toContain("113.35002");
    expect(JSON.stringify(page.data)).not.toContain("23.13001");
    await page.confirmMapSelection();
    const save = writes.find((item) => item.url.endsWith("/map-select"));
    expect(save.data).toEqual({
      lifeObjectId: target,
      intentToken: "runtime-only-picker-token",
      name: picked.name,
      address: picked.address,
      location: {
        latitude: picked.latitude,
        longitude: picked.longitude,
        coordinateSystem: "GCJ02",
      },
    });
    expect(save.header["X-Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.runtime.pickerContext).toBeNull();
    expect(page.data.mapSelection).toBeNull();
    expect(page.data.mapDestination).toMatchObject({
      name: picked.name,
      address: picked.address,
      source: "USER_SELECTED_MAP",
    });
    expect(page.data.notice).toContain("你选择的位置");
    expect(page.data.notice).not.toContain("真实性已核实");
    expect(page.data.sessionId).not.toBe(oldSession);
    expect(page.services.routeCache.get(userId, target)).toBeNull();
    expect(page.data.routeView).toBeNull();
    const now = writes.filter((item) => item.url.endsWith("/now/sessions"));
    expect(now).toHaveLength(2);
    expect(now[1].data).toMatchObject({ focusObjectId: target, context: {} });
    expect(now[1].header["X-Idempotency-Key"]).not.toBe(now[0].header["X-Idempotency-Key"]);
    expect(locations()).toBe(0);
    expect(stored).toEqual([]);
    await page.verifyCurrentRoute();
    expect(locations()).toBe(1);
    expect(writes.some((item) => item.url.endsWith("/locations/choices"))).toBe(false);
    page.onUnload();
  });
  it("does not save native picker cancellation or confirmation-card cancellation", async () => {
    const { page, response, writes, native, picked, locations } = nativeDestination();
    await page.decide();
    await page.chooseDestination();
    native[0].fail({ errMsg: "chooseLocation:fail cancel" });
    expect(page.data.notice).toContain("原建议保留");
    expect(page.data.recommendation).toEqual(response.recommendation);
    await page.confirmMapSelection();
    await page.chooseDestination();
    native[1].success(picked);
    page.cancelMapSelection();
    await page.confirmMapSelection();
    expect(page.runtime.pickerContext).toBeNull();
    expect(page.data.mapSelection).toBeNull();
    expect(writes.some((item) => item.url.endsWith("/map-select"))).toBe(false);
    expect(locations()).toBe(0);
    page.onUnload();
  });
  it("requires saved destination evidence before GPS, including when a native selection is awaiting confirmation", async () => {
    const { page, native, picked, locations, writes } = nativeDestination();
    await page.decide();
    expect(page.data.canVerifyRoute).toBe(true);
    expect(page.data.hasConfirmedDestination).toBe(false);
    await page.verifyCurrentRoute();
    expect(locations()).toBe(0);
    await page.chooseDestination();
    native[0].success(picked);
    expect(page.data.mapSelection).not.toBeNull();
    expect(page.data.hasConfirmedDestination).toBe(false);
    await page.verifyCurrentRoute();
    expect(locations()).toBe(0);
    expect(writes.filter((item) => item.url.endsWith("/now/sessions"))).toHaveLength(1);
    expect(readFileSync("apps/miniprogram/src/pages/home/index.wxml", "utf8")).toContain(
      "canVerifyRoute && hasConfirmedDestination",
    );
    page.onUnload();
  });
  it("restores saved destination metadata after home recreation and queries GPS without reopening map search", async () => {
    const { page, native, picked, locations } = nativeDestination();
    await page.decide();
    await page.chooseDestination();
    native[0].success(picked);
    await page.confirmMapSelection();
    expect(locations()).toBe(0);
    page.onUnload();
    const recreated = page.createInstance();
    recreated.onShow();
    await recreated.decide();
    expect(recreated.data.mapDestination).toMatchObject({
      name: picked.name,
      address: picked.address,
      source: "USER_SELECTED_MAP",
    });
    expect(recreated.data.hasConfirmedDestination).toBe(true);
    expect(recreated.data.mapSelection).toBeNull();
    await recreated.verifyCurrentRoute();
    expect(locations()).toBe(1);
    expect(native).toHaveLength(1);
    recreated.onUnload();
  });
  it("does not accept destination metadata belonging to another wish", async () => {
    const response = routePreparation();
    response.selectedDestination.lifeObjectId = randomUUID();
    const page = mount((options) => success(options, response));
    await page.decide();
    expect(page.data.hasConfirmedDestination).toBe(false);
    expect(page.data.mapDestination).toBeNull();
    await page.verifyCurrentRoute();
    expect(page.locationCalls()).toBe(0);
    page.onUnload();
  });
  it("clears a cached route when fresh destination evidence is absent or its address has changed", () => {
    const response = routePreparation();
    const target = response.recommendation.targetLifeObjectId;
    const page = mount(() => {});
    page.services.routeCache.set(userId, target, {
      view: { destinationAddress: "已经过时的地址", longitude: 100 },
      departureReason: "旧路线",
    });
    page.applyNow(response);
    expect(page.data.hasConfirmedDestination).toBe(true);
    expect(page.data.routeView).toBeNull();
    expect(page.services.routeCache.get(userId, target)).toBeNull();
    page.services.routeCache.set(userId, target, {
      view: { destinationAddress: response.selectedDestination.address, longitude: 100 },
      departureReason: "旧路线",
    });
    page.applyNow({ ...response, selectedDestination: null });
    expect(page.data.hasConfirmedDestination).toBe(false);
    expect(page.data.routeView).toBeNull();
    expect(page.services.routeCache.get(userId, target)).toBeNull();
    page.onUnload();
  });
  it("invalidates the old route before a map-selection receipt that arrives after unload", async () => {
    let pending: any;
    let result: any;
    const { page, target, native, picked, writes } = nativeDestination({
      mapSend: (options, value) => {
        pending = options;
        result = value;
      },
    });
    await page.decide();
    page.services.routeCache.set(userId, target, {
      view: { longitude: 100 },
      departureReason: "旧路线",
    });
    await page.chooseDestination();
    native[0].success(picked);
    const saving = page.confirmMapSelection();
    await expect.poll(() => !!pending).toBe(true);
    expect(page.services.routeCache.get(userId, target)).toBeNull();
    page.onUnload();
    success(pending, result);
    await saving;
    expect(writes.filter((item) => item.url.endsWith("/now/sessions"))).toHaveLength(1);
    expect(page.runtime.pickerContext).toBeNull();
  });
  it("invalidates the native intent even when the session identity changes away and back before its callback", async () => {
    const { page, native, picked, writes } = nativeDestination();
    await page.decide();
    await page.chooseDestination();
    page.services.sessionStore.setUser(randomUUID());
    page.services.sessionStore.setUser(userId);
    native[0].success(picked);
    await page.confirmMapSelection();
    expect(page.runtime.pickerContext).toBeNull();
    expect(page.data.mapSelection).toBeNull();
    expect(writes.some((item) => item.url.endsWith("/map-select"))).toBe(false);
    page.onUnload();
  });
  it.each(["logout", "target", "unload"])(
    "discards native picker results after %s",
    async (change) => {
      const { page, writes, native, picked } = nativeDestination();
      await page.decide();
      await page.chooseDestination();
      if (change === "logout") {
        page.services.client.clear();
        page.onShow();
      }
      if (change === "target")
        page.updateData({ recommendation: routePreparation().recommendation });
      if (change === "unload") page.onUnload();
      native[0].success(picked);
      await page.confirmMapSelection();
      expect(page.runtime.pickerContext).toBeNull();
      expect(page.data.mapSelection).toBeNull();
      expect(writes.some((item) => item.url.endsWith("/map-select"))).toBe(false);
      expect(page.data.busy).toBe(false);
      if (change !== "unload") page.onUnload();
    },
  );
  it("does not open the native picker after hiding while its intent request is pending", async () => {
    let pending: any;
    let result: any;
    const { page, native } = nativeDestination({
      intentSend: (options, value) => {
        pending = options;
        result = value;
      },
    });
    await page.decide();
    const opening = page.chooseDestination();
    await expect.poll(() => !!pending).toBe(true);
    page.onHide();
    success(pending, result);
    await opening;
    expect(native).toEqual([]);
    expect(page.runtime.pickerContext).toBeNull();
    expect(page.data.busy).toBe(false);
    page.onUnload();
  });
  it("does not submit locally expired or malformed native selections", async () => {
    const { page, native, picked, writes } = nativeDestination();
    await page.decide();
    await page.chooseDestination();
    native[0].success({ ...picked, address: "", latitude: Number.NaN });
    expect(page.data.error).toContain("完整有效");
    await page.confirmMapSelection();
    await page.chooseDestination();
    native[1].success(picked);
    page.runtime.pickerContext.expiresAt = Date.now() - 1;
    await page.confirmMapSelection();
    expect(page.data.error).toContain("失效");
    expect(page.data.mapSelection).toBeNull();
    expect(writes.some((item) => item.url.endsWith("/map-select"))).toBe(false);
    page.onUnload();
  });
  it("keeps a fixed map-selection idempotency key after a lost receipt", async () => {
    let attempts = 0;
    const { page, writes, native, picked } = nativeDestination({
      mapSend: (options, result) => {
        if (++attempts === 1) options.fail({ errMsg: "offline" });
        else success(options, { ...result, replayed: true });
      },
    });
    await page.decide();
    await page.chooseDestination();
    native[0].success(picked);
    await page.confirmMapSelection();
    expect(page.data.mapSelection.name).toBe(picked.name);
    expect(page.data.busy).toBe(false);
    await page.confirmMapSelection();
    const selections = writes.filter((item) => item.url.endsWith("/map-select"));
    expect(selections).toHaveLength(2);
    expect(selections[0].header["X-Idempotency-Key"]).toBe(
      selections[1].header["X-Idempotency-Key"],
    );
    expect(selections[0].data).toEqual(selections[1].data);
    expect(page.data.mapDestination.name).toBe(picked.name);
    page.onUnload();
  });
  it.each([
    ["chooseLocation:fail api scope is not declared requiredPrivateInfos", "接口"],
    ["chooseLocation:fail auth deny", "权限"],
    ["chooseLocation:fail privacy authorization required", "隐私授权"],
  ])("explains native picker failure %s without claiming GPS failed", async (errMsg, expected) => {
    const { page, native, writes, locations } = nativeDestination();
    await page.decide();
    await page.chooseDestination();
    native[0].fail({ errMsg });
    expect(page.data.error).toContain(expected);
    expect(page.data.error).not.toContain("GPS");
    expect(page.data.busy).toBe(false);
    expect(locations()).toBe(0);
    expect(writes.some((item) => item.url.endsWith("/map-select"))).toBe(false);
    page.onUnload();
  });
  it("shows the choices provider quota failure instead of the earlier ambiguous-address failure", async () => {
    const { page, writes } = destinationChoices({
      choicesSend: (options, result) =>
        success(options, { ...result, choices: [], reason: "QUOTA_EXCEEDED" }),
    });
    await page.decide();
    await openLegacyChoices(page);
    expect(page.data.error).toContain("额度");
    expect(page.data.error).not.toContain("不明确");
    expect(page.data.locationChoices).toEqual([]);
    expect(page.runtime.choiceContext).toBeNull();
    expect(page.data.canVerifyRoute).toBe(true);
    expect(page.data.busy).toBe(false);
    expect(writes.some((item) => item.url.endsWith("/locations/select"))).toBe(false);
    page.onUnload();
  });
  it("shows full city choices without choosing automatically, then confirms only the tapped city and recomputes Now", async () => {
    const { page, writes, target, stored, locations } = destinationChoices();
    await page.decide();
    await openLegacyChoices(page);
    expect(page.data.locationChoices).toMatchObject([
      { city: "广州市", district: "天河区", address: "体育东路 10 号" },
      { city: "上海市", district: "徐汇区", address: "漕溪北路 10 号" },
    ]);
    expect(writes.filter((item) => item.url.endsWith("/locations/select"))).toEqual([]);
    expect(writes.find((item) => item.url.endsWith("/locations/choices")).data).toEqual({
      lifeObjectId: target,
    });
    expect(JSON.stringify(page.data)).not.toContain("secret-token");
    expect(JSON.stringify(page.data)).not.toContain("113.2");
    const oldSession = page.data.sessionId;
    page.services.routeCache.set(userId, target, {
      view: { longitude: 100 },
      departureReason: "旧路线",
    });
    await page.selectLocationChoice(choiceTap(1));
    const selection = writes.find((item) => item.url.endsWith("/locations/select"));
    expect(selection.data).toEqual({ lifeObjectId: target, choiceToken: "shanghai-secret-token" });
    expect(selection.header["X-Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    const now = writes.filter((item) => item.url.endsWith("/now/sessions"));
    expect(now).toHaveLength(3);
    expect(now[2].data).toMatchObject({
      focusObjectId: target,
      context: { location: { latitude: 23.1, longitude: 113.2 } },
    });
    expect(now[2].header["X-Idempotency-Key"]).not.toBe(now[1].header["X-Idempotency-Key"]);
    expect(locations()).toBe(1);
    expect(page.data.sessionId).not.toBe(oldSession);
    expect(page.data.routeView.destinationLabel).toBe("上海同名书店");
    expect(page.services.routeCache.get(userId, target).view.longitude).toBe(121.4);
    expect(page.data.locationChoices).toEqual([]);
    expect(page.runtime.choiceContext).toBeNull();
    expect(stored).toEqual([]);
    page.onUnload();
  });
  it("requires confirmation even for a single choice and cancelling preserves the original recommendation", async () => {
    const { page, writes, response } = destinationChoices({
      choices: [
        { token: "single-secret", title: "书店", city: "广州市", address: "体育东路 10 号" },
      ],
    });
    await page.decide();
    await openLegacyChoices(page);
    expect(page.data.locationChoices).toHaveLength(1);
    expect(writes.some((item) => item.url.endsWith("/locations/select"))).toBe(false);
    page.cancelLocationChoices();
    expect(page.data.recommendation).toEqual(response.recommendation);
    expect(page.data.locationChoices).toEqual([]);
    expect(page.runtime.choiceContext).toBeNull();
    expect(page.data.notice).toContain("原建议保留");
    await page.selectLocationChoice(choiceTap(0));
    expect(writes.some((item) => item.url.endsWith("/locations/select"))).toBe(false);
    page.onUnload();
  });
  it.each(["hide", "unload", "logout", "focus"])(
    "discards an outstanding choices response after %s",
    async (change) => {
      let pending: any;
      let result: any;
      const { page, writes } = destinationChoices({
        choicesSend: (options, data) => {
          pending = options;
          result = data;
        },
      });
      await page.decide();
      const query = openLegacyChoices(page);
      await expect.poll(() => !!pending).toBe(true);
      if (change === "hide") page.onHide();
      if (change === "unload") page.onUnload();
      if (change === "logout") {
        page.services.client.clear();
        page.onShow();
      }
      if (change === "focus")
        page.updateData({ recommendation: routePreparation().recommendation });
      success(pending, result);
      await query;
      expect(page.data.locationChoices).toEqual([]);
      expect(page.runtime.choiceContext).toBeNull();
      await page.selectLocationChoice(choiceTap(0));
      expect(writes.some((item) => item.url.endsWith("/locations/select"))).toBe(false);
      expect(page.data.busy).toBe(false);
      if (change !== "unload") page.onUnload();
    },
  );
  it("clears displayed tokens on hide and ignores a late selection receipt", async () => {
    let pending: any;
    let result: any;
    const { page, writes, locations } = destinationChoices({
      selectSend: (options, data) => {
        pending = options;
        result = data;
      },
    });
    await page.decide();
    await openLegacyChoices(page);
    const selecting = page.selectLocationChoice(choiceTap(1));
    await expect.poll(() => !!pending).toBe(true);
    page.onHide();
    expect(page.data.locationChoices).toEqual([]);
    expect(page.runtime.choiceContext).toBeNull();
    success(pending, result);
    await selecting;
    expect(writes.filter((item) => item.url.endsWith("/now/sessions"))).toHaveLength(2);
    expect(locations()).toBe(1);
    expect(page.data.routeView).toBeNull();
    expect(page.data.busy).toBe(false);
    page.onUnload();
  });
  it.each(["logout", "focus"])(
    "clears already displayed choices and tokens after %s",
    async (change) => {
      const { page, writes } = destinationChoices();
      await page.decide();
      await openLegacyChoices(page);
      expect(page.data.locationChoices).toHaveLength(2);
      if (change === "logout") {
        page.services.client.clear();
        page.onShow();
      } else page.updateData({ recommendation: routePreparation().recommendation });
      expect(page.data.locationChoices).toEqual([]);
      expect(page.runtime.choiceContext).toBeNull();
      expect(page.runtime.choiceOriginTimer).toBeUndefined();
      await page.selectLocationChoice(choiceTap(1));
      expect(writes.some((item) => item.url.endsWith("/locations/select"))).toBe(false);
      page.onUnload();
    },
  );
  it("reuses a selection idempotency key after a lost receipt and prevents switching that unresolved selection", async () => {
    let attempts = 0;
    const { page, writes } = destinationChoices({
      selectSend: (options, result) => {
        if (++attempts === 1) options.fail({ errMsg: "offline" });
        else success(options, { ...result, replayed: true });
      },
    });
    await page.decide();
    await openLegacyChoices(page);
    await page.selectLocationChoice(choiceTap(1));
    expect(page.data.locationChoices).toHaveLength(2);
    await page.selectLocationChoice(choiceTap(0));
    expect(page.data.error).toContain("重试原来的地点");
    expect(attempts).toBe(1);
    await page.selectLocationChoice(choiceTap(1));
    const selections = writes.filter((item) => item.url.endsWith("/locations/select"));
    expect(selections).toHaveLength(2);
    expect(selections[1].header["X-Idempotency-Key"]).toBe(
      selections[0].header["X-Idempotency-Key"],
    );
    expect(page.data.routeView.destinationLabel).toBe("上海同名书店");
    page.onUnload();
  });
  it.each([
    ["LOCATION_CHOICES_EXPIRED", "过期"],
    ["LOCATION_CHOICE_INVALID", "失效"],
    ["LOCATION_OBJECT_CHANGED", "记录已更新"],
  ])("offers a friendly fresh check after %s", async (code, message) => {
    const { page, writes } = destinationChoices({
      selectSend: (options) =>
        options.success({ statusCode: 409, data: { error: { code, request_id: requestId } } }),
    });
    await page.decide();
    await openLegacyChoices(page);
    await page.selectLocationChoice(choiceTap(0));
    expect(page.data.error).toContain(message);
    expect(page.data.canVerifyRoute).toBe(true);
    expect(page.data.locationChoices).toEqual([]);
    expect(page.runtime.choiceContext).toBeNull();
    expect(page.data.busy).toBe(false);
    expect(writes.filter((item) => item.url.endsWith("/now/sessions"))).toHaveLength(2);
    page.onUnload();
  });
  it("never sends locally expired tokens and acquires a fresh point when the saved origin has expired", async () => {
    const first = destinationChoices();
    await first.page.decide();
    await openLegacyChoices(first.page);
    first.page.runtime.choiceContext.choiceExpiresAt = Date.now() - 1;
    await first.page.selectLocationChoice(choiceTap(0));
    expect(first.writes.some((item) => item.url.endsWith("/locations/select"))).toBe(false);
    expect(first.page.data.error).toContain("过期");
    first.page.onUnload();
    const second = destinationChoices();
    await second.page.decide();
    await openLegacyChoices(second.page);
    second.page.runtime.choiceContext.expiresAt = Date.now() - 1;
    await second.page.selectLocationChoice(choiceTap(0));
    expect(second.locations()).toBe(2);
    expect(second.page.data.routeView).not.toBeNull();
    second.page.onUnload();
  });
  it("requests GCJ02 location only after the explicit route button and submits ephemeral device context", async () => {
    const writes: any[] = [];
    const stored: unknown[] = [];
    let locationCalls = 0;
    const response = routePreparation();
    const page = mount(
      (options) => {
        if (options.method !== "POST" || !options.url.endsWith("/now/sessions"))
          return success(options, []);
        writes.push(options.data);
        success(options, response);
      },
      false,
      "home",
      {
        getLocation: (options: any) => {
          locationCalls++;
          expect(options.type).toBe("gcj02");
          options.success({ latitude: 23.1291, longitude: 113.2644 });
        },
        setStorageSync: (_key: string, value: unknown) => stored.push(value),
      },
    );
    await page.decide();
    expect(locationCalls).toBe(0);
    expect(writes[0].context).toEqual({});
    expect(page.data.canVerifyRoute).toBe(true);
    await page.verifyCurrentRoute();
    expect(locationCalls).toBe(1);
    expect(writes[1].context).toMatchObject({
      willingToGoOut: true,
      location: {
        latitude: 23.1291,
        longitude: 113.2644,
        coordinateSystem: "GCJ02",
        source: "DEVICE",
      },
    });
    expect(writes[1].focusObjectId).toBe(response.recommendation.targetLifeObjectId);
    const location = writes[1].context.location;
    expect(Date.parse(location.expiresAt) - Date.parse(location.observedAt)).toBeLessThanOrEqual(
      7200000,
    );
    expect(Date.parse(location.expiresAt)).toBeGreaterThan(Date.now());
    expect(stored).toEqual([]);
    expect(JSON.stringify(page.data)).not.toContain("113.2644");
    page.onHide();
    expect(page.runtime.requestLocation).toBeNull();
    expect(page.runtime.nowPending).toBeNull();
    page.onUnload();
  });
  it("offers an entrance after routing fails and clears the hint when a route succeeds or the account resets", () => {
    const page = mount((options) => success(options, routePreparation()));
    const response = routePreparation();
    for (const reason of ["INVALID_LOCATION", "NO_ROUTE"]) {
      page.applyNow({ ...response, routeCheck: { status: "UNAVAILABLE", reason } });
      expect(page.data.routeNeedsEntrance).toBe(true);
      expect(page.data.mapDestination).toEqual(response.selectedDestination);
    }
    page.applyNow({ ...response, routeCheck: { status: "READY", reason: null } });
    expect(page.data.routeNeedsEntrance).toBe(false);
    page.applyNow({ ...response, routeCheck: { status: "UNAVAILABLE", reason: "NO_ROUTE" } });
    page.resetSessionContent();
    expect(page.data.routeNeedsEntrance).toBe(false);
    expect(page.data.mapDestination).toBeNull();
    page.onUnload();
  });
  it("shows progress and map failure beside the same preparation card", async () => {
    const response = routePreparation();
    let point: any;
    let posts = 0;
    const page = mount(
      (options) => {
        posts++;
        success(
          options,
          posts === 1
            ? response
            : { ...response, routeCheck: { status: "UNAVAILABLE", reason: "QUOTA_EXCEEDED" } },
        );
      },
      false,
      "home",
      {
        getLocation: (options: any) => {
          point = options.success;
        },
      },
    );
    await page.decide();
    const pending = page.verifyCurrentRoute();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(page.data.routeStatus).toContain("当前位置");
    expect(page.data.busy).toBe(true);
    point({ latitude: 23.1, longitude: 113.2 });
    await pending;
    expect(page.data.error).toContain("额度");
    expect(page.data.recommendation.targetLifeObjectId).toBe(
      response.recommendation.targetLifeObjectId,
    );
    expect(page.data.canVerifyRoute).toBe(true);
    expect(page.data.routeStatus).toBe("");
    expect(page.data.busy).toBe(false);
    page.onUnload();
  });
  it("explains a verified route without bypassing time constraints", async () => {
    const response = routePreparation();
    let posts = 0;
    const page = mount(
      (options) =>
        success(
          options,
          ++posts === 1
            ? response
            : {
                ...response,
                routeCheck: { status: "READY", reason: null },
                candidates: response.candidates.map((item) => ({
                  ...item,
                  filterReason: "TIME_LIMIT",
                })),
              },
        ),
      false,
      "home",
      { getLocation: (options: any) => options.success({ latitude: 23.1, longitude: 113.2 }) },
    );
    await page.decide();
    await page.verifyCurrentRoute();
    expect(page.data.notice).toContain("腾讯地图已计算到该位置的往返路线");
    expect(page.data.notice).toContain("暂不适合出发");
    expect(page.data.recommendation.plan.mode).toBe("PREPARE");
    expect(page.data.error).toBe("");
    page.onUnload();
  });
  it("retains the completed selected route through native map return and home recreation without storage or another location query", async () => {
    const response = routePreparation();
    const stored: unknown[] = [];
    const opened: any[] = [];
    const detail = {
      origin: { latitude: 23.1291, longitude: 113.2644, coordinateSystem: "GCJ02" },
      destination: { latitude: 23.1418, longitude: 113.2859, coordinateSystem: "GCJ02" },
      destinationLabel: "广州购书中心",
      mode: "bicycling",
      segments: [
        {
          mode: "bicycling",
          points: [
            { latitude: 23.1291, longitude: 113.2644 },
            { latitude: 23.15, longitude: 113.3 },
            { latitude: 23.1418, longitude: 113.2859 },
          ],
        },
      ],
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7200000).toISOString(),
      outwardSeconds: 901,
      returnSeconds: 1040,
      outwardMeters: 1200,
      returnMeters: 1400,
      departureBlocker: "DURATION_UNKNOWN",
      requiredSeconds: null,
      availableSeconds: 3600,
    };
    let posts = 0;
    let locations = 0;
    const page = mount(
      (options) => {
        if (options.method !== "POST") return success(options, []);
        success(
          options,
          ++posts === 1
            ? response
            : { ...response, routeCheck: { status: "READY", reason: null, detail } },
        );
      },
      false,
      "home",
      {
        getLocation: (options: any) => {
          locations++;
          options.success(detail.origin);
        },
        setStorageSync: (_key: string, value: unknown) => stored.push(value),
        openLocation: (options: any) => opened.push(options),
      },
    );
    await page.decide();
    await page.verifyCurrentRoute();
    expect(page.data.routeView.points).toEqual([
      { latitude: 23.1291, longitude: 113.2644 },
      { latitude: 23.1418, longitude: 113.2859 },
      ...detail.segments[0]!.points,
    ]);
    expect(page.data.routeView.polyline[0].points).toEqual(detail.segments[0]!.points);
    expect(page.data.routeView.markers.map((marker: any) => marker.id)).toEqual([1, 2]);
    expect(page.data.routeView.durationText).toBe("骑行约 16 分钟到达");
    expect(page.data.routeView.durationText).not.toContain("返程");
    expect(page.data.routeView.durationText).not.toContain("步行");
    expect(page.data.routeView.checkedAtText).toContain("路线查询");
    expect(page.data.departureReason).toContain("你打算在那里待多久");
    expect(page.data.departureReason).not.toContain("暂不适合出发");
    expect(page.data.departureReason).not.toContain("关闭");
    expect(page.data.recommendation.plan.mode).toBe("PREPARE");
    expect(page.data.canVerifyRoute).toBe(true);
    expect(page.runtime.requestLocation).toBeNull();
    expect(page.runtime.nowPending).toBeNull();
    expect(stored).toEqual([]);
    page.openRouteDestination();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      latitude: 23.1418,
      longitude: 113.2859,
      name: "广州购书中心",
    });
    page.onHide();
    expect(page.data.routeView.destinationLabel).toBe("广州购书中心");
    expect(page.data.canVerifyRoute).toBe(true);
    expect(page.runtime.requestLocation).toBeNull();
    page.onShow();
    expect(page.data.routeView.destinationLabel).toBe("广州购书中心");
    expect(page.data.routeView.polyline[0].points).toEqual(detail.segments[0]!.points);
    expect(posts).toBe(2);
    expect(locations).toBe(1);
    const otherTarget = routePreparation().recommendation;
    page.updateData({ recommendation: otherTarget });
    expect(page.data.routeView).toBeNull();
    page.updateData({ recommendation: response.recommendation });
    expect(page.data.routeView.destinationLabel).toBe("广州购书中心");
    page.openRouteDestination();
    expect(opened).toHaveLength(2);
    page.onUnload();
    const recreated = page.openRoute("home");
    recreated.onShow();
    expect(
      recreated.services.routeCache.get(userId, response.recommendation.targetLifeObjectId),
    ).not.toBeNull();
    recreated.updateData({ recommendation: response.recommendation });
    recreated.onShow();
    expect(recreated.data.routeView.destinationLabel).toBe("广州购书中心");
    expect(recreated.data.routeView.polyline[0].points).toEqual(detail.segments[0]!.points);
    expect(posts).toBe(2);
    expect(locations).toBe(1);
    expect(stored).toEqual([]);
    recreated.services.client.clear();
    expect(
      recreated.services.routeCache.get(userId, response.recommendation.targetLifeObjectId),
    ).toBeNull();
    recreated.onShow();
    expect(recreated.data.routeView).toBeNull();
    recreated.onUnload();
  });
  it("clears a previous map when recommendations change or the account resets", () => {
    const page = mount((options) => success(options, routePreparation()));
    page.updateData({ recommendation: routePreparation().recommendation });
    page.setData({ routeView: { longitude: 113.2644 }, departureReason: "旧路线" });
    page.updateData({ recommendation: routePreparation().recommendation });
    expect(page.data.routeView).toBeNull();
    expect(page.data.departureReason).toBe("");
    page.setData({ routeView: { longitude: 113.2644 }, departureReason: "旧路线" });
    page.resetSessionContent();
    expect(page.data.routeView).toBeNull();
    expect(page.data.departureReason).toBe("");
    page.onUnload();
  });
  it("keeps the last completed map when an explicit update is cancelled, then replaces it only after a new successful query", async () => {
    const response = routePreparation();
    let point: any;
    let posts = 0;
    const page = mount(
      (options) => {
        if (options.method !== "POST") return success(options, []);
        posts++;
        success(options, {
          ...response,
          routeCheck: {
            status: "READY",
            reason: null,
            detail: {
              origin: { latitude: 23.1, longitude: 113.2, coordinateSystem: "GCJ02" },
              destination: { latitude: 23.2, longitude: 113.3, coordinateSystem: "GCJ02" },
              destinationLabel: "书店",
              mode: "transit",
              transitKind: "SUBWAY",
              outwardSeconds: 600,
              returnSeconds: 700,
              outwardMeters: 900,
              returnMeters: 1000,
              departureBlocker: "DURATION_UNKNOWN",
              requiredSeconds: null,
            },
          },
        });
      },
      false,
      "home",
      {
        getLocation: (options: any) => {
          point = options.success;
        },
      },
    );
    const target = response.recommendation.targetLifeObjectId;
    page.services.routeCache.set(userId, target, {
      view: {
        longitude: 113.4,
        destinationLabel: "上次的书店",
        durationText: "建议步行 · 去程约 20 分钟",
      },
      departureReason: "需要确认停留时间",
    });
    page.applyNow(response);
    const cancelled = page.verifyCurrentRoute();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(page.data.routeStatus).toContain("正在获取当前位置");
    expect(page.data.routeView.destinationLabel).toBe("上次的书店");
    page.onHide();
    point({ latitude: 23.1, longitude: 113.2 });
    await cancelled;
    expect(posts).toBe(0);
    expect(page.data.routeView.destinationLabel).toBe("上次的书店");
    expect(page.services.routeCache.get(userId, target).view.longitude).toBe(113.4);
    page.onShow();
    expect(page.data.departureReason).toContain("上次查询");
    const updated = page.verifyCurrentRoute();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(page.data.routeView.destinationLabel).toBe("上次的书店");
    point({ latitude: 23.1, longitude: 113.2 });
    await updated;
    expect(posts).toBe(1);
    expect(page.data.routeView.destinationLabel).toBe("书店");
    expect(page.data.routeView.durationText).toBe("地铁约 10 分钟到达");
    expect(page.services.routeCache.get(userId, target).view.longitude).toBe(113.3);
    expect(page.runtime.requestLocation).toBeNull();
    page.updateData({
      recommendation: { ...response.recommendation, progress: { state: "ACTIVE" } },
    });
    expect(page.data.canVerifyRoute).toBe(false);
    await page.verifyCurrentRoute();
    expect(posts).toBe(1);
    page.onUnload();
  });
  it("clears application-memory routes when the session owner changes", () => {
    const page = mount((options) => success(options, []));
    const target = randomUUID();
    page.services.routeCache.set(userId, target, {
      view: { longitude: 113.4 },
      departureReason: "旧路线",
    });
    page.services.sessionStore.setUser(randomUUID());
    expect(page.services.routeCache.get(userId, target)).toBeNull();
    page.onUnload();
  });
  it("discards a late verified map after leaving the page", async () => {
    const response = routePreparation();
    let routeRequest: any;
    const page = mount(
      (options) => {
        if (options.data?.focusObjectId) routeRequest = options;
        else success(options, response);
      },
      false,
      "home",
      { getLocation: (options: any) => options.success({ latitude: 23.1, longitude: 113.2 }) },
    );
    await page.decide();
    const pending = page.verifyCurrentRoute();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(routeRequest).toBeDefined();
    page.onHide();
    success(routeRequest, {
      ...response,
      routeCheck: {
        status: "READY",
        reason: null,
        detail: {
          origin: { latitude: 23.1, longitude: 113.2, coordinateSystem: "GCJ02" },
          destination: { latitude: 23.2, longitude: 113.3, coordinateSystem: "GCJ02" },
          destinationLabel: "书店",
          outwardSeconds: 600,
          returnSeconds: 700,
          outwardMeters: 900,
          returnMeters: 1000,
          departureBlocker: "DURATION_UNKNOWN",
          requiredSeconds: null,
        },
      },
    });
    await pending;
    expect(page.data.routeView).toBeNull();
    expect(page.runtime.requestLocation).toBeNull();
    expect(page.runtime.nowPending).toBeNull();
    page.onUnload();
  });
  it("preserves the preparation card when location is denied and never submits a fake location", async () => {
    let posts = 0;
    const response = routePreparation();
    const page = mount((options) => {
      if (options.method !== "POST" || !options.url.endsWith("/now/sessions"))
        return success(options, []);
      posts++;
      success(options, response);
    });
    await page.decide();
    await page.verifyCurrentRoute();
    expect(page.locationCalls()).toBe(1);
    expect(posts).toBe(1);
    expect(page.data.recommendation.targetLifeObjectId).toBe(
      response.recommendation.targetLifeObjectId,
    );
    expect(page.data.error).toContain("微信设置中允许定位");
    expect(page.runtime.requestLocation).toBeNull();
    expect(page.data.busy).toBe(false);
    page.onUnload();
  });
  it("ignores a late location permission result after the home page is hidden", async () => {
    let locationCallback: any;
    let posts = 0;
    const page = mount(
      (options) => {
        if (options.method !== "POST" || !options.url.endsWith("/now/sessions"))
          return success(options, []);
        posts++;
        success(options, routePreparation());
      },
      false,
      "home",
      {
        getLocation: (options: any) => {
          locationCallback = options.success;
        },
      },
    );
    await page.decide();
    const pending = page.verifyCurrentRoute();
    await new Promise<void>((resolve) => setImmediate(resolve));
    page.onHide();
    locationCallback({ latitude: 23.1291, longitude: 113.2644 });
    await pending;
    expect(posts).toBe(1);
    expect(page.runtime.requestLocation).toBeNull();
    expect(page.data.routeLocationBusy).toBe(false);
    page.onUnload();
  });
  it("starts with a suggestion request and asks only the question returned by the backend", async () => {
    const decisions: any[] = [],
      answers: any[] = [];
    const sessionId = randomUUID(),
      questionId = randomUUID();
    const question = {
      id: questionId,
      key: "AVAILABLE_TIME",
      text: "现在有多久空闲？",
      options: [
        { id: "SHORT", label: "一会儿" },
        { id: "SKIP", label: "先给我一个建议" },
      ],
      sequence: 1,
      maxQuestions: 2,
    };
    const page = mount((options) => {
      if (options.url.endsWith("/answers")) {
        answers.push(options);
        success(options, {
          sessionId,
          status: "QUIET",
          question: null,
          recommendation: null,
          candidates: [],
          replayed: false,
        });
      } else {
        decisions.push(options.data);
        success(options, {
          sessionId,
          status: "NEEDS_ANSWER",
          question,
          recommendation: null,
          candidates: [],
          replayed: false,
        });
      }
    });
    page.setData({ sections: [{ items: [{ kind: "PLACE" }] }] });
    await page.decide();
    expect(decisions[0].context).toEqual({});
    expect(page.data.question.text).toBe("现在有多久空闲？");
    await page.answerQuestion({ currentTarget: { dataset: { option: "tampered" } } });
    expect(answers).toHaveLength(0);
    await page.answerQuestion({ currentTarget: { dataset: { option: "SKIP" } } });
    expect(answers[0].data).toEqual({ questionId, optionId: "SKIP" });
    expect(page.data.question).toBeNull();
    page.onUnload();
  });
  it("keeps the same answer key after a lost response and clears an expired question for a new suggestion", async () => {
    const writes: any[] = [];
    const page = mount((options) => {
      writes.push(options);
      if (writes.length === 1) options.fail({ errMsg: "offline" });
      else
        options.success({
          statusCode: 410,
          data: { error: { code: "DECISION_SESSION_EXPIRED", request_id: requestId } },
        });
    });
    page.setData({
      sessionId: randomUUID(),
      question: { id: randomUUID(), options: [{ id: "SHORT", label: "一会儿" }] },
    });
    const event = { currentTarget: { dataset: { option: "SHORT" } } };
    await page.answerQuestion(event);
    expect(page.data.question).not.toBeNull();
    await page.answerQuestion(event);
    expect(writes[0].header["X-Idempotency-Key"]).toBe(writes[1].header["X-Idempotency-Key"]);
    expect(page.data.question).toBeNull();
    expect(page.data.decided).toBe(false);
    expect(page.data.error).toContain("再看看");
    page.onUnload();
  });
  it("loads native image bytes and sends image plus optional caption to the authenticated backend", async () => {
    const writes: any[] = [];
    const page = mount(
      (options) => {
        if (options.url.endsWith("/capabilities"))
          success(options, {
            text: true,
            image: true,
            voice: true,
            provider: "dashscope",
            reason: null,
          });
        else if (options.method === "POST" && options.url.endsWith("/captures")) {
          writes.push(options);
          success(options, {
            captureId: randomUUID(),
            status: "UPLOADED",
            accepted: true,
            replayed: false,
          });
        } else success(options, []);
      },
      false,
      "home",
      {
        chooseMedia: ({ success }: any) =>
          success({ tempFiles: [{ tempFilePath: "/tmp/photo.jpg", size: 10 }] }),
        getFileSystemManager: () => ({
          readFile: ({ success }: any) => success({ data: "/9j/AAAA" }),
        }),
      },
    );
    page.setData({ draft: "想去图片里的地方" });
    page.openCapture();
    await page.chooseImage();
    await flushPage();
    expect(writes).toHaveLength(0);
    expect(page.data.sheet).toBe(true);
    expect(page.data.imagePath).toBe("/tmp/photo.jpg");
    await page.saveCapture();
    expect(writes[0].data).toMatchObject({
      type: "IMAGE",
      text: "想去图片里的地方",
      image: { mimeType: "image/jpeg", base64: "/9j/AAAA" },
    });
    expect(writes[0].header.authorization).toBe("Bearer test-access");
    expect(page.data.imagePath).toBe("");
    page.onUnload();
  });
  it("records before upstream ready, streams text and auto-submits after release and final transcript", async () => {
    const rec: any = {},
      socket: any = { sent: [] },
      writes: any[] = [];
    const requested: string[] = [];
    const sessionId = randomUUID();
    const recorder = {
      onStart: (callback: any) => (rec.start = callback),
      onStop: (callback: any) => (rec.stop = callback),
      onFrameRecorded: (callback: any) => (rec.frame = callback),
      onError: (callback: any) => (rec.error = callback),
      onInterruptionBegin: (callback: any) => (rec.interrupt = callback),
      start: (options: any) => {
        rec.options = options;
        rec.start();
      },
      stop: () => rec.stop(),
    };
    const page = mount(
      (options) => {
        requested.push(options.url);
        if (options.url.endsWith("/capabilities"))
          success(options, {
            text: true,
            image: true,
            voice: true,
            provider: "dashscope",
            reason: null,
          });
        else if (options.url.endsWith("/voice/sessions"))
          success(options, {
            sessionId,
            ticket: "one-use-ticket",
            expiresIn: 60,
            socketPath: "/v1/media/voice/stream",
            sampleRate: 16000,
            format: "pcm16",
          });
        else if (options.method === "POST") {
          writes.push(options);
          success(options, {
            captureId: randomUUID(),
            status: "UPLOADED",
            accepted: true,
            replayed: false,
          });
        } else success(options, []);
      },
      false,
      "home",
      {
        getDeviceInfo: () => ({ platform: "ios" }),
        authorize: ({ success }: any) => success(),
        getRecorderManager: () => recorder,
        connectSocket: () => ({
          onMessage: (callback: any) => (socket.message = callback),
          onError: () => {},
          onClose: () => {},
          send: ({ data, success }: any) => {
            socket.sent.push(data);
            success?.();
          },
          close: () => (socket.closed = true),
        }),
      },
    );
    page.chooseVoice();
    await page.voiceTouchStart({ touches: [{ clientY: 300 }] });
    expect(requested.filter((url) => url.endsWith("/voice/sessions"))).toHaveLength(1);
    expect(requested.some((url) => url.endsWith("/capabilities"))).toBe(false);
    const event = (data: unknown) => socket.message({ data: JSON.stringify(data) });
    expect(page.data.voiceStatus).toBe("recording");
    rec.frame({ frameBuffer: new ArrayBuffer(2), isLastFrame: false });
    expect(socket.sent).toHaveLength(0);
    event({ type: "ready", sessionId });
    await flushPage();
    expect(socket.sent).toHaveLength(1);
    socket.sent = [];
    expect(rec.options).toMatchObject({
      format: "PCM",
      sampleRate: 16000,
      numberOfChannels: 1,
      frameSize: 4,
    });
    expect(page.data.voiceStatus).toBe("recording");
    event({ type: "partial", text: "想去" });
    expect(page.data.voicePartial).toBe("想去");
    expect(page.data.draft).toBe("想去");
    event({ type: "final", text: "想去公园。" });
    event({ type: "final", text: "看一看花。" });
    expect(page.data.voiceRows[0].fading).toBe(true);
    expect(page.data.draft).toContain("想去公园。");
    // Native onStop can precede the final PCM frame. Finish must wait for both.
    page.voiceTouchEnd();
    expect(page.data.sheet).toBe(false);
    expect(page.data.cards[0].phase).toBe("TRANSCRIBING");
    expect(writes).toHaveLength(0);
    page.openCapture();
    page.chooseText();
    expect(page.data.sheet).toBe(false);
    expect(page.data.voiceStatus).toBe("finishing");
    expect(socket.sent).toHaveLength(0);
    rec.frame({ frameBuffer: new ArrayBuffer(2), isLastFrame: true });
    await flushPage();
    expect(socket.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect(JSON.parse(socket.sent[1])).toEqual({ type: "finish" });
    event({ type: "done", text: "想去公园。看一看花。", sessionId });
    await flushPage();
    expect(writes[0].data).toMatchObject({
      type: "VOICE",
      text: "想去公园。看一看花。",
      transcriptionSessionId: sessionId,
    });
    expect(socket.closed).toBe(true);
    expect(page.toasts.filter((toast: any) => toast.title === "收纳好了")).toHaveLength(1);
    expect(page.data.cards[0].phase).toBe("UPLOADED");
    page.onUnload();
  });
  it("preserves live text and ignores late socket events after hiding the page", async () => {
    const rec: any = {},
      socket: any = {};
    const sessionId = randomUUID();
    const page = mount(
      (options) =>
        success(
          options,
          options.url.endsWith("/capabilities")
            ? { text: true, image: true, voice: true, provider: "dashscope", reason: null }
            : {
                sessionId,
                ticket: "ticket",
                expiresIn: 60,
                socketPath: "/v1/media/voice/stream",
                sampleRate: 16000,
                format: "pcm16",
              },
        ),
      false,
      "home",
      {
        getDeviceInfo: () => ({ platform: "android" }),
        authorize: ({ success }: any) => success(),
        getRecorderManager: () => ({
          onStart: (f: any) => (rec.start = f),
          onStop: (f: any) => (rec.stop = f),
          onFrameRecorded: () => {},
          onError: () => {},
          onInterruptionBegin: () => {},
          start: () => rec.start(),
          stop: () => {
            rec.stopped = true;
            rec.stop();
          },
        }),
        connectSocket: () => ({
          onMessage: (f: any) => (socket.message = f),
          onError: () => {},
          onClose: () => {},
          send: () => {},
          close: () => (socket.closed = true),
        }),
      },
    );
    page.chooseVoice();
    await page.voiceTouchStart({ touches: [{ clientY: 300 }] });
    socket.message({ data: JSON.stringify({ type: "ready", sessionId }) });
    socket.message({ data: JSON.stringify({ type: "partial", text: "没有说完的念头" }) });
    page.voiceTouchEnd();
    expect(page.data.cards[0].phase).toBe("TRANSCRIBING");
    page.onHide();
    expect(page.data.cards[0].phase).toBe("FAILED_LOCAL");
    expect(rec.stopped).toBe(true);
    expect(socket.closed).toBe(true);
    expect(page.data.draft).toBe("没有说完的念头");
    socket.message({ data: JSON.stringify({ type: "done", text: "迟到的结果", sessionId }) });
    expect(page.data.draft).toBe("没有说完的念头");
    page.chooseText();
    expect(page.runtime.voiceSessionId).toBe("");
    page.onUnload();
  });
  it("shows configuration and DevTools limitations without clearing the existing draft", async () => {
    let configured = false;
    const rec: any = {};
    const page = mount(
      (options) => {
        if (options.url.endsWith("/voice/sessions"))
          options.success({
            statusCode: 503,
            data: { error: { code: "VOICE_CONFIGURATION_MISSING", request_id: requestId } },
          });
        else
          success(options, {
            text: true,
            image: configured,
            voice: configured,
            provider: "dashscope",
            reason: "not_configured",
          });
      },
      false,
      "home",
      {
        getDeviceInfo: () => ({ platform: configured ? "devtools" : "ios" }),
        authorize: ({ success }: any) => success(),
        getRecorderManager: () => ({
          onStart: (f: any) => (rec.start = f),
          onStop: (f: any) => (rec.stop = f),
          onFrameRecorded: () => {},
          onError: () => {},
          onInterruptionBegin: () => {},
          start: () => rec.start(),
          stop: () => rec.stop(),
        }),
        connectSocket: () => {
          throw new Error("should not connect");
        },
      },
    );
    page.setData({ draft: "没有提交的原文" });
    await page.chooseImage();
    expect(page.data.error).toContain("尚未配置");
    page.chooseVoice();
    await page.voiceTouchStart({ touches: [{ clientY: 300 }] });
    expect(page.data.error).toContain("尚未配置");
    configured = true;
    page.chooseVoice();
    await page.voiceTouchStart({ touches: [{ clientY: 300 }] });
    expect(page.data.error).toContain("真机");
    expect(page.data.draft).toBe("没有提交的原文");
    page.onUnload();
  });
  it("shows a sending card immediately, toasts only after receipt, and never blocks on AI list requests", async () => {
    let receive: any;
    const page = mount((options) => {
      if (options.method === "POST") receive = options;
    });
    page.setData({ draft: "这是未经模型整理的很长的原话", sheet: true });
    const saving = page.saveCapture();
    expect(page.data.cards[0].phase).toBe("SENDING");
    expect(page.data.cards[0].title).not.toBe(page.data.draft);
    expect(page.data.tab).toBe("now");
    expect(page.toasts).toHaveLength(0);
    await flushPage();
    success(receive, {
      captureId: randomUUID(),
      status: "UPLOADED",
      accepted: true,
      replayed: false,
    });
    await saving;
    expect(page.data.busy).toBe(false);
    expect(page.data.cards[0].phase).toBe("UPLOADED");
    expect(page.toasts[0].title).toBe("收纳好了");
    page.onUnload();
  });
  it("keeps polling slow jobs with backoff and replaces generic card titles with real AI summaries", async () => {
    const jobs = new Map<number, { fn: () => void; delay: number }>();
    let next = 0,
      ready = false;
    const id = randomUUID();
    const page = mount(
      (options) =>
        success(
          options,
          options.url.endsWith("/sections")
            ? []
            : [
                {
                  id,
                  type: "TEXT",
                  status: ready ? "READY" : "PROCESSING",
                  text: "我想去海边看看，但是还没决定什么时候去",
                  title: ready ? "去海边走走" : null,
                  summary: ready ? "空闲时去看看海，日期还没决定。" : null,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              ],
        ),
      false,
      "home",
      {},
      {
        setTimeout: (fn: () => void, delay: number) => {
          jobs.set(++next, { fn, delay });
          return next;
        },
        clearTimeout: (key: number) => jobs.delete(key),
      },
    );
    page.runtime.visible = true;
    for (let index = 0; index < 25; index++) await page.refreshLists();
    expect(jobs.size).toBe(1);
    expect([...jobs.values()][0].delay).toBe(30000);
    expect(page.data.cards[0].title).toBe("我想去海边看看，但是还没决定什么时候去");
    ready = true;
    await page.refreshLists();
    expect(jobs.size).toBe(0);
    expect(page.data.cards[0].title).toBe("去海边走走");
    expect(page.data.cards[0].summary).toBe("空闲时去看看海，日期还没决定。");
    expect(page.data.cards[0].statusLabel).toBe("已收纳");
    expect(page.data.lifeCaptures).toHaveLength(0);
    page.onUnload();
  });
  it("does not start late recording or submit when a hold is released during the permission prompt", async () => {
    const permission: any = {};
    let microphoneStarts = 0,
      sockets = 0;
    const page = mount(
      (options) =>
        success(options, {
          sessionId: randomUUID(),
          ticket: "test-ticket",
          expiresIn: 60,
          socketPath: "/v1/media/voice/stream",
          sampleRate: 16000,
          format: "pcm16",
        }),
      false,
      "home",
      {
        getDeviceInfo: () => ({ platform: "ios" }),
        authorize: (options: any) => Object.assign(permission, options),
        getRecorderManager: () => {
          microphoneStarts++;
          throw new Error("must not reach microphone");
        },
        connectSocket: () => {
          sockets++;
          throw new Error("must not reach socket");
        },
      },
    );
    page.chooseVoice();
    const starting = page.voiceTouchStart({ touches: [{ clientY: 300 }] });
    await flushPage();
    page.voiceTouchEnd();
    permission.success();
    await starting;
    expect(microphoneStarts).toBe(0);
    expect(sockets).toBe(0);
    expect(page.data.cards).toHaveLength(0);
    expect(page.toasts).toHaveLength(0);
    page.onUnload();
  });
  it("sliding up discards this recording and ignores its late final text without submitting", async () => {
    const rec: any = {},
      socket: any = {};
    const sessionId = randomUUID();
    let captures = 0;
    const page = mount(
      (options) => {
        if (options.url.endsWith("/voice/sessions"))
          success(options, {
            sessionId,
            ticket: "test-ticket",
            expiresIn: 60,
            socketPath: "/v1/media/voice/stream",
            sampleRate: 16000,
            format: "pcm16",
          });
        else captures++;
      },
      false,
      "home",
      {
        getDeviceInfo: () => ({ platform: "ios" }),
        authorize: ({ success }: any) => success(),
        getRecorderManager: () => ({
          onStart: (f: any) => (rec.start = f),
          onStop: (f: any) => (rec.stop = f),
          onFrameRecorded: () => {},
          onError: () => {},
          onInterruptionBegin: () => {},
          start: () => rec.start(),
          stop: () => rec.stop(),
        }),
        connectSocket: () => ({
          onMessage: (f: any) => (socket.message = f),
          onError: () => {},
          onClose: () => {},
          send: () => {},
          close: () => (socket.closed = true),
        }),
      },
    );
    page.setData({ draft: "先前留下的未提交文字" });
    page.chooseVoice();
    await page.voiceTouchStart({ touches: [{ clientY: 300 }] });
    socket.message({ data: JSON.stringify({ type: "ready", sessionId }) });
    socket.message({ data: JSON.stringify({ type: "partial", text: "这段不想收好" }) });
    page.voiceTouchMove({ touches: [{ clientY: 180 }] });
    expect(page.data.voiceCancelGesture).toBe(true);
    page.voiceTouchEnd();
    socket.message({ data: JSON.stringify({ type: "done", text: "迟到的文字", sessionId }) });
    await flushPage();
    expect(page.data.draft).toBe("先前留下的未提交文字");
    expect(page.data.cards).toHaveLength(0);
    expect(captures).toBe(0);
    expect(socket.closed).toBe(true);
    page.onUnload();
  });
  it("waits for image confirmation, preserves its bytes on failure and retries with the same key", async () => {
    const writes: any[] = [];
    let choices = 0;
    const page = mount(
      (options) => {
        if (options.url.endsWith("/capabilities"))
          success(options, {
            text: true,
            image: true,
            voice: true,
            provider: "qwen",
            reason: null,
          });
        else if (options.method === "POST" && options.url.endsWith("/captures")) {
          writes.push(options);
          if (writes.length === 1) options.fail({ errMsg: "offline" });
          else
            success(options, {
              captureId: randomUUID(),
              status: "UPLOADED",
              accepted: true,
              replayed: true,
            });
        } else success(options, []);
      },
      false,
      "home",
      {
        chooseMedia: ({ success }: any) => {
          choices++;
          success({ tempFiles: [{ tempFilePath: "/tmp/photo.jpg", size: 10 }] });
        },
        getFileSystemManager: () => ({
          readFile: ({ success }: any) => success({ data: "/9j/AAAA" }),
        }),
      },
    );
    page.openCapture();
    await page.chooseImage();
    await flushPage();
    expect(writes).toHaveLength(0);
    expect(page.data.sheet).toBe(true);
    page.editDraft({ detail: { value: "确认前补充的文字" } });
    await page.saveCapture();
    expect(writes).toHaveLength(1);
    expect(writes[0].data.text).toBe("确认前补充的文字");
    expect(page.data.cards[0].phase).toBe("FAILED_LOCAL");
    expect(page.runtime.image.base64).toBe("/9j/AAAA");
    expect(page.data.imagePath).toBe("/tmp/photo.jpg");
    expect(page.toasts).toHaveLength(0);
    page.retryCapture();
    await flushPage();
    expect(writes).toHaveLength(2);
    expect(choices).toBe(1);
    expect(writes[0].header["X-Idempotency-Key"]).toBe(writes[1].header["X-Idempotency-Key"]);
    expect(page.toasts[0].title).toBe("收纳好了");
    page.onUnload();
  });
});

describe("Home capture pagination and operation fencing", () => {
  function capture(title: string) {
    return {
      id: randomUUID(),
      type: "TEXT",
      status: "READY",
      text: title,
      title,
      summary: title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  function now() {
    return {
      sessionId: randomUUID(),
      status: "RECOMMENDED",
      replayed: false,
      question: null,
      recommendation: {
        id: randomUUID(),
        targetLifeObjectId: randomUUID(),
        headline: "读一页",
        body: "从一页开始",
        reasonText: "记录中的阅读计划",
        executionType: "READ",
        score: 1,
      },
      candidates: [],
    };
  }
  const event = (type: string) => ({ currentTarget: { dataset: { type } } });
  const feedbackReceipt = (type: string) => ({
    feedbackId: randomUUID(),
    eventType: type,
    replayedClientEvent: false,
    replayed: false,
  });

  it("reaches older records, deduplicates pages and retries the same failed cursor", async () => {
    const first = capture("新记录"),
      second = capture("旧记录");
    const reads: string[] = [];
    let fail = true;
    const page = mount((options) => {
      if (options.url.endsWith("/sections")) return success(options, []);
      reads.push(options.url);
      if (options.url.includes("?cursor=")) {
        if (fail) {
          fail = false;
          options.fail({ errMsg: "offline" });
        } else success(options, { items: [first, second], nextCursor: null });
      } else success(options, { items: [first], nextCursor: "test-cursor" });
    });
    await page.refreshLists();
    expect(page.data.capturesHasMore).toBe(true);
    await page.loadMoreCaptures();
    expect(page.data.capturesMoreError).not.toBe("");
    expect(page.data.capturesLoading).toBe(false);
    await page.loadMoreCaptures();
    expect(reads.slice(-2)).toEqual([reads[1], reads[1]]);
    expect(page.data.cards.map((card: any) => card.id)).toEqual([first.id, second.id]);
    expect(page.data.capturesHasMore).toBe(false);
    await page.refreshLists();
    expect(page.data.cards.map((card: any) => card.id)).toEqual([first.id]);
    expect(page.runtime.captureCursor).toBe("test-cursor");
    page.onUnload();
  });
  it.each(["refresh", "logout"])("discards a late older-record page after %s", async (change) => {
    const first = capture("第一条"),
      old = capture("旧一条");
    let later: any;
    const page = mount((options) => {
      if (options.url.endsWith("/sections")) success(options, []);
      else if (options.url.includes("?cursor=")) later = options;
      else success(options, { items: [first], nextCursor: "next" });
    });
    await page.refreshLists();
    const loading = page.loadMoreCaptures();
    await flushPage();
    if (change === "refresh") await page.refreshLists();
    else {
      page.services.client.clear();
      await flushPage();
    }
    success(later, { items: [old], nextCursor: null });
    await loading;
    expect(page.data.cards.some((card: any) => card.id === old.id)).toBe(false);
    expect(page.data.capturesLoading).toBe(false);
    page.onUnload();
  });
  it.each(["capture", "feedback"])(
    "does not reinstall a stale %s key or reset a later busy operation",
    async (kind) => {
      let complete!: (key: string) => void;
      let calls = 0;
      const page = mount(() => {
        calls++;
      });
      page.services.client.newKey = () =>
        new Promise((resolve: any) => {
          complete = resolve;
        });
      const current = now();
      page.setData({
        draft: "保留草稿",
        sessionId: current.sessionId,
        recommendation: current.recommendation,
      });
      const pending = kind === "capture" ? page.saveCapture() : page.feedback(event("SKIP"));
      page.onHide();
      page.setData({ busy: true });
      // Feedback prepares two UUIDs; each should stop before preparing the next stale key.
      const original = page.services.client.newKey;
      page.services.client.newKey = async () => randomUUID();
      complete(randomUUID());
      await pending;
      expect(page.runtime[kind === "capture" ? "capturePending" : "feedbackPending"]).toBeNull();
      expect(page.data.busy).toBe(true);
      expect(calls).toBe(0);
      page.services.client.newKey = original;
      page.onUnload();
    },
  );
  it("does not apply an old owner's feedback receipt", async () => {
    let later: any;
    const page = mount((options) => {
      later = options;
    });
    const current = now();
    page.setData({ sessionId: current.sessionId, recommendation: current.recommendation });
    const posting = page.feedback(event("REJECT"));
    await flushPage();
    page.services.client.clear();
    await flushPage();
    page.setData({ busy: true, notice: "新操作" });
    success(later, feedbackReceipt("REJECT"));
    await posting;
    expect(page.data.notice).toBe("新操作");
    expect(page.data.busy).toBe(true);
    expect(page.runtime.feedbackReceipt).toBeNull();
    page.onUnload();
  });
  it("reconciles a successful hidden completion on return without resending feedback or inventing elapsed time", async () => {
    let later: any;
    let posts = 0;
    const page = mount((options) => {
      if (options.url.endsWith("/feedback")) {
        posts++;
        later = options;
      } else success(options, []);
    });
    const current = now();
    page.setData({ sessionId: current.sessionId, recommendation: current.recommendation });
    const posting = page.feedback(event("COMPLETE"));
    await flushPage();
    page.onHide();
    success(later, feedbackReceipt("COMPLETE"));
    await posting;
    expect(page.data.recommendation).not.toBeNull();
    expect(page.data.busy).toBe(false);
    expect(page.runtime.feedbackReceipt).not.toBeNull();
    page.onShow();
    await flushPage();
    expect(page.data.recommendation).toBeNull();
    expect(page.data.notice).toBe("这一步完成了。");
    expect(posts).toBe(1);
    page.onUnload();
  });
  it("rejects blank and overlength text and clamps only user text editing", async () => {
    let writes = 0;
    const page = mount((options) => {
      if (options.method === "POST") writes++;
    });
    for (const draft of ["   ", "字".repeat(5001)]) {
      page.setData({ draft });
      await page.saveCapture();
      expect(page.data.error).toContain("5000");
    }
    expect(writes).toBe(0);
    page.editDraft({ detail: { value: "字".repeat(5001) } });
    expect(page.data.draft.length).toBe(5000);
    page.onUnload();
  });
  it("preserves an existing image when native reselection is cancelled and posts only after confirmation", async () => {
    let selected = 0,
      writes = 0;
    const png = "iVBORw0KGgo=";
    const page = mount(
      (options) => {
        if (options.url.endsWith("/capabilities"))
          success(options, {
            text: true,
            image: true,
            voice: false,
            provider: "test",
            reason: null,
          });
        else if (options.method === "POST") {
          writes++;
          options.fail({ errMsg: "offline" });
        } else success(options, []);
      },
      false,
      "home",
      {
        chooseMedia: (options: any) => {
          if (++selected === 1)
            options.success({ tempFiles: [{ tempFilePath: "/local/photo.png", size: 8 }] });
          else options.fail({ errMsg: "chooseMedia:fail cancel" });
        },
        getFileSystemManager: () => ({
          readFile: (options: any) => options.success({ data: png }),
        }),
      },
    );
    page.setData({ sheet: true });
    await page.chooseImage();
    await page.chooseImage();
    expect(page.data.imagePath).toBe("/local/photo.png");
    expect(page.runtime.image.base64).toBe(png);
    expect(writes).toBe(0);
    await page.saveCapture();
    expect(writes).toBe(1);
    expect(page.data.imagePath).toBe("/local/photo.png");
    expect(page.runtime.capturePending).not.toBeNull();
    page.removeImage();
    expect(page.runtime.image).toBeNull();
    expect(page.data.imagePath).toBe("");
    page.onUnload();
  });
  it("offers permission settings and ignores its late response after logout", async () => {
    let permission: any, opened: any;
    const page = mount(() => {}, false, "home", {
      authorize: (options: any) => {
        permission = options;
      },
      openSetting: (options: any) => {
        opened = options;
      },
    });
    page.chooseVoice();
    permission.fail();
    expect(page.data.capturePermission).toBe("scope.record");
    page.openCapturePermissions();
    expect(opened).toBeDefined();
    page.services.client.clear();
    await flushPage();
    opened.success({ authSetting: { "scope.record": true } });
    expect(page.data.notice).toBe("");
    expect(page.data.capturePermission).toBe("");
    page.onUnload();
  });
});

describe("Home location preference and return readback", () => {
  function ready(page: any) {
    const sessionId = randomUUID(),
      target = randomUUID();
    page.setData({
      sessionId,
      recommendation: { targetLifeObjectId: target },
      canVerifyRoute: true,
      hasConfirmedDestination: true,
    });
    return sessionId;
  }
  it.each([false, true])(
    "uses GPS only after the route action and honors useLocation=%s",
    async (allowed) => {
      let locations = 0;
      const page = mount(() => {}, false, "home", {
        request: (options: any) =>
          success(
            options,
            userSettingsResponseSchema.parse({
              recommendation: {},
              privacy: { useLocation: allowed },
              notifications: {},
              onboardingCompleted: true,
              updatedAt: null,
            }),
          ),
        getLocation: ({ fail }: any) => {
          locations++;
          fail({ errMsg: "denied" });
        },
      });
      ready(page);
      expect(locations).toBe(0);
      await page.verifyCurrentRoute();
      expect(locations).toBe(allowed ? 1 : 0);
      expect(page.data.locationSheet).toBe(!allowed);
      if (!allowed) {
        await page.confirmRouteLocation();
        expect(locations).toBe(1);
        expect(page.data.locationSheet).toBe(false);
      }
      page.onUnload();
    },
  );
  it.each(["offline", "hide", "logout"])(
    "makes no GPS request after a %s settings read",
    async (change) => {
      let settings: any;
      const page = mount(() => {}, false, "home", {
        request: (options: any) => {
          settings = options;
        },
      });
      ready(page);
      const checking = page.verifyCurrentRoute();
      await flushPage();
      if (change === "offline") settings.fail({ errMsg: "offline" });
      else {
        if (change === "hide") page.onHide();
        else {
          page.services.client.clear();
          await flushPage();
        }
        success(
          settings,
          userSettingsResponseSchema.parse({
            recommendation: {},
            privacy: { useLocation: true },
            notifications: {},
            onboardingCompleted: true,
            updatedAt: null,
          }),
        );
      }
      await checking;
      expect(page.locationCalls()).toBe(0);
      expect(page.data.busy).toBe(false);
      page.onUnload();
    },
  );
  it("reads the current session after detail return and removes a source that is no longer recommended", async () => {
    let reads = 0;
    let sessionId = "";
    const page = mount((options) => {
      if (options.url.endsWith(`/now/sessions/${sessionId}`)) {
        reads++;
        success(options, {
          sessionId,
          status: "QUIET",
          replayed: false,
          recommendation: null,
          candidates: [],
          question: null,
        });
      } else success(options, []);
    });
    sessionId = ready(page);
    page.viewLifeItem({ currentTarget: { dataset: { id: randomUUID() } } });
    page.onHide();
    page.onShow();
    await flushPage();
    expect(reads).toBe(1);
    expect(page.data.recommendation).toBeNull();
    expect(page.data.canVerifyRoute).toBe(false);
    expect(page.data.sessionId).toBe("");
    page.onUnload();
  });
  it("reuses the same conditioned Now idempotency key after a failed request", async () => {
    const writes: any[] = [];
    const page = mount((options) => {
      if (options.method !== "POST") return success(options, []);
      writes.push(options);
      if (writes.length === 1) options.fail({ errMsg: "offline" });
      else
        success(options, {
          sessionId: randomUUID(),
          status: "QUIET",
          replayed: true,
          recommendation: null,
          candidates: [],
          question: null,
        });
    });
    page.setData({
      conditionGoingOut: "no",
      conditionMinutes: "30",
      conditionBudget: "0",
      conditionsSheet: true,
    });
    await page.applyConditions();
    expect(page.data.busy).toBe(false);
    await page.decide();
    expect(writes).toHaveLength(2);
    expect(writes[0].data.context).toEqual({
      availableMinutes: 30,
      budgetMinor: 0,
      willingToGoOut: false,
    });
    expect(writes[0].header["idempotency-key"]).toBe(writes[1].header["idempotency-key"]);
    expect(page.runtime.nextDecisionContext).toBeNull();
    expect(page.data.decided).toBe(true);
    page.onUnload();
  });
});

describe("Native image picker lifecycle", () => {
  it.each(["return", "logout", "unload"])(
    "handles a camera/album selection after %s without automatic submission",
    async (change) => {
      let picker: any;
      let writes = 0;
      const page = mount(
        (options) => {
          if (options.url.endsWith("/capabilities"))
            success(options, {
              text: true,
              image: true,
              voice: false,
              provider: "test",
              reason: null,
            });
          else if (options.method === "POST") writes++;
          else success(options, []);
        },
        false,
        "home",
        {
          chooseMedia: (options: any) => {
            picker = options;
          },
          getFileSystemManager: () => ({
            readFile: ({ success }: any) => success({ data: "iVBORw0KGgo=" }),
          }),
        },
      );
      page.setData({ sheet: true });
      const choosing = page.chooseImage();
      await flushPage();
      page.onHide();
      if (change === "logout") {
        page.services.client.clear();
        await flushPage();
      }
      if (change === "unload") page.onUnload();
      picker.success({ tempFiles: [{ tempFilePath: "/local/returned.png", size: 8 }] });
      await choosing;
      if (change === "return") {
        page.onShow();
        expect(page.data.imagePath).toBe("/local/returned.png");
        expect(page.data.sheet).toBe(true);
        expect(page.data.imageLoading).toBe(false);
      } else expect(page.runtime.image).toBeNull();
      expect(writes).toBe(0);
      page.onUnload();
    },
  );
});

it("shows distinct raw-text titles for unorganized records without changing original text", async () => {
  const texts = ["第一条记录\n第二行还要保留", "😀".repeat(55) + "\n尾行"];
  const items = texts.map((text, index) => ({
    id: randomUUID(),
    type: "TEXT",
    status: index === 0 ? "FAILED" : "NEEDS_REVIEW",
    text,
    title: null,
    summary: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  items.push({ ...items[0], id: randomUUID(), type: "IMAGE", text: "", status: "PROCESSING" });
  const page = mount((options) =>
    success(options, options.url.endsWith("/sections") ? [] : { items, nextCursor: null }),
  );
  await page.refreshLists();
  expect(page.data.cards.map((card: any) => card.title)).toEqual([
    "第一条记录",
    "😀".repeat(48) + "…",
    "留下一张图片",
  ]);
  expect(page.data.cards[0].summary).toContain("原始内容已保留");
  page.viewCapture({ currentTarget: { dataset: { id: items[1].id } } });
  expect(page.data.captureReview.original).toBe(texts[1]);
  expect(page.data.captures[1].text).toBe(texts[1]);
  page.onUnload();
});

it("replaces the superseded failed draft card so its retry cannot silently submit another draft", async () => {
  const page = mount((options) => {
    if (options.method === "POST") options.fail({ errMsg: "offline" });
    else success(options, []);
  });
  page.setData({ draft: "第一次草稿" });
  await page.saveCapture();
  page.setData({ draft: "修改后的草稿" });
  await page.saveCapture();
  const failures = page.data.cards.filter((card: any) => card.phase === "FAILED_LOCAL");
  expect(failures).toHaveLength(1);
  expect(failures[0].original).toBe("修改后的草稿");
  page.viewCapture({ currentTarget: { dataset: { id: failures[0].id } } });
  expect(page.data.captureReview.original).toBe("修改后的草稿");
  page.onUnload();
});

describe("returning sessions and first-use setup", () => {
  it("checks onboarding for a restored login and retries a failed read on return", async () => {
    let reads = 0;
    const page = mount(() => {}, false, "home", {
      request: (options: any) => {
        if (options.url.endsWith("/v1/settings")) {
          if (++reads === 1) options.fail({ errMsg: "offline" });
          else
            success(
              options,
              userSettingsResponseSchema.parse({
                recommendation: {},
                privacy: {},
                notifications: {},
                onboardingCompleted: false,
                updatedAt: null,
              }),
            );
        } else if (options.url.includes("/v1/captures/page"))
          success(options, { items: [], nextCursor: null });
        else success(options, []);
      },
    });
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    page.onShow();
    await flush();
    expect(page.data.onboardingError).not.toBe("");
    expect(page.navigations).toEqual([]);
    page.onHide();
    page.onShow();
    await flush();
    expect(reads).toBe(2);
    expect(page.navigations).toEqual(["/pages/onboarding/index"]);
    await page.checkOnboarding();
    expect(reads).toBe(2);
    page.onUnload();
  });
});
