import { randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const { build } = createRequire(resolve("apps/miniprogram/package.json"))("esbuild") as {
  build: (options: object) => Promise<{ outputFiles: { path: string; text: string }[] }>;
};
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearCaptureImageCache,
  getCaptureImageCacheEpoch,
  readCaptureImage,
} from "../../apps/miniprogram/src/lib/capture-image";
import type { ApiClient } from "../../apps/miniprogram/src/lib/client";

const image = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function nativeFiles() {
  const storage = new Map<string, unknown>();
  const files = new Set<string>();
  const fs = {
    readdirSync: () => [...files].map((path) => path.slice("/owned/".length)),
    unlinkSync: (path: string) => files.delete(path),
    unlink: ({ filePath }: { filePath: string }) => files.delete(filePath),
    writeFile: ({ filePath, success }: { filePath: string; success: () => void }) => {
      files.add(filePath);
      success();
    },
  };
  const wx = {
    env: { USER_DATA_PATH: "/owned" },
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    getFileSystemManager: () => fs,
  };
  return { wx, fs, files, storage };
}
function imageClient(request: () => Promise<unknown> = async () => ({ image })) {
  return {
    userId: randomUUID(),
    request,
    newKey: async () => randomUUID(),
  } as unknown as ApiClient;
}
afterEach(() => vi.unstubAllGlobals());

describe("native image cache invalidation", () => {
  it("shares a persistent epoch and removes only owned cache filenames", async () => {
    const native = nativeFiles();
    vi.stubGlobal("wx", native.wx);
    const first = await readCaptureImage(imageClient(), randomUUID());
    native.files.add("/owned/unrelated-photo.png");
    expect(getCaptureImageCacheEpoch()).toBe(0);
    expect(first!.cacheEpoch).toBe(0);
    expect(clearCaptureImageCache()).toBe(1);
    expect(getCaptureImageCacheEpoch()).toBe(1);
    expect(native.files).toEqual(new Set(["/owned/unrelated-photo.png"]));
    const restored = await readCaptureImage(imageClient(), randomUUID());
    expect(restored!.cacheEpoch).toBe(1);
    expect(restored!.path).not.toBe(first!.path);
    expect(native.files.has(restored!.path)).toBe(true);
  });

  it("rejects an image response that arrives after the cache was cleared", async () => {
    const native = nativeFiles();
    vi.stubGlobal("wx", native.wx);
    let complete!: (value: unknown) => void;
    const client = imageClient(() => new Promise((resolve) => (complete = resolve)));
    const pending = readCaptureImage(client, randomUUID());
    const rejected = expect(pending).rejects.toMatchObject({ code: "IMAGE_CACHE_CLEARED" });
    clearCaptureImageCache();
    complete({ image });
    await rejected;
    expect(native.files.size).toBe(0);
  });

  it("disposes a late native write instead of recreating a cleared cache file", async () => {
    const native = nativeFiles();
    vi.stubGlobal("wx", native.wx);
    let finishWrite!: () => void;
    native.fs.writeFile = ({ filePath, success }) => {
      finishWrite = () => {
        native.files.add(filePath);
        success();
      };
    };
    const pending = readCaptureImage(imageClient(), randomUUID());
    const rejected = expect(pending).rejects.toMatchObject({ code: "IMAGE_CACHE_CLEARED" });
    await flush();
    clearCaptureImageCache();
    finishWrite();
    await rejected;
    expect(native.files.size).toBe(0);
  });
});

let appBundle: string;
let homeBundle: string;
beforeAll(async () => {
  const config = {
    environment: "develop",
    appId: "touristappid",
    apiBaseUrl: "http://127.0.0.1:3000",
    loginMode: "mock",
    appVersion: "cache-regression",
  };
  // Build both entries in one graph like the native build. Nothing is written to dist.
  const result = await build({
    entryPoints: ["apps/miniprogram/src/app.ts", "apps/miniprogram/src/pages/home/index.ts"],
    outbase: "apps/miniprogram/src",
    outdir: "/native-cache-regression",
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    target: "es2020",
    minify: true,
    define: {
      __MINIPROGRAM_CONFIG__: JSON.stringify(config),
      "process.env.NODE_ENV": '\"production\"',
    },
  });
  appBundle = result.outputFiles.find((file) => file.path.endsWith("/app.js"))!.text;
  homeBundle = result.outputFiles.find((file) => file.path.endsWith("/pages/home/index.js"))!.text;
});

