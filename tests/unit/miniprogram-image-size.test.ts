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
