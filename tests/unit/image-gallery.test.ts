import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ImageGallery } from "../../apps/miniprogram/src/lib/image-gallery";
import type { ApiClient } from "../../apps/miniprogram/src/lib/client";
const image = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
afterEach(() => vi.unstubAllGlobals());
function files() {
  const saved = new Set<string>();
  const values = new Map<string, unknown>();
  vi.stubGlobal("wx", {
    env: { USER_DATA_PATH: "/native" },
    getStorageSync: (key: string) => values.get(key),
    getFileSystemManager: () => ({
      writeFile: ({ filePath, success }: any) => {
        saved.add(filePath);
        success();
      },
      unlink: ({ filePath }: any) => saved.delete(filePath),
    }),
  });
  return { saved, values };
}
it("loads all covers across a long list with at most three concurrent requests and deduplicates sources", async () => {
  const native = files();
  let active = 0,
    peak = 0,
    calls = 0;
  const client = {
    userId: randomUUID(),
    newKey: async () => randomUUID(),
    request: async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { image };
    },
  } as unknown as ApiClient;
  const gallery = new ImageGallery(client),
    ids = Array.from({ length: 55 }, () => randomUUID()),
    applied: string[] = [];
  await gallery.load([...ids, ids[0]!], (id) => applied.push(id));
  expect(applied).toEqual(expect.arrayContaining(ids));
  expect(calls).toBe(55);
  expect(peak).toBe(3);
  await gallery.load(ids, () => {});
  expect(calls).toBe(55);
  expect(native.saved.size).toBe(55);
  gallery.clear();
  expect(native.saved.size).toBe(0);
});
it("does not resurrect a pending photo after account switch or cache clearing", async () => {
  const native = files();
  let complete!: (value: unknown) => void;
  const client = {
    userId: randomUUID(),
    newKey: async () => randomUUID(),
    request: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  } as unknown as ApiClient;
  const gallery = new ImageGallery(client);
  const applied = vi.fn();
  const loading = gallery.load([randomUUID()], applied);
  client.userId = randomUUID();
  gallery.clear();
  complete({ image });
  await loading;
  expect(applied).not.toHaveBeenCalled();
  expect(native.saved.size).toBe(0);
});
it("retries a failed image on refresh without discarding the other readable covers", async () => {
  files();
  let calls = 0;
  const client = {
    userId: randomUUID(),
    newKey: async () => randomUUID(),
    request: async () => {
      if (++calls === 1) throw new Error("offline");
      return { image };
    },
  } as unknown as ApiClient;
  const gallery = new ImageGallery(client),
    id = randomUUID();
  const apply = vi.fn();
  await gallery.load([id], apply);
  expect(gallery.path(id)).toBe("");
  await gallery.load([id], apply);
  expect(apply).toHaveBeenCalledOnce();
  expect(gallery.path(id)).not.toBe("");
  gallery.clear();
});
