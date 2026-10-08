import "../../lib/zod-runtime";
import { reaction } from "mobx-miniprogram";
import { updateProfileRequestSchema, type AvatarInput, type UserProfile } from "@life/contracts";
import { ClientError } from "../../lib/client";
import { userMessage } from "../../lib/errors";
import { DEFAULT_NICKNAME, readChosenAvatar } from "../../lib/profile";
import type { AppServices } from "../../lib/session";

const { client, profiles, sessionStore } = getApp<{ globalData: AppServices }>().globalData;
function createRuntime() {
  return {
    unloaded: false,
    redirected: false,
    owner: client.userId,
    avatarGeneration: 0,
    avatar: undefined as AvatarInput | null | undefined,
    original: null as UserProfile | null,
    pending: null as { signature: string; key: string } | null,
    identityDispose: undefined as (() => void) | undefined,
  };
}
Page({
  data: {
    topInset: 92,
    bottomInset: 24,
    loading: true,
    saving: false,
    avatarLoading: false,
    loaded: false,
    nickname: "",
    bio: "",
    displayName: DEFAULT_NICKNAME,
    avatarPath: "",
    hasAvatar: false,
    dirty: false,
    error: "",
    notice: "",
    avatarError: "",
    userId: "",
    identityLabel: "",
    identityDetail: "",
    createdDate: "",
    wechatLinked: false,
  },
  runtime: null as unknown as ReturnType<typeof createRuntime>,
  updateData(values: Partial<typeof this.data>) {
    if (!this.runtime.unloaded) this.setData(values);
  },
  current() {
    if (this.runtime.unloaded) return false;
    if (this.runtime.owner && this.runtime.owner === client.userId) return true;
    if (!this.runtime.redirected) {
      this.runtime.redirected = true;
      this.runtime.avatar = undefined;
      this.runtime.original = this.runtime.pending = null;
      this.updateData({
        nickname: "",
        bio: "",
        avatarPath: "",
        loaded: false,
        userId: "",
        displayName: DEFAULT_NICKNAME,
        identityLabel: "",
        identityDetail: "",
        createdDate: "",
        error: "",
        notice: "",
        avatarError: "",
        hasAvatar: false,
        dirty: false,
        wechatLinked: false,
      });
      wx.reLaunch({ url: "/pages/home/index" });
    }
    return false;
  },
  onLoad() {
    this.runtime = createRuntime();
    this.runtime.identityDispose = reaction(
      () => sessionStore.userId,
      () => this.current(),
    );
    const info = wx.getWindowInfo();
    const menu = wx.getMenuButtonBoundingClientRect();
    this.updateData({
      topInset: Math.max(menu.bottom + 16, info.statusBarHeight + 44),
      bottomInset: Math.max(16, info.screenHeight - (info.safeArea?.bottom ?? info.screenHeight)),
    });
  },
  onShow() {
    if (!this.current()) return;
    // The native avatar picker hides/shows the page. Keep unsaved edits intact.
    if (!this.data.loaded && !this.data.saving) void this.loadProfile();
  },
  onUnload() {
    this.runtime.unloaded = true;
    this.runtime.identityDispose?.();
    this.runtime.avatarGeneration++;
    this.runtime.avatar = undefined;
  },
  async loadProfile() {
    this.updateData({ loading: true, error: "", avatarError: "" });
    try {
      const profile = await profiles.load(true);
      if (!this.current()) return;
      this.runtime.original = profile;
      this.runtime.avatar = undefined;
      this.runtime.pending = null;
      this.updateData({
        loaded: true,
        nickname: profile.nickname ?? "",
        bio: profile.bio,
        displayName: profile.nickname || DEFAULT_NICKNAME,
        avatarPath: profiles.avatarPath,
        hasAvatar: !!profile.avatarVersion,
        dirty: false,
        userId: profile.userId,
        wechatLinked: profile.identityProvider === "WECHAT",
        identityLabel:
          profile.identityProvider === "WECHAT"
            ? "微信账号已关联"
            : profile.identityProvider === "DEVELOPMENT"
              ? "开发体验账号"
              : "当前账户",
        identityDetail:
          profile.identityProvider === "WECHAT"
            ? "用同一微信登录，可找回你的资料与生活记录。"
            : profile.identityProvider === "DEVELOPMENT"
              ? "当前为开发登录，尚未关联真实微信账号。"
              : "你的资料与生活记录保存在这个账户下。",
        createdDate: profile.createdAt.slice(0, 10).replace(/-/g, "."),
        avatarError: profiles.avatarError ? userMessage(new ClientError(profiles.avatarError)) : "",
      });
    } catch (error) {
      if (this.current()) this.updateData({ error: userMessage(error) });
    } finally {
      if (this.current()) this.updateData({ loading: false });
    }
  },
  updateDirty() {
    const original = this.runtime.original;
    const dirty =
      !!original &&
      (this.data.nickname.trim() !== (original.nickname ?? "") ||
        this.data.bio.trim() !== original.bio ||
        this.runtime.avatar !== undefined);
    this.updateData({
      dirty,
      displayName: this.data.nickname.trim() || DEFAULT_NICKNAME,
      notice: "",
      error: "",
    });
  },
  editNickname(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.saving) return;
    this.updateData({ nickname: event.detail.value });
    this.updateDirty();
  },
  editBio(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.saving) return;
    this.updateData({ bio: event.detail.value });
    this.updateDirty();
  },
  async chooseAvatar(event: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    if (this.data.saving || !this.data.loaded || !event.detail.avatarUrl) return;
    const generation = ++this.runtime.avatarGeneration;
    this.updateData({ avatarLoading: true, error: "" });
    try {
      const image = await readChosenAvatar(event.detail.avatarUrl);
      if (!this.current() || generation !== this.runtime.avatarGeneration) return;
      this.runtime.avatar = image;
      this.updateData({ avatarPath: event.detail.avatarUrl, hasAvatar: true, avatarError: "" });
      this.updateDirty();
    } catch (error) {
      if (this.current() && generation === this.runtime.avatarGeneration)
        this.updateData({ error: userMessage(error) });
    } finally {
      if (this.current() && generation === this.runtime.avatarGeneration)
        this.updateData({ avatarLoading: false });
    }
  },
  removeAvatar() {
    if (this.data.saving || this.data.avatarLoading) return;
    this.runtime.avatar = null;
    this.updateData({ avatarPath: "", hasAvatar: false, avatarError: "" });
    this.updateDirty();
  },
  avatarFailed() {
    this.updateData({ avatarError: "头像暂时未显示，可以重新选择头像。" });
  },
  async saveProfile() {
    if (this.data.saving || this.data.avatarLoading || !this.data.loaded || !this.data.dirty)
      return;
    const parsed = updateProfileRequestSchema.safeParse({
      nickname: this.data.nickname.trim() || null,
      bio: this.data.bio,
      ...(this.runtime.avatar === undefined ? {} : { avatar: this.runtime.avatar }),
    });
    if (!parsed.success) {
      this.updateData({ error: "昵称最多 32 个字符，个人简介最多 160 个字符。" });
      return;
    }
    this.updateData({ saving: true, error: "", notice: "" });
    try {
      const signature = JSON.stringify(parsed.data);
      if (this.runtime.pending?.signature !== signature)
        this.runtime.pending = { signature, key: await client.newKey() };
      if (!this.current()) return;
      const profile = await profiles.save(parsed.data, this.runtime.pending.key);
      if (!this.current()) return;
      this.runtime.original = profile;
      this.runtime.avatar = undefined;
      this.runtime.pending = null;
      this.updateData({
        nickname: profile.nickname ?? "",
        displayName: profile.nickname || DEFAULT_NICKNAME,
        bio: profile.bio,
        avatarPath: profiles.avatarPath,
        hasAvatar: !!profile.avatarVersion,
        dirty: false,
        notice: "个人资料已保存",
        avatarError: profiles.avatarError ? userMessage(new ClientError(profiles.avatarError)) : "",
      });
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (error) {
      if (this.current()) this.updateData({ error: userMessage(error) });
    } finally {
      if (this.current()) this.updateData({ saving: false });
    }
  },
  goBack() {
    if (this.data.saving || this.data.avatarLoading) return;
    const back = () => {
      if (getCurrentPages().length > 1) wx.navigateBack();
      else wx.reLaunch({ url: "/pages/home/index" });
    };
    if (this.data.dirty)
      wx.showModal({
        title: "还有未保存的修改",
        content: "离开后，这次修改不会保存。",
        confirmText: "放弃修改",
        cancelText: "继续编辑",
        success: ({ confirm }) => {
          if (confirm) back();
        },
      });
    else back();
  },
  copyAccountId() {
    wx.setClipboardData({ data: this.data.userId });
  },
  signOut() {
    if (this.data.saving || this.data.avatarLoading) return;
    wx.showModal({
      title: "退出当前账号？",
      content: this.data.dirty
        ? "未保存的修改会放弃，已保存的资料与生活记录仍保留。"
        : "已保存的资料与生活记录仍保留，重新登录后可继续使用。",
      confirmText: "退出登录",
      success: ({ confirm }) => {
        if (confirm) void this.performSignOut();
      },
    });
  },
  async performSignOut() {
    this.updateData({ saving: true });
    let remoteFailed = false;
    try {
      await client.logout();
    } catch {
      remoteFailed = true;
    }
    this.runtime.avatar = undefined;
    wx.reLaunch({
      url: "/pages/home/index",
      success: () => {
        if (remoteFailed) wx.showToast({ title: "已退出本机，请稍后检查网络", icon: "none" });
      },
    });
  },
});
