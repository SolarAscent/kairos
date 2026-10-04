import { readFileSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const requestId = randomUUID();
const userId = randomUUID();
function mount(send: (options: any) => void, nonCallableFunction = false) {
  let definition: any;
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
      },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  runInContext(
    readFileSync(
      process.env.MINIPROGRAM_TEST_BUNDLE ?? "apps/miniprogram/dist/pages/home/index.js",
      "utf8",
    ),
    context,
  );
  function createInstance() {
    const page = {
      ...definition,
      data: JSON.parse(JSON.stringify(definition.data)),
      setData(values: object) {
        Object.assign(this.data, values);
      },
      createInstance,
    };
    page.onLoad();
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
