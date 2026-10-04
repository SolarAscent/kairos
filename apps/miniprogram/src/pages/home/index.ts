import "../../lib/zod-runtime";
import { createStoreBindings } from "mobx-miniprogram-bindings";
import {
  captureAcceptedSchema,
  captureListResponseSchema,
  createCaptureRequestSchema,
  createFeedbackRequestSchema,
  createNowSessionRequestSchema,
  feedbackAcceptedSchema,
  lifeListResponseSchema,
  nowResponseSchema,
  type CaptureResponse,
  type LifeListItem,
  type NowResponse,
} from "@life/contracts";
import { client, sessionStore } from "../../lib/session";
import { userMessage } from "../../lib/errors";

type Pending = { signature: string; key: string };
const statusLabels: Record<string, string> = {
  UPLOADED: "收到了",
  PROCESSING: "正在理解",
  READY: "已保留",
  NEEDS_REVIEW: "待确认",
  FAILED: "理解未完成，原文已保留",
};
function createRuntime() {
  return {
    binding: undefined as ReturnType<typeof createStoreBindings> | undefined,
    poll: undefined as ReturnType<typeof setTimeout> | undefined,
    visible: false,
    unloaded: false,
    pollCount: 0,
    capturePending: null as Pending | null,
    nowPending: null as Pending | null,
    feedbackPending: null as (Pending & { clientEventId: string }) | null,
    exclusions: [] as string[],
    lastUser: client.userId ?? "",
    loadingLists: false,
  };
}

function createData() {
  return {
    userId: "",
    tab: "now",
    topInset: 60,
    bottomInset: 24,
    sheet: false,
    draft: "",
    notice: "",
    error: "",
    busy: false,
    loginLabel: __MINIPROGRAM_CONFIG__.loginMode === "mock" ? "开发模式登录" : "微信登录",
    minuteOptions: ["不限时长", "15 分钟", "30 分钟", "60 分钟"],
    minuteIndex: 0,
    moodOptions: ["都可以", "想歇一歇", "想试点新的", "想和人见面"],
    moodIndex: 0,
    willingToGoOut: false,
    life: [] as LifeListItem[],
    captures: [] as (CaptureResponse & { statusLabel: string })[],
    recommendation: null as NowResponse["recommendation"],
    sessionId: "",
    decided: false,
  };
}

