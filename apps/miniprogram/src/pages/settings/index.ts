import "../../lib/zod-runtime";
import { reaction } from "mobx-miniprogram";
import { uiCapabilitiesResponseSchema } from "@life/contracts";
import type { AppServices } from "../../lib/session";
import { getUserSettings, patchUserSettings, type UserSettings } from "../../lib/settings";
import { userMessage } from "../../lib/errors";
import { getAppearance, setReduceMotion } from "../../lib/appearance";
import { clearCaptureImageCache } from "../../lib/capture-image";
import { exportRecordText } from "../../lib/record-export";

const { client, sessionStore } = getApp<{ globalData: AppServices }>().globalData;
type Settings = UserSettings;
type Draft = {
  relaxation: Settings["recommendation"]["relaxation"];
  defaultMinutes: Settings["recommendation"]["defaultMinutes"];
  defaultBudget: number | null;
  goingOut: Settings["recommendation"]["goingOut"];
  useLocation: boolean;
  notificationsEnabled: boolean;
  homeRegion: string;
  frequentAreas: string[];
};
const defaults: Draft = {
  relaxation: "ANY",
  defaultMinutes: 30,
  defaultBudget: null,
  goingOut: "UNKNOWN",
  useLocation: false,
  notificationsEnabled: false,
  homeRegion: "",
  frequentAreas: [],
};
function toDraft(value: Settings): Draft {
  return {
    relaxation: value.recommendation.relaxation,
    defaultMinutes: value.recommendation.defaultMinutes,
    defaultBudget: value.recommendation.defaultBudget,
    goingOut: value.recommendation.goingOut,
    useLocation: value.privacy.useLocation,
    notificationsEnabled: value.notifications.enabled,
    homeRegion: value.recommendation.homeRegion,
    frequentAreas: value.recommendation.frequentAreas,
  };
}
function equalDraft(a: Draft, b: Draft) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function createRuntime() {
  return {
    owner: client.userId,
    generation: 0,
    unloaded: false,
    hidden: false,
    shareInProgress: false,
    identityDispose: undefined as (() => void) | undefined,
    saved: null as Draft | null,
    pendingWrite: null as { signature: string; key: string } | null,
  };
}
function labels(value: Draft) {
  const relaxationLabel = {
    QUIET: "安静待一会儿",
    EXPLORE: "出门看看新鲜事",
    SOCIAL: "和朋友一起",
    ANY: "看当下心情",
  }[value.relaxation];
  const minutesLabel =
    value.defaultMinutes === 15
      ? "15 分钟"
      : value.defaultMinutes === 30
        ? "半小时"
        : value.defaultMinutes === 60
          ? "1 小时"
          : "2 小时";
  const budgetLabel =
    value.defaultBudget == null ? "不设预算" : `人均 ${value.defaultBudget} 元以内`;
  const goingOutLabel =
    value.goingOut === "YES" ? "愿意出门" : value.goingOut === "NO" ? "想留在家" : "每次再决定";
  return {
    relaxationLabel,
    minutesLabel,
    budgetLabel,
    goingOutLabel,
    frequentAreasLabel: value.frequentAreas.length ? value.frequentAreas.join("、") : "尚未填写",
  };
}
function createData() {
  return {
    topInset: 92,
    bottomInset: 24,
    loaded: false,
    busy: false,
    dirty: false,
    error: "",
    status: "",
    relaxation: defaults.relaxation,
    defaultMinutes: defaults.defaultMinutes,
    defaultBudget: defaults.defaultBudget,
    goingOut: defaults.goingOut,
    useLocation: defaults.useLocation,
    notificationsEnabled: defaults.notificationsEnabled,
    homeRegion: defaults.homeRegion,
    frequentAreas: defaults.frequentAreas,
    relaxationLabel: "看当下心情",
    minutesLabel: "半小时",
    budgetLabel: "不设预算",
    goingOutLabel: "每次再决定",
    frequentAreasLabel: "尚未填写",
    reduceMotion: false,
    sheetField: "",
    sheetTitle: "",
    homeRegionDraft: "",
    frequentAreasDraft: "",
    cacheBusy: false,
    exportBusy: false,
    exportStatus: "导出原始记录为文本",
    permissionSummary: "按需请求",
  };
}
Page({
  data: createData(),
  runtime: null as unknown as ReturnType<typeof createRuntime>,
  updateData(values: Partial<ReturnType<typeof createData>>) {
    if (!this.runtime.unloaded) this.setData(values);
  },
  onLoad() {
    this.runtime = createRuntime();
    this.observeIdentity();
    const info = wx.getWindowInfo();
    this.updateData({
      topInset: Math.max(
        wx.getMenuButtonBoundingClientRect().bottom + 16,
        info.statusBarHeight + 44,
      ),
      bottomInset: Math.max(16, info.screenHeight - (info.safeArea?.bottom ?? info.screenHeight)),
    });
  },
  onShow() {
    this.runtime.hidden = false;
    if (this.runtime.owner !== client.userId) {
      this.resetForOwner();
      return;
    }
    if (!client.userId) {
      this.updateData({
        ...createData(),
        topInset: this.data.topInset,
        bottomInset: this.data.bottomInset,
      });
      wx.reLaunch({ url: "/pages/home/index" });
      return;
    }
    if (!this.data.loaded && !this.data.busy) void this.load();
  },
  onHide() {
    const state = this.runtime;
    // WeChat may hide the page while its native share chooser is open.
    if (state.shareInProgress) return;
    state.hidden = true;
    state.generation++;
    this.updateData({ busy: false, exportBusy: false });
  },
  onUnload() {
    this.runtime.identityDispose?.();
    this.runtime.unloaded = true;
    this.runtime.generation++;
  },
  observeIdentity() {
    const state = this.runtime;
    state.identityDispose = reaction(
      () => sessionStore.userId,
      () => {
        if (this.runtime === state && !state.unloaded) this.resetForOwner();
      },
    );
  },
  isCurrent(state: ReturnType<typeof createRuntime>, generation: number, owner: string | null) {
    return (
      !state.unloaded &&
      !state.hidden &&
      this.runtime === state &&
      state.generation === generation &&
      state.owner === owner &&
      client.userId === owner
    );
  },
  resetForOwner() {
    const previous = this.runtime;
    const hidden = previous.hidden;
    previous.identityDispose?.();
    previous.unloaded = true;
    previous.generation++;
    this.runtime = createRuntime();
    this.runtime.hidden = hidden;
    this.observeIdentity();
    this.updateData({
      ...createData(),
      topInset: this.data.topInset,
      bottomInset: this.data.bottomInset,
    });
    if (!client.userId) {
      this.updateData({ error: "登录状态已失效，请重新登录。" });
      if (!hidden) wx.reLaunch({ url: "/pages/home/index" });
      return;
    }
    if (!hidden) void this.load();
  },
  draft(): Draft {
    return {
      relaxation: this.data.relaxation,
      defaultMinutes: this.data.defaultMinutes,
      defaultBudget: this.data.defaultBudget,
      goingOut: this.data.goingOut,
      useLocation: this.data.useLocation,
      notificationsEnabled: this.data.notificationsEnabled,
      homeRegion: this.data.homeRegion,
      frequentAreas: this.data.frequentAreas,
    };
  },
  async load() {
    const state = this.runtime;
    const generation = ++state.generation;
    const owner = client.userId;
    this.updateData({ busy: true, error: "", status: "" });
    try {
      const result = await getUserSettings(client);
      if (!this.isCurrent(state, generation, owner)) return;
      const saved = toDraft(result);
      state.saved = saved;
      this.updateData({
        ...saved,
        ...labels(saved),
        ...getAppearance(client),
        loaded: true,
        dirty: false,
      });
      try {
        const capabilities = await client.request(
          "/v1/ui-capabilities",
          uiCapabilitiesResponseSchema,
        );
        if (this.isCurrent(state, generation, owner))
          this.updateData({
            exportStatus: capabilities.recordExport.available
              ? "导出全部原始记录为文本"
              : "导出功能暂不可用",
          });
      } catch {
        /* Capability lookup is informational; preserve the settings page if it is unavailable. */
      }
    } catch (error) {
      if (this.isCurrent(state, generation, owner)) this.updateData({ error: userMessage(error) });
    } finally {
      if (this.isCurrent(state, generation, owner)) this.updateData({ busy: false });
    }
  },
  change(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const field = String(event.currentTarget.dataset.field) as keyof Draft;
    const value = event.currentTarget.dataset.value;
    this.applyChange(field, value);
  },
  applyChange(field: keyof Draft, value: unknown) {
    if (this.data.busy) return;
    const changes: Partial<Draft> = {};
    if (field === "relaxation") changes.relaxation = value as Draft["relaxation"];
    else if (field === "defaultMinutes")
      changes.defaultMinutes = Number(value) as Draft["defaultMinutes"];
    else if (field === "defaultBudget")
      changes.defaultBudget = value === "null" ? null : Number(value);
    else if (field === "goingOut") changes.goingOut = value as Draft["goingOut"];
    else if (field === "useLocation") changes.useLocation = value === true || value === "true";
    else if (field === "notificationsEnabled")
      changes.notificationsEnabled = value === true || value === "true";
    else if (field === "homeRegion") changes.homeRegion = String(value ?? "");
    else if (field === "frequentAreas") changes.frequentAreas = value as string[];
    const next = { ...this.draft(), ...changes };
    const dirty = !this.runtime.saved || !equalDraft(next, this.runtime.saved);
    this.updateData({ ...changes, ...labels(next), dirty, error: "", status: "" });
  },
  openSheet(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const field = String(event.currentTarget.dataset.field);
    const title =
      (
        {
          relaxation: "放松方式",
          defaultMinutes: "行动时间偏好",
          defaultBudget: "出门预算",
          goingOut: "出门意愿",
          homeRegion: "常住区域",
          frequentAreas: "常去片区",
        } as Record<string, string>
      )[field] ?? "生活偏好";
    this.updateData({
      sheetField: field,
      sheetTitle: title,
      homeRegionDraft: this.data.homeRegion,
      frequentAreasDraft: this.data.frequentAreas.join("\n"),
    });
  },
  closeSheet() {
    this.updateData({ sheetField: "" });
  },
  noop() {},
  chooseOption(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const field = String(event.currentTarget.dataset.field) as keyof Draft;
    const value = event.currentTarget.dataset.value;
    this.applyChange(field, value);
  },
  editHomeRegion(event: WechatMiniprogram.TextareaInput) {
    if (this.data.busy) return;
    this.updateData({ homeRegionDraft: event.detail.value });
  },
  editFrequentAreas(event: WechatMiniprogram.TextareaInput) {
    if (this.data.busy) return;
    this.updateData({ frequentAreasDraft: event.detail.value });
  },
  applyHomeRegion() {
    if (this.data.busy) return;
    this.applyChange("homeRegion", this.data.homeRegionDraft.trim());
    this.closeSheet();
  },
  applyFrequentAreas() {
    if (this.data.busy) return;
    const frequentAreas = [
      ...new Set(
        this.data.frequentAreasDraft
          .split(/[\n,，、]/u)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
    if (frequentAreas.length > 8 || frequentAreas.some((item) => item.length > 120)) {
      this.updateData({ error: "最多填写 8 个片区，每个名称不超过 120 字。" });
      return;
    }
    this.applyChange("frequentAreas", frequentAreas);
    this.closeSheet();
  },
  toggleMotion(event: WechatMiniprogram.SwitchChange) {
    const value = Boolean(event.detail.value);
    if (!setReduceMotion(client, value)) {
      this.updateData({ status: "此设备暂时无法保存外观设定" });
      return;
    }
    this.updateData({ reduceMotion: value, status: "外观设定已保存在本机" });
  },
  togglePreference(event: WechatMiniprogram.SwitchChange) {
    const field = String(event.currentTarget.dataset.field) as
      "useLocation" | "notificationsEnabled";
    this.applyChange(field, event.detail.value);
  },
  openPermissions() {
    const owner = client.userId;
    wx.openSetting({
      success: (result) => {
        if (client.userId !== owner) return;
        const auth = result.authSetting;
        const location = auth["scope.userLocation"] ? "位置已允许" : "位置未允许";
        const microphone = auth["scope.record"] ? "麦克风已允许" : "麦克风未允许";
        this.updateData({ status: `${location} · ${microphone}` });
      },
      fail: () => {
        if (client.userId === owner) this.updateData({ status: "请在微信设置中查看权限" });
      },
    });
  },
  async clearCache() {
    if (this.data.cacheBusy) return;
    this.updateData({ cacheBusy: true, status: "", error: "" });
    try {
      await clearCaptureImageCache();
      this.updateData({ status: "本机图片缓存已清除" });
    } catch (error) {
      this.updateData({ error: userMessage(error) });
    } finally {
      this.updateData({ cacheBusy: false });
    }
  },
  async exportRecords() {
    if (this.data.exportBusy) return;
    const state = this.runtime;
    const generation = state.generation;
    const owner = state.owner;
    this.updateData({ exportBusy: true, status: "", error: "" });
    try {
      const file = await exportRecordText(client, () => this.isCurrent(state, generation, owner));
      if (!this.isCurrent(state, generation, owner)) {
        file.dispose();
        return;
      }
      try {
        state.shareInProgress = true;
        await wx.shareFileMessage({ filePath: file.filePath, fileName: "生活原始记录.txt" });
        if (this.isCurrent(state, generation, owner))
          this.updateData({ status: `已生成 ${file.count} 条原始记录文件` });
      } catch (error) {
        if (!this.isCurrent(state, generation, owner)) return;
        const message =
          typeof error === "object" &&
          error !== null &&
          "errMsg" in error &&
          typeof error.errMsg === "string"
            ? error.errMsg.toLowerCase()
            : "";
        if (message.includes("cancel")) this.updateData({ status: "文件已生成 · 已取消分享" });
        else if (wx.getDeviceInfo?.().platform === "devtools")
          this.updateData({ status: `已生成 ${file.count} 条原始记录文件，请在手机微信中分享` });
        else this.updateData({ error: userMessage(error) });
      } finally {
        state.shareInProgress = false;
        file.dispose();
      }
    } catch (error) {
      if (!this.isCurrent(state, generation, owner)) return;
      this.updateData({ error: userMessage(error) });
    } finally {
      if (this.isCurrent(state, generation, owner)) this.updateData({ exportBusy: false });
    }
  },
  async save() {
    const state = this.runtime;
    const generation = state.generation;
    const owner = state.owner;
    if (!owner || !state.saved || !this.data.dirty || this.data.busy) return;
    const draft = this.draft();
    const payload = {
      recommendation: {
        relaxation: draft.relaxation,
        defaultMinutes: draft.defaultMinutes,
        defaultBudget: draft.defaultBudget,
        goingOut: draft.goingOut,
        homeRegion: draft.homeRegion,
        frequentAreas: draft.frequentAreas,
      },
      privacy: { useLocation: draft.useLocation },
      notifications: { enabled: draft.notificationsEnabled },
    };
    const signature = JSON.stringify(payload);
    this.updateData({ busy: true, error: "", status: "" });
    try {
      if (!state.pendingWrite || state.pendingWrite.signature !== signature)
        state.pendingWrite = { signature, key: await client.newKey() };
      if (!this.isCurrent(state, generation, owner)) return;
      const result = await patchUserSettings(client, payload, state.pendingWrite.key);
      if (!this.isCurrent(state, generation, owner)) return;
      const saved = toDraft(result);
      state.saved = saved;
      state.pendingWrite = null;
      this.updateData({ ...saved, dirty: false, status: "设定已保存" });
    } catch (error) {
      if (this.isCurrent(state, generation, owner)) this.updateData({ error: userMessage(error) });
    } finally {
      if (this.isCurrent(state, generation, owner)) this.updateData({ busy: false });
    }
  },
  async signOut() {
    if (this.data.busy) return;
    this.updateData({ busy: true, error: "" });
    try {
      await client.logout();
    } catch {
      /* The local session is cleared even if revocation cannot reach the server. */
    }
    wx.reLaunch({ url: "/pages/home/index" });
  },
  back() {
    wx.navigateBack();
  },
});
