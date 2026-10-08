import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseCaptureImage } from "../../apps/miniprogram/src/lib/media";
afterEach(() => vi.unstubAllGlobals());
describe("native compressed image byte limit", () => {
  it("rejects oversized bytes even when native file metadata understates the size", async () => {
    vi.stubGlobal("wx", {
      chooseMedia: ({ success }: any) =>
        success({ tempFiles: [{ tempFilePath: "/local/photo.png", size: 8 }] }),
      getFileSystemManager: () => ({
        readFile: ({ success }: any) =>
          success({ data: "iVBORw0KGgoA" + "A".repeat(4 * 1024 * 1024) }),
      }),
    });
    await expect(chooseCaptureImage()).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
  });
});

it("compresses a large phone photograph before reading/uploading it and previews the same file", async () => {
  const reads: string[] = [],
    compression: any[] = [];
  vi.stubGlobal("wx", {
    chooseMedia: ({ success }: any) =>
      success({ tempFiles: [{ tempFilePath: "/phone/original.jpg", size: 8000000 }] }),
    getImageInfo: ({ success }: any) => success({ width: 6000, height: 4000 }),
    compressImage: (options: any) => {
      compression.push(options);
      options.success({ tempFilePath: "/phone/compressed.jpg" });
    },
    getFileSystemManager: () => ({
      readFile: (options: any) => {
        reads.push(options.filePath);
        options.success({ data: "/9j/AAAA" });
      },
    }),
  });
  const image = await chooseCaptureImage();
  expect(reads).toEqual(["/phone/compressed.jpg"]);
  expect(compression[0]).toMatchObject({
    compressedWidth: 2560,
    compressedHeight: 1707,
    quality: 85,
  });
  expect(image).toEqual({
    path: "/phone/compressed.jpg",
    mimeType: "image/jpeg",
    base64: "/9j/AAAA",
  });
});

it("reduces dimensions again if a PNG remains too large after the first native compression", async () => {
  const widths: number[] = [];
  vi.stubGlobal("wx", {
    chooseMedia: ({ success }: any) =>
      success({ tempFiles: [{ tempFilePath: "/phone/screenshot.png", size: 4000000 }] }),
    getImageInfo: ({ success }: any) => success({ width: 3000, height: 5000 }),
    compressImage: (options: any) => {
      widths.push(options.compressedWidth);
      options.success({ tempFilePath: "/phone/pass-" + widths.length + ".png" });
    },
    getFileSystemManager: () => ({
      readFile: (options: any) =>
        options.success({
          data: widths.length < 2 ? "iVBORw0KGgoA" + "A".repeat(3000000) : "iVBORw0KGgo=",
        }),
    }),
  });
  const image = await chooseCaptureImage();
  expect(widths).toEqual([1536, 1152]);
  expect(image!.path).toBe("/phone/pass-2.png");
  expect(image!.base64).toBe("iVBORw0KGgo=");
});

it("keeps cancellation separate from a compression failure", async () => {
  vi.stubGlobal("wx", {
    chooseMedia: ({ fail }: any) => fail({ errMsg: "chooseMedia:fail cancel" }),
  });
  await expect(chooseCaptureImage()).resolves.toBeNull();
  vi.stubGlobal("wx", {
    chooseMedia: ({ success }: any) =>
      success({ tempFiles: [{ tempFilePath: "/phone/photo.jpg", size: 8000000 }] }),
    getImageInfo: ({ success }: any) => success({ width: 4000, height: 3000 }),
    compressImage: ({ fail }: any) => fail({ errMsg: "compressImage:fail" }),
  });
  await expect(chooseCaptureImage()).rejects.toMatchObject({ code: "IMAGE_PROCESSING_FAILED" });
});
