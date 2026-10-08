import { randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pruneLocalAccountFiles,
  pruneStoredAvatarVersions,
} from "../../apps/miniprogram/src/lib/local-retention";
import { readCaptureImage } from "../../apps/miniprogram/src/lib/capture-image";
import type { ApiClient } from "../../apps/miniprogram/src/lib/client";

const { build } = createRequire(resolve("apps/miniprogram/package.json"))("esbuild") as {
  build: (options: object) => Promise<{ outputFiles: { text: string }[] }>;
};

const root = "/owned";
function localFiles() {
  const files = new Map<string, number>();
  const storage = new Map<string, unknown>();
  let finishWrite: (() => void) | undefined;
  const fs = {
    readdirSync: () => [...files.keys()].map((path) => path.slice(root.length + 1)),
    statSync: (path: string) => ({ lastModifiedTime: files.get(path) }),
    unlinkSync: (path: string) => files.delete(path),
    unlink: ({ filePath }: { filePath: string }) => files.delete(filePath),
    writeFile: ({ filePath, success }: { filePath: string; success: () => void }) => {
      finishWrite = () => {
        files.set(filePath, Date.now() / 1000);
        success();
      };
    },
  };
  const wx = {
    env: { USER_DATA_PATH: root },
    getFileSystemManager: () => fs,
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
  };
  return {
    files,
    storage,
    wx,
    finishWrite: () => {
      if (!finishWrite) throw new Error("IMAGE_WRITE_NOT_STARTED");
      finishWrite();
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("local account file retention", () => {
  it("removes unowned Kairos caches and foreign avatars while keeping the current avatar and drafts", () => {
    const native = localFiles();
    vi.stubGlobal("wx", native.wx);
    const owner = randomUUID(),
      other = randomUUID(),
      currentVersion = randomUUID(),
      staleVersion = randomUUID();
    const recent = Date.now() / 1000 - 60;
    const currentAvatar = `${root}/kairos-avatar-${owner}-${currentVersion}.png`;
    const staleAvatar = `${root}/kairos-avatar-${owner}-${staleVersion}.png`;
    const otherAvatar = `${root}/kairos-avatar-${other}-${randomUUID()}.png`;
    const recentImage = `${root}/kairos-image-${randomUUID()}.png`;
    const secondImage = `${root}/kairos-image-${randomUUID()}.jpg`;
    const exportFile = `${root}/kairos-records-${randomUUID()}.txt`;
    const draft = `${root}/my-picture-in-progress.png`;
    const unrelated = `${root}/kairos-image-not-a-uuid.png`;
    for (const path of [
      currentAvatar,
      staleAvatar,
      otherAvatar,
      recentImage,
      exportFile,
      draft,
      unrelated,
    ])
      native.files.set(path, recent);
    native.files.set(secondImage, recent);

    pruneLocalAccountFiles(owner);
    expect(native.files.has(currentAvatar)).toBe(true);
    expect(native.files.has(recentImage)).toBe(false);
    expect(native.files.has(draft)).toBe(true);
    expect(native.files.has(unrelated)).toBe(true);
    expect(native.files.has(otherAvatar)).toBe(false);
    expect(native.files.has(secondImage)).toBe(false);
    expect(native.files.has(exportFile)).toBe(false);

    pruneStoredAvatarVersions(owner, currentVersion);
    expect(native.files.has(currentAvatar)).toBe(true);
    expect(native.files.has(staleAvatar)).toBe(false);
  });

  it("invalidates a late image write on account change without touching an in-progress draft", async () => {
    const native = localFiles();
    vi.stubGlobal("wx", native.wx);
    const oldOwner = randomUUID(),
      newOwner = randomUUID(),
      draft = `${root}/my-picture-in-progress.png`;
    native.files.set(draft, Date.now() / 1000);
    const client = {
      userId: oldOwner,
      request: async () => ({ image: { mimeType: "image/png", base64: "iVBORw0KGgo=" } }),
      newKey: async () => randomUUID(),
    } as unknown as ApiClient;
    const pending = readCaptureImage(client, randomUUID());
    const rejected = expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    pruneLocalAccountFiles(newOwner);
    Object.assign(client, { userId: newOwner });
    native.finishWrite();
    await rejected;
    expect([...native.files.keys()]).toEqual([draft]);
  });

  it("fences a late image write from a separate page bundle", async () => {
    const native = localFiles();
    const loadBundle = async (entry: string) => {
      const result = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: "cjs",
        platform: "browser",
        target: "es2020",
        define: { "process.env.NODE_ENV": '"production"' },
      });
      const module = { exports: {} as Record<string, (...args: any[]) => any> };
      const context = createContext({ module, exports: module.exports, wx: native.wx, console });
      runInContext(result.outputFiles[0]!.text, context);
      return module.exports;
    };
    // These are two independently bundled copies of capture-image.ts.
    const app = await loadBundle("apps/miniprogram/src/lib/local-retention.ts");
    const page = await loadBundle("apps/miniprogram/src/lib/capture-image.ts");
    const client = {
      userId: randomUUID(),
      request: async () => ({ image: { mimeType: "image/png", base64: "iVBORw0KGgo=" } }),
      newKey: async () => randomUUID(),
    };
    const pending = page.readCaptureImage(client, randomUUID());
    const rejected = expect(pending).rejects.toMatchObject({ code: "IMAGE_CACHE_CLEARED" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    app.pruneLocalAccountFiles(randomUUID());
    native.finishWrite();
    await rejected;
    expect(native.files.size).toBe(0);
  });
});
