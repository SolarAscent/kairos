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
function unauthorized(options: any) {
  options.success({ statusCode: 401, data: { error: { code: "ACCESS_TOKEN_EXPIRED" } } });
}
function mount(
  route: "settings" | "onboarding" | "life-detail",
  send: (options: any) => void,
  extras: Record<string, any> = {},
) {
  let app: any;
  let definition: any;
  const storage = new Map<string, unknown>();
  const navigations: string[] = [];
  const removedFiles: string[] = [];
  const writtenFiles: { path: string; text: string }[] = [];
  const sessionKey = "kairos:develop:touristappid:http://127.0.0.1:3000";
  storage.set(sessionKey, {
    userId,
    accessToken: "test-access",
    refreshToken: "test-refresh-" + "x".repeat(40),
    expiresIn: 1200,
    expiresAt: Date.now() + 1200000,
  });
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
      Page: (value: unknown) => {
        definition = value;
      },
      wx: {
        env: { USER_DATA_PATH: "/user-data" },
        getStorageSync: (key: string) => storage.get(key),
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
        request: (options: any) => {
          if (options.url.endsWith("/v1/users/me") && options.method === "GET")
            success(options, {
              userId,
              nickname: null,
              bio: "",
              avatarVersion: null,
              identityProvider: "WECHAT",
              createdAt: "2026-10-08T00:00:00.000Z",
              updatedAt: "2026-10-08T00:00:00.000Z",
            });
          else send(options);
        },
        getFileSystemManager: () => fileSystem,
        navigateTo: ({ url }: any) => navigations.push(url),
        redirectTo: ({ url }: any) => navigations.push(url),
        reLaunch: ({ url }: any) => navigations.push(url),
        navigateBack: () => {},
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
  else page.onLoad();
  return page;
}
async function flush() {
  for (let i = 0; i < 14; i++) await Promise.resolve();
}

describe("compiled settings, onboarding, and life-detail pages", () => {
  it("keeps onboarding unfinished after a lost save and retries the same operation without resaving the nickname", async () => {
    const profileWrites: any[] = [];
    const settingsWrites: any[] = [];
    const page = mount("onboarding", (options) => {
      if (options.method === "GET") success(options, settings());
      else if (options.url.endsWith("/v1/users/me/profile")) {
        profileWrites.push(options);
        success(options, {
          userId,
          nickname: options.data.nickname,
          bio: "",
          avatarVersion: null,
          identityProvider: "WECHAT",
          createdAt: "2026-10-08T00:00:00.000Z",
          updatedAt: "2026-10-08T00:00:00.000Z",
        });
      } else {
        settingsWrites.push(options);
        if (settingsWrites.length === 1) options.fail({ errMsg: "response lost" });
        else success(options, { ...settings(), onboardingCompleted: true });
      }
    });
    page.onShow();
    await flush();
    page.editNickname({ detail: { value: "小林" } });
    page.select({ currentTarget: { dataset: { field: "relaxation", value: "QUIET" } } });
    await page.finish();
    expect(page.navigations).toEqual([]);
    expect(page.data.nickname).toBe("小林");
    expect(page.data.error).not.toBe("");
    await page.finish();
    expect(profileWrites).toHaveLength(1);
    expect(settingsWrites).toHaveLength(2);
    expect(settingsWrites[1].header["X-Idempotency-Key"]).toBe(
      settingsWrites[0].header["X-Idempotency-Key"],
    );
    expect(settingsWrites[1].data.recommendation.relaxation).toBe("QUIET");
    expect(page.navigations).toEqual(["/pages/home/index"]);
    page.onUnload();
  });
  it("persists only completion when skipping and retains its key after a network failure", async () => {
    const writes: any[] = [];
    const page = mount("onboarding", (options) => {
      if (options.method === "GET") success(options, settings());
      else {
        writes.push(options);
        if (writes.length === 1) options.fail({ errMsg: "offline" });
        else success(options, { ...settings(), onboardingCompleted: true });
      }
    });
    page.onShow();
    await flush();
    page.editNickname({ detail: { value: "不应保存的草稿" } });
    page.select({ currentTarget: { dataset: { field: "defaultBudget", value: "100" } } });
    await page.skip();
    expect(page.navigations).toEqual([]);
    await page.skip();
    expect(writes.map((item) => item.data)).toEqual([
      { onboardingCompleted: true },
      { onboardingCompleted: true },
    ]);
    expect(writes[1].header["X-Idempotency-Key"]).toBe(writes[0].header["X-Idempotency-Key"]);
    expect(page.navigations).toEqual(["/pages/home/index"]);
    page.onUnload();
  });
  it("retries a lost settings response with the same PATCH idempotency key and blocks duplicates", async () => {
    const requests: any[] = [];
    const writes: any[] = [];
    let retryRequest: any;
    const page = mount("settings", (options) => {
      requests.push(options);
      if (options.url.endsWith("/v1/settings") && options.method === "GET")
        success(options, settings());
      else if (options.url.endsWith("/v1/ui-capabilities")) success(options, capabilities());
      else if (options.url.endsWith("/v1/settings/update") && options.method === "POST") {
        writes.push(options);
        if (writes.length === 1) options.fail({ errMsg: "response lost" });
        else retryRequest = options;
      } else throw new Error(`Unexpected request ${options.method} ${options.url}`);
    });
    page.onShow();
    await flush();
    expect(page.data.loaded).toBe(true);
    page.applyChange("homeRegion", "越秀区文德路周边");
    page.applyChange("frequentAreas", ["天河", "越秀"]);
    page.applyChange("useLocation", true);
    page.applyChange("notificationsEnabled", true);
    const first = page.save();
    await flush();
    expect(writes).toHaveLength(1);
    const firstKey = writes[0].header["X-Idempotency-Key"];
    expect(writes[0].url).toMatch(/\/v1\/settings\/update$/);
    expect(writes[0].method).toBe("POST");
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(writes[0].data).toMatchObject({
      recommendation: {
        homeRegion: "越秀区文德路周边",
        frequentAreas: ["天河", "越秀"],
      },
      privacy: { useLocation: true },
      notifications: { enabled: true },
    });
    await first;
    expect(page.data.dirty).toBe(true);
    expect(page.data.error).not.toBe("");
    const retry = page.save();
    await flush();
    const duplicate = page.save();
    page.applyChange("homeRegion", "忙碌期间不应覆盖");
    page.editHomeRegion({ detail: { value: "忙碌期间不应覆盖" } } as any);
    await flush();
    expect(writes).toHaveLength(2);
    expect(writes[1].header["X-Idempotency-Key"]).toBe(firstKey);
    expect(page.data.homeRegion).toBe("越秀区文德路周边");
    success(retryRequest, {
      ...settings(),
      recommendation: {
        ...settings().recommendation,
        homeRegion: "越秀区文德路周边",
        frequentAreas: ["天河", "越秀"],
      },
      privacy: { useLocation: true },
      notifications: { enabled: true },
    });
    await Promise.all([retry, duplicate]);
    expect(page.data.dirty).toBe(false);
    expect(page.data.status).toBe("设定已保存");
    expect(requests.filter((item) => item.method === "POST")).toHaveLength(2);
    page.onUnload();
  });

  it("ignores a settings read receipt after the signed-in account changes", async () => {
    let receive!: (options: any) => void;
    const page = mount("settings", (options) => {
      if (options.url.endsWith("/v1/settings")) receive = options;
      else success(options, capabilities());
    });
    page.onShow();
    await flush();
    expect(page.data.loaded).toBe(false);
    page.services.client.clear();
    success(receive, {
      ...settings(),
      recommendation: { ...settings().recommendation, homeRegion: "上一账号的区域" },
    });
    await flush();
    expect(page.data.homeRegion).not.toBe("上一账号的区域");
    expect(page.data.loaded).toBe(false);
    page.onUnload();
  });

  it("clears old-owner settings and onboarding state when refresh failure clears the session", async () => {
    const staleSettings = () => ({
      ...settings(),
      recommendation: { ...settings().recommendation, homeRegion: "旧账号敏感区域" },
    });
    const settingsFailure = (options: any) => {
      if (options.url.endsWith("/v1/settings")) success(options, staleSettings());
      else if (options.url.endsWith("/v1/ui-capabilities")) unauthorized(options);
      else if (options.url.endsWith("/v1/auth/refresh")) options.fail({ errMsg: "offline" });
      else throw new Error(`Unexpected request ${options.method} ${options.url}`);
    };
    const page = mount("settings", settingsFailure);
    page.onShow();
    await flush();
    expect(page.services.client.userId).toBe(null);
    expect(page.data.busy).toBe(false);
    expect(page.data.loaded).toBe(false);
    expect(page.data.homeRegion).toBe("");
    expect(page.navigations).toContain("/pages/home/index");
    page.onUnload();

    const onboarding = mount("onboarding", (options) => {
      if (options.url.endsWith("/v1/settings") && options.method === "GET")
        success(options, staleSettings());
      else if (options.url.endsWith("/v1/settings/update")) unauthorized(options);
      else if (options.url.endsWith("/v1/auth/refresh")) options.fail({ errMsg: "offline" });
      else throw new Error(`Unexpected request ${options.method} ${options.url}`);
    });
    onboarding.onShow();
    await flush();
    expect(onboarding.data.loaded).toBe(true);
    expect(onboarding.data.homeRegion).toBe("旧账号敏感区域");
    const completion = onboarding.finish();
    await flush();
    await completion;
    expect(onboarding.services.client.userId).toBe(null);
    expect(onboarding.data.loading).toBe(false);
    expect(onboarding.data.loaded).toBe(false);
    expect(onboarding.data.homeRegion).toBe("");
    expect(onboarding.navigations).toContain("/pages/home/index");
    onboarding.onUnload();
  });

  it("ignores settings and onboarding reads that finish after hide, then reloads on return", async () => {
    let settingsRead!: (options: any) => void;
    let settingsReads = 0;
    const page = mount("settings", (options) => {
      if (options.url.endsWith("/v1/settings")) {
        if (++settingsReads === 1) settingsRead = options;
        else success(options, settings());
      } else success(options, capabilities());
    });
    page.onShow();
    await flush();
    page.onHide();
    success(settingsRead, {
      ...settings(),
      recommendation: { ...settings().recommendation, homeRegion: "隐藏期间的旧响应" },
    });
    await flush();
    expect(page.data.homeRegion).not.toBe("隐藏期间的旧响应");
    expect(page.data.loaded).toBe(false);
    page.onShow();
    await flush();
    expect(settingsReads).toBe(2);
    expect(page.data.loaded).toBe(true);
    page.onUnload();

    let onboardingRead!: (options: any) => void;
    let onboardingReads = 0;
    const onboarding = mount("onboarding", (options) => {
      if (++onboardingReads === 1) onboardingRead = options;
      else success(options, settings());
    });
    onboarding.onShow();
    await flush();
    onboarding.onHide();
    success(onboardingRead, {
      ...settings(),
      recommendation: { ...settings().recommendation, homeRegion: "隐藏期间的旧响应" },
    });
    await flush();
    expect(onboarding.data.homeRegion).not.toBe("隐藏期间的旧响应");
    expect(onboarding.data.loaded).toBe(false);
    onboarding.onShow();
    await flush();
    expect(onboardingReads).toBe(2);
    expect(onboarding.data.loaded).toBe(true);
    onboarding.onUnload();
  });

  it("writes the full onboarding draft on completion and persists Skip without overwriting preferences after a failed read", async () => {
    const writes: any[] = [];
    const page = mount("onboarding", (options) => {
      if (options.method === "GET") success(options, settings());
      else {
        writes.push(options);
        success(options, {
          ...settings(),
          recommendation: {
            ...settings().recommendation,
            relaxation: "EXPLORE",
            defaultMinutes: 60,
            defaultBudget: 50,
            goingOut: "YES",
            homeRegion: "越秀区",
          },
          privacy: { useLocation: true },
          onboardingCompleted: true,
        });
      }
    });
    page.onShow();
    await flush();
    page.setData({ step: 2 });
    page.select({ currentTarget: { dataset: { field: "relaxation", value: "EXPLORE" } } } as any);
    page.select({ currentTarget: { dataset: { field: "defaultMinutes", value: "60" } } } as any);
    page.select({ currentTarget: { dataset: { field: "defaultBudget", value: "50" } } } as any);
    page.select({ currentTarget: { dataset: { field: "goingOut", value: "YES" } } } as any);
    page.select({ currentTarget: { dataset: { field: "useLocation", value: "true" } } } as any);
    page.editRegion({ detail: { value: "越秀区" } } as any);
    await page.finish();
    expect(writes).toHaveLength(1);
    expect(writes[0].url).toMatch(/\/v1\/settings\/update$/);
    expect(writes[0].method).toBe("POST");
    expect(writes[0].data).toMatchObject({
      recommendation: {
        relaxation: "EXPLORE",
        defaultMinutes: 60,
        defaultBudget: 50,
        goingOut: "YES",
        homeRegion: "越秀区",
      },
      privacy: { useLocation: true },
      onboardingCompleted: true,
    });
    expect(page.navigations).toContain("/pages/home/index");
    page.onUnload();

    let skippedWrites = 0;
    const skipped = mount("onboarding", (options) => {
      if (options.method === "GET") options.fail({ errMsg: "offline" });
      else {
        skippedWrites++;
        expect(options.data).toEqual({ onboardingCompleted: true });
        success(options, { ...settings(), onboardingCompleted: true });
      }
    });
    skipped.onShow();
    await flush();
    expect(skipped.data.loaded).toBe(false);
    expect(skipped.data.error).not.toBe("");
    await skipped.skip();
    expect(skippedWrites).toBe(1);
    expect(skipped.navigations).toContain("/pages/home/index");
    skipped.onUnload();
  });

  it("disposes the temporary TXT after the user cancels the share chooser", async () => {
    const page = mount(
      "settings",
      (options) => {
        if (options.url.includes("/v1/records/export"))
          success(options, {
            records: [
              {
                id: randomUUID(),
                type: "TEXT",
                status: "READY",
                text: "想去海边",
                title: "看海",
                summary: "傍晚想去海边",
                createdAt: "2026-10-07T08:00:00.000Z",
                updatedAt: "2026-10-07T08:00:00.000Z",
              },
            ],
            nextCursor: null,
            exportedAt: "2026-10-07T08:30:00.000Z",
          });
        else throw new Error(`Unexpected request ${options.method} ${options.url}`);
      },
      { shareFileMessage: () => Promise.reject({ errMsg: "shareFileMessage:fail cancel" }) },
    );
    await page.exportRecords();
    expect(page.data.status).toBe("文件已生成 · 已取消分享");
    expect(page.data.error).toBe("");
    expect(page.writtenFiles).toHaveLength(1);
    expect(page.writtenFiles[0].text).toContain("想去海边");
    expect(page.removedFiles).toEqual([page.writtenFiles[0].path]);
    expect(page.data.exportBusy).toBe(false);
    page.onUnload();
  });

  it("tells DevTools users to share the generated file on WeChat and still disposes it", async () => {
    const page = mount(
      "settings",
      (options) => {
        if (options.url.includes("/v1/records/export"))
          success(options, {
            records: [
              {
                id: randomUUID(),
                type: "TEXT",
                status: "READY",
                text: "周末去公园",
                title: "公园散步",
                summary: "天气好时去散步",
                createdAt: "2026-10-07T08:00:00.000Z",
                updatedAt: "2026-10-07T08:00:00.000Z",
              },
            ],
            nextCursor: null,
            exportedAt: "2026-10-07T08:30:00.000Z",
          });
        else throw new Error(`Unexpected request ${options.method} ${options.url}`);
      },
      {
        wx: { getDeviceInfo: () => ({ platform: "devtools" }) },
        shareFileMessage: () => Promise.reject({ errMsg: "shareFileMessage:fail system error" }),
      },
    );
    await page.exportRecords();
    expect(page.data.status).toBe("已生成 1 条原始记录文件，请在手机微信中分享");
    expect(page.data.error).toBe("");
    expect(page.removedFiles).toEqual([page.writtenFiles[0].path]);
    expect(page.data.exportBusy).toBe(false);
    page.onUnload();
  });

  it("keeps export request failures separate from DevTools share failures", async () => {
    const page = mount(
      "settings",
      (options) => {
        if (options.url.endsWith("/v1/settings")) success(options, settings());
        else if (options.url.endsWith("/v1/ui-capabilities")) success(options, capabilities());
        else if (options.url.includes("/v1/records/export")) options.fail({ errMsg: "offline" });
        else throw new Error(`Unexpected request ${options.method} ${options.url}`);
      },
      { wx: { getDeviceInfo: () => ({ platform: "devtools" }) } },
    );
    page.onShow();
    await flush();
    await page.exportRecords();
    expect(page.data.status).toBe("");
    expect(page.data.error).not.toBe("");
    expect(page.data.error).not.toContain("手机微信中分享");
    expect(page.writtenFiles).toHaveLength(0);
    expect(page.data.exportBusy).toBe(false);
    page.onUnload();
  });

  it("does not render a life detail response that arrives after the page is hidden", async () => {
    let receive!: (options: any) => void;
    const page = mount("life-detail", (options) => {
      receive = options;
    });
    await flush();
    expect(page.data.loading).toBe(true);
    page.onHide();
    success(receive, {
      id: randomUUID(),
      title: "迟到的旧记录",
      summary: null,
      kind: "PLACE",
      status: "ACTIVE",
      objectVersion: 1,
      createdAt: "2026-10-07T08:00:00.000Z",
      updatedAt: "2026-10-07T08:00:00.000Z",
      myRating: "NONE",
      facets: [],
      sources: [],
      verifiedDestination: null,
    });
    await flush();
    expect(page.data.detail).toBe(null);
    expect(page.data.loading).toBe(false);
    page.onUnload();
  });
});