Page({
  data: createData(),
  runtime: createRuntime(),
  updateData(values: Partial<ReturnType<typeof createData>>) {
    if (!this.runtime.unloaded) this.setData(values);
  },
  resetSessionContent() {
    const state = this.runtime;
    state.capturePending = state.nowPending = state.feedbackPending = null;
    state.exclusions = [];
    this.updateData({
      draft: "",
      notice: "",
      life: [],
      captures: [],
      recommendation: null,
      sessionId: "",
      decided: false,
      sheet: false,
    });
  },
  onLoad() {
    this.runtime = createRuntime();
    const state = this.runtime;
    const info = wx.getWindowInfo();
    const menu = wx.getMenuButtonBoundingClientRect();
    this.updateData({
      topInset: Math.max(menu.bottom + 16, info.statusBarHeight + 44),
      bottomInset: Math.max(16, info.screenHeight - (info.safeArea?.bottom ?? info.screenHeight)),
    });
    state.binding = createStoreBindings(this, {
      store: sessionStore,
      fields: ["userId"],
      actions: [],
    });
    state.binding.updateStoreBindings();
  },
  onShow() {
    const state = this.runtime;
    state.visible = true;
    state.pollCount = 0;
    if (client.userId) void this.refreshLists();
  },
  onHide() {
    const state = this.runtime;
    state.visible = false;
    if (state.poll) clearTimeout(state.poll);
  },
  onUnload() {
    const state = this.runtime;
    state.unloaded = true;
    state.visible = false;
    if (state.poll) clearTimeout(state.poll);
    state.binding?.destroyStoreBindings();
  },
  async signIn() {
    const state = this.runtime;
    if (this.data.busy) return;
    this.updateData({ busy: true, error: "" });
    try {
      await client.login();
      if (state.unloaded) return;
      if (state.lastUser !== client.userId) {
        this.resetSessionContent();
      }
      state.lastUser = client.userId ?? "";
      await this.refreshLists();
    } catch (error) {
      this.updateData({ error: userMessage(error) });
    } finally {
      this.updateData({ busy: false });
    }
  },
  async signOut() {
    const state = this.runtime;
    if (this.data.busy) return;
    this.updateData({ busy: true, error: "" });
    if (state.poll) clearTimeout(state.poll);
    try {
      await client.logout();
    } catch {
      this.updateData({ error: "已退出本机；网络异常，远端会话可能尚未撤销。" });
    } finally {
      state.lastUser = "";
      this.resetSessionContent();
      this.updateData({ busy: false });
    }
  },
  switchTab(event: WechatMiniprogram.TouchEvent) {
    const state = this.runtime;
    this.updateData({ tab: event.currentTarget.dataset.tab });
    if (client.userId && this.data.tab === "life") {
      state.pollCount = 0;
      void this.refreshLists();
    }
  },
  openCapture() {
    if (client.userId) this.updateData({ sheet: true, error: "", notice: "" });
  },
  closeCapture() {
    if (!this.data.busy) this.updateData({ sheet: false });
  },
  noop() {},
  editDraft(event: WechatMiniprogram.TextareaInput) {
    this.updateData({ draft: event.detail.value });
  },
  async saveCapture() {
    const state = this.runtime;
    if (this.data.busy) return;
    const input = createCaptureRequestSchema.safeParse({
      type: "TEXT",
      text: this.data.draft,
      sourceChannel: "MINIPROGRAM",
    });
    if (!input.success) {
      this.updateData({ error: "请写下 1–5000 字的内容。" });
      return;
    }
    this.updateData({ busy: true, error: "" });
    try {
      const signature = JSON.stringify(input.data);
      if (state.capturePending?.signature !== signature)
        state.capturePending = { signature, key: await client.newKey() };
      await client.request("/v1/captures", captureAcceptedSchema, {
        method: "POST",
        data: input.data,
        key: state.capturePending.key,
      });
      if (state.unloaded) return;
      state.capturePending = null;
      this.updateData({ draft: "", sheet: false, notice: "收到了", tab: "life" });
      state.pollCount = 0;
      await this.refreshLists();
    } catch (error) {
      this.updateData({ error: userMessage(error) });
    } finally {
      this.updateData({ busy: false });
    }
  },
  async refreshLists() {
    const state = this.runtime;
    if (!client.userId || state.loadingLists || state.unloaded) return;
    state.loadingLists = true;
    if (state.poll) clearTimeout(state.poll);
    try {
      const [life, captures] = await Promise.all([
        client.request("/v1/life", lifeListResponseSchema),
        client.request("/v1/captures", captureListResponseSchema),
      ]);
      this.updateData({
        life,
        captures: captures.map((item) => ({
          ...item,
          statusLabel: statusLabels[item.status] ?? item.status,
        })),
      });
      const pending = captures.some((item) => ["UPLOADED", "PROCESSING"].includes(item.status));
      if (pending && state.visible && state.pollCount++ < 12)
        state.poll = setTimeout(() => {
          void this.refreshLists();
        }, 2000);
    } catch (error) {
      this.updateData({ error: userMessage(error) });
    } finally {
      state.loadingLists = false;
    }
  },
  manualRefresh() {
    const state = this.runtime;
    state.pollCount = 0;
    this.updateData({ error: "" });
    void this.refreshLists();
  },
  setMinutes(event: WechatMiniprogram.PickerChange) {
    this.updateData({ minuteIndex: Number(event.detail.value) });
  },
  setMood(event: WechatMiniprogram.PickerChange) {
    this.updateData({ moodIndex: Number(event.detail.value) });
  },
  setOutdoors(event: WechatMiniprogram.SwitchChange) {
    this.updateData({ willingToGoOut: event.detail.value });
  },
  async decide() {
    if (this.data.busy) return;
    this.updateData({ busy: true, error: "", notice: "" });
    try {
      await this.requestDecision();
    } catch (error) {
      this.updateData({ error: userMessage(error) });
    } finally {
      this.updateData({ busy: false });
    }
  },
  async requestDecision() {
    const state = this.runtime;
    if (state.unloaded) return;
    const minutes = [undefined, 15, 30, 60][this.data.minuteIndex];
    const mood = [undefined, "LOW_ENERGY", "CURIOUS", "SOCIAL"][this.data.moodIndex];
    const input = createNowSessionRequestSchema.parse({
      context: { availableMinutes: minutes, mood, willingToGoOut: this.data.willingToGoOut },
      excludeObjectIds: state.exclusions,
    });
    const signature = JSON.stringify(input);
    if (state.nowPending?.signature !== signature)
      state.nowPending = { signature, key: await client.newKey() };
    const result = await client.request("/v1/now/sessions", nowResponseSchema, {
      method: "POST",
      data: input,
      key: state.nowPending.key,
    });
    if (state.unloaded) return;
    state.nowPending = null;
    state.feedbackPending = null;
    this.updateData({
      recommendation: result.recommendation,
      sessionId: result.sessionId,
      decided: true,
    });
  },
  async feedback(event: WechatMiniprogram.TouchEvent) {
    const state = this.runtime;
    if (this.data.busy || !this.data.recommendation) return;
    const eventType = event.currentTarget.dataset.type as "ACCEPT" | "SKIP";
    this.updateData({ busy: true, error: "" });
    try {
      const signature = this.data.sessionId + ":" + eventType;
      if (state.feedbackPending && state.feedbackPending.signature !== signature) {
        this.updateData({ error: "上次反馈尚未确认，请先重试原来的选择。" });
        return;
      }
      if (!state.feedbackPending)
        state.feedbackPending = {
          signature,
          key: await client.newKey(),
          clientEventId: await client.newKey(),
        };
      const data = createFeedbackRequestSchema.parse({
        eventType,
        clientEventId: state.feedbackPending.clientEventId,
      });
      await client.request(
        `/v1/now/sessions/${this.data.sessionId}/feedback`,
        feedbackAcceptedSchema,
        { method: "POST", data, key: state.feedbackPending.key },
      );
      if (state.unloaded) return;
      const target = this.data.recommendation.targetLifeObjectId;
      state.feedbackPending = null;
      this.updateData({ recommendation: null, sessionId: "", decided: false });
      if (eventType === "SKIP") {
        state.exclusions = [...state.exclusions, target].slice(-100);
        await this.requestDecision();
      } else this.updateData({ notice: "记下了，按自己的节奏开始吧。" });
    } catch (error) {
      this.updateData({ error: userMessage(error) });
    } finally {
      this.updateData({ busy: false });
    }
  },
});