it("restores home cards, the recommendation and open source review after settings clears its separate bundle cache", async () => {
  const native = nativeFiles();
  const owner = randomUUID();
  const captureId = randomUUID();
  const target = randomUUID();
  const oldPath = `/owned/kairos-image-${randomUUID()}.png`;
  native.files.add(oldPath);
  native.storage.set("kairos:develop:touristappid:http://127.0.0.1:3000", {
    userId: owner,
    accessToken: "test-access",
    refreshToken: "test-refresh-" + "x".repeat(40),
    expiresIn: 1200,
    expiresAt: Date.now() + 1200000,
  });
  const capture = {
    id: captureId,
    type: "IMAGE",
    status: "READY",
    text: "真实来源记录",
    title: "纸片图文记录",
    summary: "本地测试图片",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let imageRequests = 0;
  let definition: any;
  let app: any;
  const wx = {
    ...native.wx,
    nextTick: (callback: () => void) => Promise.resolve().then(callback),
    getWindowInfo: () => ({ statusBarHeight: 44, screenHeight: 812, safeArea: { bottom: 778 } }),
    getMenuButtonBoundingClientRect: () => ({ bottom: 76 }),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    getAppBaseInfo: () => ({ SDKVersion: "3.7.1" }),
    getRandomValues: ({ success }: any) =>
      success({
        randomValues: new Uint8Array(16).map(() => Math.floor(Math.random() * 256)).buffer,
      }),
    request: (options: any) => {
      let data: unknown;
      if (options.url.endsWith(`/captures/${captureId}/image`)) {
        imageRequests++;
        data = { image };
      } else if (options.url.endsWith(`/life/${target}`)) {
        data = {
          id: target,
          title: capture.title,
          summary: capture.summary,
          kind: "MEDIA",
          status: "ACTIVE",
          objectVersion: 1,
          createdAt: capture.createdAt,
          updatedAt: capture.updatedAt,
          facets: [],
          sources: [
            {
              id: randomUUID(),
              sourceType: "CAPTURE",
              sourceId: captureId,
              isPrimary: true,
              createdAt: capture.createdAt,
            },
          ],
        };
      } else if (options.url.endsWith("/captures/page"))
        data = { items: [capture], nextCursor: null };
      else data = [];
      options.success({ statusCode: 200, data: { data, request_id: randomUUID() } });
    },
  };
  vi.stubGlobal("wx", wx);
  const context = createContext(
    {
      console,
      setTimeout,
      clearTimeout,
      wx,
      Behavior: (value: unknown) => value,
      App: (value: unknown) => (app = value),
      getApp: () => app,
      Page: (value: unknown) => (definition = value),
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  runInContext("(function(){" + appBundle + "})();", context);
  runInContext("(function(){" + homeBundle + "})();", context);
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(values: object) {
      Object.assign(this.data, values);
    },
  };
  page.onLoad({});
  const card = {
    id: captureId,
    title: capture.title,
    summary: capture.summary,
    phase: "READY",
    statusLabel: "已收纳",
    imagePath: oldPath,
  };
  page.setData({
    captures: [capture],
    cards: [card],
    recommendationImage: oldPath,
    captureReview: { ...card, original: capture.text },
    sessionId: randomUUID(),
    recommendation: { targetLifeObjectId: target },
  });
  page.runtime.pictureCache.set(captureId, {
    path: oldPath,
    cacheEpoch: 0,
    dispose: () => native.files.delete(oldPath),
  });
  const generation = page.runtime.pictureGeneration;
  page.onHide();
  clearCaptureImageCache();
  page.onShow();
  expect(page.data.cards[0].imagePath).toBe("");
  expect(page.data.recommendationImage).toBe("");
  expect(page.data.captureReview.imagePath).toBe("");
  expect(page.runtime.pictureGeneration).toBeGreaterThan(generation);
  for (let n = 0; n < 4; n++) await flush();
  const restored = page.data.cards[0].imagePath;
  expect(restored).not.toBe("");
  expect(restored).not.toBe(oldPath);
  expect(native.files.has(restored)).toBe(true);
  expect(page.data.recommendationImage).toBe(restored);
  expect(page.data.captureReview.imagePath).toBe(restored);
  expect(imageRequests).toBe(1);
  page.onUnload();
});
