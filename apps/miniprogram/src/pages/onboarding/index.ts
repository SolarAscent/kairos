import "../../lib/zod-runtime";
import { reaction } from "mobx-miniprogram";
import type { AppServices } from "../../lib/session";
import { getUserSettings, patchUserSettings, type UserSettings } from "../../lib/settings";
import { userMessage } from "../../lib/errors";

const { client, sessionStore } = getApp<{ globalData: AppServices }>().globalData;
type Settings = UserSettings;
type Draft = {
  relaxation: Settings["recommendation"]["relaxation"];
  defaultMinutes: Settings["recommendation"]["defaultMinutes"];
  defaultBudget: number | null;
  goingOut: Settings["recommendation"]["goingOut"];
  useLocation: boolean;
  homeRegion: string;
};
const initial: Draft = {
  relaxation: "ANY",
  defaultMinutes: 30,
  defaultBudget: null,
  goingOut: "UNKNOWN",
  useLocation: false,
  homeRegion: "",
};
function fromSettings(value: Settings): Draft {
  return {
    relaxation: value.recommendation.relaxation,
    defaultMinutes: value.recommendation.defaultMinutes,
    defaultBudget: value.recommendation.defaultBudget,
    goingOut: value.recommendation.goingOut,
    useLocation: value.privacy.useLocation,
    homeRegion: value.recommendation.homeRegion,
  };
}
function createRuntime() {
  return {
    owner: client.userId,
    generation: 0,
    unloaded: false,
    hidden: false,
    identityDispose: undefined as (() => void) | undefined,
    loaded: false,
    loading: false,
    pendingWrite: null as { signature: string; key: string } | null,
  };
}
function createData() {
  return {
    step: 0,
    loaded: false,
    loading: false,
    topInset: 92,
    bottomInset: 24,
    busy: false,
    error: "",
    relaxation: initial.relaxation,
    defaultMinutes: initial.defaultMinutes,
    defaultBudget: initial.defaultBudget,
    goingOut: initial.goingOut,
    useLocation: initial.useLocation,
    homeRegion: initial.homeRegion,
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
    if (!this.runtime.loaded && !this.runtime.loading) void this.loadDraft();
  },
  onHide() {
    const state = this.runtime;
    state.hidden = true;
    state.generation++;
    state.loading = false;
    this.updateData({ loading: false, busy: false });
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
    if (!hidden) void this.loadDraft();
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
  async loadDraft() {
    const state = this.runtime;
    const generation = ++state.generation;
    const owner = client.userId;
    state.loading = true;
    try {
      const result = await getUserSettings(client);
      if (!this.isCurrent(state, generation, owner)) return;
      this.updateData(fromSettings(result));
      state.loaded = true;
      this.updateData({ loaded: true, error: "" });
    } catch (error) {
      if (this.isCurrent(state, generation, owner)) this.updateData({ error: userMessage(error) });
    } finally {
      if (state.generation === generation) {
        state.loading = false;
        if (this.isCurrent(state, generation, owner)) this.updateData({ loading: false });
      }
    }
  },
  select(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const field = String(event.currentTarget.dataset.field);
    const value = event.currentTarget.dataset.value;
    if (field === "relaxation") this.updateData({ relaxation: value as Draft["relaxation"] });
    else if (field === "defaultMinutes")
      this.updateData({ defaultMinutes: Number(value) as Draft["defaultMinutes"] });
    else if (field === "defaultBudget")
      this.updateData({ defaultBudget: value === "null" ? null : Number(value) });
    else if (field === "goingOut") this.updateData({ goingOut: value as Draft["goingOut"] });
    else if (field === "useLocation") this.updateData({ useLocation: value === "true" });
    this.updateData({ error: "" });
  },
  editRegion(event: WechatMiniprogram.Input) {
    if (this.data.busy) return;
    this.updateData({ homeRegion: event.detail.value });
  },
  next() {
    if (this.data.busy || !this.runtime.loaded) return;
    if (this.data.step < 2) this.updateData({ step: this.data.step + 1, error: "" });
    else void this.finish();
  },
  previous() {
    if (this.data.busy) return;
    if (this.data.step > 0) this.updateData({ step: this.data.step - 1, error: "" });
  },
  skip() {
    if (this.data.busy) return;
    wx.redirectTo({ url: "/pages/home/index" });
  },
  async finish() {
    const state = this.runtime;
    const generation = state.generation;
    const owner = state.owner;
    if (this.data.busy || !state.loaded) return;
    const payload = {
      recommendation: {
        relaxation: this.data.relaxation,
        defaultMinutes: this.data.defaultMinutes,
        defaultBudget: this.data.defaultBudget,
        goingOut: this.data.goingOut,
        homeRegion: this.data.homeRegion.trim(),
      },
      privacy: { useLocation: this.data.useLocation },
      onboardingCompleted: true,
    };
    const signature = JSON.stringify(payload);
    this.updateData({ busy: true, error: "" });
    try {
      if (!state.pendingWrite || state.pendingWrite.signature !== signature)
        state.pendingWrite = { signature, key: await client.newKey() };
      if (!this.isCurrent(state, generation, owner)) return;
      await patchUserSettings(client, payload, state.pendingWrite.key);
      if (!this.isCurrent(state, generation, owner)) return;
      state.pendingWrite = null;
      wx.redirectTo({ url: "/pages/home/index" });
    } catch (error) {
      if (this.isCurrent(state, generation, owner)) this.updateData({ error: userMessage(error) });
    } finally {
      if (this.isCurrent(state, generation, owner)) this.updateData({ busy: false });
    }
  },
});
