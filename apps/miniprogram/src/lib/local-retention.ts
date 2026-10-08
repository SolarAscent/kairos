import { clearCaptureImageCache } from "./capture-image";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const imageFile = new RegExp(`^kairos-image-${uuid}\\.(?:png|jpg)$`, "i");
const avatarFile = new RegExp(`^kairos-avatar-(${uuid})-(${uuid})\\.(?:png|jpg)$`, "i");
const exportFile = new RegExp(`^kairos-records-${uuid}\\.txt$`, "i");

/** Remove only files written by Kairos, while retaining the active account's avatar. */
export function pruneLocalAccountFiles(owner: string | null) {
  // Invalidate reads in other page bundles before unlinking on account changes.
  // At startup image filenames have no owner and cannot
  // safely be attributed to the restored account after a crash or partial logout.
  try {
    clearCaptureImageCache();
  } catch {
    /* A later file scan can still clear files if storage is unavailable. */
  }
  try {
    const root = wx.env.USER_DATA_PATH;
    const fs = wx.getFileSystemManager();
    for (const file of fs.readdirSync(root)) {
      const path = `${root}/${file}`;
      const avatar = avatarFile.exec(file);
      const remove =
        imageFile.test(file) ||
        exportFile.test(file) ||
        Boolean(avatar && avatar[1]!.toLowerCase() !== owner?.toLowerCase());
      if (!remove) continue;
      try {
        fs.unlinkSync(path);
      } catch {
        /* File may be in use or already removed by another page. */
      }
    }
  } catch {
    /* Native storage may be unavailable; server-side retention still runs. */
  }
}

/** After a profile read, retain only the avatar version actually owned by the account. */
export function pruneStoredAvatarVersions(owner: string, version: string | null) {
  try {
    const root = wx.env.USER_DATA_PATH;
    const fs = wx.getFileSystemManager();
    for (const file of fs.readdirSync(root)) {
      const match = avatarFile.exec(file);
      if (!match || match[1]!.toLowerCase() !== owner.toLowerCase()) continue;
      if (version && match[2]!.toLowerCase() === version.toLowerCase()) continue;
      try {
        fs.unlinkSync(`${root}/${file}`);
      } catch {
        /* A stale file may already be absent. */
      }
    }
  } catch {
    /* A failed local cleanup does not invalidate the server profile. */
  }
}
