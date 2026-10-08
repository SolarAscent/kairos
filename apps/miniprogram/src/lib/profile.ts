import "./zod-runtime";
import {
  avatarInputSchema,
  MAX_AVATAR_BYTES,
  userAvatarSchema,
  userProfileSchema,
  type AvatarInput,
  type UpdateProfileRequest,
  type UserProfile,
} from "@life/contracts";
import { ApiClient, ClientError } from "./client";

export const DEFAULT_NICKNAME = "KAIROS 用户";

export async function readChosenAvatar(path: string): Promise<AvatarInput> {
  const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>(
    (resolve, reject) => {
      wx.getImageInfo({
        src: path,
        success: resolve,
        fail: () => reject(new ClientError("AVATAR_READ_FAILED")),
      });
    },
  );
  const scale = Math.min(1, 512 / Math.max(info.width, info.height));
  const compressed = await new Promise<string>((resolve, reject) => {
    wx.compressImage({
      src: path,
      quality: 75,
      compressedWidth: Math.max(1, Math.round(info.width * scale)),
      compressedHeight: Math.max(1, Math.round(info.height * scale)),
      success: (result) => resolve(result.tempFilePath),
      fail: () => reject(new ClientError("AVATAR_READ_FAILED")),
    });
  });
  const base64 = await new Promise<string>((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: compressed,
      encoding: "base64",
      success: ({ data }) =>
        typeof data === "string" ? resolve(data) : reject(new ClientError("AVATAR_READ_FAILED")),
      fail: () => reject(new ClientError("AVATAR_READ_FAILED")),
    });
  });
  const bytes =
    (base64.length / 4) * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (bytes > MAX_AVATAR_BYTES) throw new ClientError("AVATAR_TOO_LARGE");
  const mimeType = base64.startsWith("/9j/")
    ? "image/jpeg"
    : base64.startsWith("iVBORw0KGgo")
      ? "image/png"
      : null;
  const parsed = avatarInputSchema.safeParse({ mimeType, base64 });
  if (!parsed.success) throw new ClientError("AVATAR_FORMAT_OR_SIZE_INVALID");
  return parsed.data;
}

export class ProfileClient {
  private generation = 0;
  private flight: Promise<UserProfile> | null = null;
  private profile: UserProfile | null = null;
  avatarPath = "";
  avatarError = "";
  constructor(
    private readonly client: ApiClient,
    private readonly onChange: (profile: UserProfile | null, path: string) => void,
  ) {}

  private removeFile(path: string) {
    if (!path) return;
    try {
      wx.getFileSystemManager().unlinkSync(path);
    } catch {
      /* Already removed or storage unavailable. */
    }
  }
  clear() {
    this.generation++;
    this.flight = null;
    this.profile = null;
    this.removeFile(this.avatarPath);
    this.avatarPath = this.avatarError = "";
    this.onChange(null, "");
  }
  private assertOwner(owner: string, generation: number) {
    if (owner !== this.client.userId || generation !== this.generation)
      throw new ClientError("SESSION_CHANGED");
  }
  private apply(profile: UserProfile) {
    if (profile.avatarVersion !== this.profile?.avatarVersion) {
      this.removeFile(this.avatarPath);
      this.avatarPath = "";
    }
    this.profile = profile;
    this.avatarError = "";
    this.onChange(profile, this.avatarPath);
  }
  private writeAvatar(profile: UserProfile, image: AvatarInput) {
    const extension = image.mimeType === "image/png" ? "png" : "jpg";
    const path = `${wx.env.USER_DATA_PATH}/kairos-avatar-${profile.userId}-${profile.avatarVersion}.${extension}`;
    try {
      wx.getFileSystemManager().writeFileSync(path, image.base64, "base64");
    } catch {
      throw new ClientError("AVATAR_STORAGE_UNAVAILABLE");
    }
    if (path !== this.avatarPath) this.removeFile(this.avatarPath);
    this.avatarPath = path;
    this.onChange(profile, path);
  }
  load(force = false): Promise<UserProfile> {
    if (this.flight) return this.flight;
    const owner = this.client.userId;
    if (!owner) return Promise.reject(new ClientError("LOGIN_REQUIRED"));
    if (!force && this.profile?.userId === owner && !this.avatarError)
      return Promise.resolve(this.profile);
    const generation = this.generation;
    const flight = (async () => {
      const profile = await this.client.request("/v1/users/me", userProfileSchema);
      this.assertOwner(owner, generation);
      if (profile.userId !== owner) throw new ClientError("RESPONSE_INVALID");
      this.apply(profile);
      if (profile.avatarVersion && !this.avatarPath) {
        try {
          const avatar = await this.client.request("/v1/users/me/avatar", userAvatarSchema);
          this.assertOwner(owner, generation);
          if (avatar.avatarVersion !== profile.avatarVersion || !avatar.image)
            throw new ClientError("AVATAR_CHANGED");
          this.writeAvatar(profile, avatar.image);
        } catch (error) {
          this.assertOwner(owner, generation);
          this.avatarError = error instanceof ClientError ? error.code : "AVATAR_READ_FAILED";
        }
      }
      return profile;
    })().finally(() => {
      if (this.flight === flight) this.flight = null;
    });
    this.flight = flight;
    return flight;
  }
  async save(input: UpdateProfileRequest, key: string): Promise<UserProfile> {
    const owner = this.client.userId;
    const generation = ++this.generation;
    this.flight = null;
    if (!owner) throw new ClientError("LOGIN_REQUIRED");
    const profile = await this.client.request("/v1/users/me/profile", userProfileSchema, {
      method: "POST",
      data: input,
      key,
    });
    this.assertOwner(owner, generation);
    if (profile.userId !== owner) throw new ClientError("RESPONSE_INVALID");
    this.apply(profile);
    if (input.avatar && profile.avatarVersion) {
      try {
        this.writeAvatar(profile, input.avatar);
      } catch {
        this.avatarError = "AVATAR_STORAGE_UNAVAILABLE";
      }
    }
    return profile;
  }
}
