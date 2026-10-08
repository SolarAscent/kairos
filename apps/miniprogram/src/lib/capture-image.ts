import "./zod-runtime";
import { captureImageResponseSchema } from "@life/contracts";
import { ClientError, type ApiClient } from "./client";

// Page bundles each have their own JS modules. Native storage shares this epoch
// between settings, home and detail without retaining any image bytes or account data.
const imageCacheEpochKey = "kairos:capture-image-cache:epoch";
export function getCaptureImageCacheEpoch() {
  const value = wx.getStorageSync(imageCacheEpochKey);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
export function isCaptureImageCachePath(path: string) {
  return /^kairos-image-[0-9a-f-]{36}\.(png|jpg)$/i.test(path.split("/").pop() ?? "");
}

/** Read an owned source image into a disposable native file, never a remote URL. */
export async function readCaptureImage(client: ApiClient, id: string) {
  const owner = client.userId;
  const cacheEpoch = getCaptureImageCacheEpoch();
  const assertCurrent = () => {
    if (client.userId !== owner) throw new ClientError("SESSION_CHANGED");
    if (getCaptureImageCacheEpoch() !== cacheEpoch) throw new ClientError("IMAGE_CACHE_CLEARED");
  };
  const result = await client.request(`/v1/captures/${id}/image`, captureImageResponseSchema);
  assertCurrent();
  if (!result.image) return null;
  const fileId = await client.newKey();
  assertCurrent();
  const path = `${wx.env.USER_DATA_PATH}/kairos-image-${fileId}.${result.image.mimeType === "image/png" ? "png" : "jpg"}`;
  const fs = wx.getFileSystemManager();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    fs.unlink({ filePath: path, fail() {} });
  };
  try {
    await new Promise<void>((resolve, reject) =>
      fs.writeFile({
        filePath: path,
        data: result.image!.base64,
        encoding: "base64",
        success: () => resolve(),
        fail: reject,
      }),
    );
    assertCurrent();
  } catch (error) {
    dispose();
    throw error;
  }
  return { path, dispose, cacheEpoch };
}

export function clearCaptureImageCache() {
  // Invalidate pending reads before touching files. A late write disposes itself
  // after observing the changed epoch, even if it completed after readdir.
  wx.setStorageSync(imageCacheEpochKey, getCaptureImageCacheEpoch() + 1);
  const fs = wx.getFileSystemManager();
  const files = fs.readdirSync(wx.env.USER_DATA_PATH);
  let cleared = 0;
  for (const file of files) {
    if (!/^kairos-image-[0-9a-f-]{36}\.(png|jpg)$/i.test(file)) continue;
    try {
      fs.unlinkSync(`${wx.env.USER_DATA_PATH}/${file}`);
      cleared++;
    } catch {
      /* In-use or already released files may be absent. */
    }
  }
  return cleared;
}
