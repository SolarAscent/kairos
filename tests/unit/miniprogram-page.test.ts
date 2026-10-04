import { readFileSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const requestId = randomUUID();
const userId = randomUUID();
function mount(send: (options: any) => void, nonCallableFunction = false, route = "home") {
  let definition: any;
  let app: any;
  const navigations: string[] = [];
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
        request: send,
        navigateTo: ({ url }: any) => navigations.push(url),
        navigateBack: () => {},
        getLocation: ({ fail }: any) => {
          locationCalls++;
          fail({ errMsg: "denied" });
        },
      },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  // WeChat scopes every CommonJS module; isolate bundle-local variables the same way.
  runInContext(
    "(function(){" + readFileSync("apps/miniprogram/dist/app.js", "utf8") + "\n})();",
    context,
  );
  function loadRoute(name: string) {
    runInContext(
      "(function(){" +
        readFileSync(
          name === "home"
            ? (process.env.MINIPROGRAM_TEST_BUNDLE ?? "apps/miniprogram/dist/pages/home/index.js")
            : `apps/miniprogram/dist/pages/${name}/index.js`,
          "utf8",
        ) +
        "\n})();",
      context,
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
      locationCalls: () => locationCalls,
      services: app.globalData,
    };
    page.onLoad({ section: "RECENT" });
    return page;
  }
  return createInstance();
}
function success(options: any, data: unknown) {
  options.success({ statusCode: 200, data: { data, request_id: requestId } });
}
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
    expect(page.data.notice).toBe("收到了");
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
    expect(page.data.sheet).toBe(true);
    expect(page.data.error).toContain("暂时连接不上");
    await page.saveCapture();
    expect(writes).toHaveLength(2);
    expect(writes[0].header["X-Idempotency-Key"]).toBe(writes[1].header["X-Idempotency-Key"]);
    expect(writes[1].data.sourceChannel).toBe("MINIPROGRAM");
    expect(page.data.draft).toBe("");
    expect(page.data.notice).toBe("收到了");
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
