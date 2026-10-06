import "../../lib/zod-runtime";
import { createStoreBindings } from "mobx-miniprogram-bindings";
import {
  captureAcceptedSchema,
  captureListResponseSchema,
  createCaptureRequestSchema,
  createFeedbackRequestSchema,
  createNowSessionRequestSchema,
  feedbackAcceptedSchema,
  lifeSectionsResponseSchema,
  lifeStacksResponseSchema,
  lifeDeckResponseSchema,
  lifeRatingAcceptedSchema,
  lifeDeletedSchema,
  nowResponseSchema,
  type CaptureResponse,
  type LifeSections,
  type NowContext,
  type NowResponse,
} from "@life/contracts";
import type { AppServices } from "../../lib/session";
import { userMessage } from "../../lib/errors";
import { getCurrentLocation, routeUnavailableMessage } from "../../lib/location";
import {
  capabilitiesSchema,
  chooseCaptureImage,
  VoiceCapture,
  type CaptureImage,
} from "../../lib/media";
import { createLifeStack, type LifeStack } from "../../lib/life";
const { client, sessionStore } = getApp<{ globalData: AppServices }>().globalData;

type Pending = { signature: string; key: string };
type HomeCard = {
  id: string;
  title: string;
  summary: string;
  phase: string;
  imagePath: string;
  statusLabel: string;
};
function captureCard(item: CaptureResponse, imagePath = ""): HomeCard {
  return {
    id: item.id,
    title: item.title || (item.type === "IMAGE" ? "留下一张图片" : "留下一个念头"),
    summary:
      item.summary ||
      (["UPLOADED", "PROCESSING"].includes(item.status)
        ? "收好了，正在整理要点。"
        : item.status === "FAILED"
          ? "原始内容已保留，稍后再整理。"
          : "已经收好了。"),
    phase: item.status,
    imagePath,
    statusLabel: statusLabels[item.status] ?? "已收纳",
  };
}
const statusLabels: Record<string, string> = {
  UPLOADED: "已收纳",
  PROCESSING: "在慢慢整理",
  READY: "已收纳",
  NEEDS_REVIEW: "已收纳",
  FAILED: "理解未完成，原文已保留",
};
function needsRouteLocation(result: NowResponse) {
  const recommendation = result.recommendation;
  return (
    recommendation?.plan?.mode === "PREPARE" &&
    result.candidates.some(
      (candidate) =>
        candidate.lifeObjectId === recommendation.targetLifeObjectId &&
        candidate.actionMode === "DO" &&
        ["ROUTE_UNVERIFIED", "REGION_REQUIRES_TRAVEL", "NOT_GOING_OUT"].includes(
          candidate.filterReason ?? "",
        ),
    )
  );
}
function createRuntime() {
  return {
    binding: undefined as ReturnType<typeof createStoreBindings> | undefined,
    poll: undefined as ReturnType<typeof setTimeout> | undefined,
    visible: false,
    unloaded: false,
    pollCount: 0,
    capturePending: null as Pending | null,
    nowPending: null as Pending | null,
    requestLocation: null as NowContext["location"] | null,
    locationGeneration: 0,
    pendingDecisionCaptureId: "",
    decisionRefresh: undefined as ReturnType<typeof setTimeout> | undefined,
    feedbackPending: null as (Pending & { clientEventId: string }) | null,
    exclusions: [] as string[],
    lastUser: client.userId ?? "",
    loadingLists: false,
    mediaGeneration: 0,
    image: null as CaptureImage | null,
    voice: null as VoiceCapture | null,
    voiceLines: [] as string[],
    voiceBaseDraft: "",
    voiceHolding: false,
    voiceRecorded: false,
    voiceAutoSubmit: false,
    voiceStartY: 0,
    voiceCardId: "",
    localCaptureId: "",
    answerPending: null as Pending | null,
    voiceSessionId: "",
    voiceFade: undefined as ReturnType<typeof setTimeout> | undefined,
    lifeGeneration: 0,
    lifeStackFlight: null as number | null,
    ratingPending: new Map<string, Pending>(),
    ratingFlights: new Set<string>(),
    deletePending: null as Pending | null,
    deleteFlight: null as { sessionId: string; target: string } | null,
  };
}

function createData() {
  return {
    userId: "",
    tab: "now",
    topInset: 60,
    bottomInset: 24,
    sheet: false,
    inputMode: "menu",
    imagePath: "",
    imageLoading: false,
    voiceStatus: "idle",
    voiceLevel: 0,
    waveBars: [0.35, 0.7, 1, 0.55, 0.9, 0.4, 0.75, 1, 0.5, 0.8, 0.4],
    voicePrompt: "正在准备语音…",
    voicePartial: "",
    voiceRows: [] as { text: string; fading: boolean; id: number }[],
    voiceCancelGesture: false,
    voiceHolding: false,
    cards: [] as HomeCard[],
    question: null as NowResponse["question"],
    draft: "",
    notice: "",
    error: "",
    busy: false,
    loginLabel: __MINIPROGRAM_CONFIG__.loginMode === "mock" ? "开发模式登录" : "微信登录",
    sections: [] as LifeSections,
    captures: [] as (CaptureResponse & { statusLabel: string })[],
    lifeCaptures: [] as (CaptureResponse & { statusLabel: string })[],
    recommendation: null as NowResponse["recommendation"],
    sessionId: "",
    decided: false,
    quietReason: "",
    canVerifyRoute: false,
    routeLocationBusy: false,
    routeStatus: "",
    lifeStacks: [] as LifeStack[],
    lifeStacksLoaded: false,
    lifeStacksLoading: false,
    stackDragging: false,
    ratingBusy: [] as string[],
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
    this.clearRequestLocation();
    state.lifeGeneration++;
    state.lifeStackFlight = null;
    state.ratingPending.clear();
    state.ratingFlights.clear();
    state.deletePending = null;
    state.deleteFlight = null;
    this.cleanupMedia();
    state.image = null;
    state.voiceSessionId = "";
    state.capturePending = state.nowPending = state.feedbackPending = null;
    state.exclusions = [];
    state.pendingDecisionCaptureId = "";
    if (state.decisionRefresh) clearTimeout(state.decisionRefresh);
    state.answerPending = null;
    state.localCaptureId = state.voiceCardId = "";
    this.updateData({
      draft: "",
      notice: "",
      sections: [],
      captures: [],
      lifeCaptures: [],
      recommendation: null,
      sessionId: "",
      decided: false,
      sheet: false,
      inputMode: "menu",
      imagePath: "",
      imageLoading: false,
      voiceStatus: "idle",
      voicePartial: "",
      voiceRows: [],
      cards: [],
      question: null,
      canVerifyRoute: false,
      lifeStacks: [],
      lifeStacksLoaded: false,
      lifeStacksLoading: false,
      ratingBusy: [],
      stackDragging: false,
      voiceHolding: false,
      voiceCancelGesture: false,
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
    if (client.userId) {
      void this.refreshLists();
      void this.restoreActivePlan();
      if (this.data.tab === "life") void this.loadLifeStacks(true);
      if (state.deletePending || state.deleteFlight) void this.reconcileWishAfterReturn();
    }
  },
  async restoreActivePlan() {
    const owner = client.userId;
    if (!owner || this.data.busy || this.data.sessionId) return;
    const key = `${client.storageKey}:active:${owner}`;
    const sessionId = wx.getStorageSync(key);
    if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(sessionId)) return;
    try {
      const result = await client.request(`/v1/now/sessions/${sessionId}`, nowResponseSchema);
      if (this.runtime.unloaded || client.userId !== owner) return;
      if (result.recommendation?.progress?.state === "ACTIVE")
        this.updateData({
          sessionId,
          recommendation: result.recommendation,
          decided: true,
          question: null,
          canVerifyRoute: false,
        });
      else wx.removeStorageSync(key);
    } catch {
      /* Preserve the session id for retry after a transient network failure. */
    }
  },
  onHide() {
    const state = this.runtime;
    state.visible = false;
    state.lifeGeneration++;
    state.lifeStackFlight = null;
    this.updateData({
      stackDragging: false,
      ratingBusy: [],
      lifeStacksLoading: false,
      lifeStacks: this.data.lifeStacks.map((group) => ({ ...group, loading: false })),
      ...(state.deleteFlight ? { busy: false } : {}),
    });
    this.clearRequestLocation();
    this.cleanupMedia();
    if (state.poll) clearTimeout(state.poll);
    if (state.decisionRefresh) clearTimeout(state.decisionRefresh);
  },
  onUnload() {
    const state = this.runtime;
    this.clearRequestLocation();
    this.cleanupMedia();
    state.unloaded = true;
    state.visible = false;
    state.lifeGeneration++;
    if (state.poll) clearTimeout(state.poll);
    if (state.decisionRefresh) clearTimeout(state.decisionRefresh);
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
    this.cleanupMedia();
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
      void this.loadLifeStacks();
    }
  },
  async loadLifeStacks(reset = false) {
    const state = this.runtime;
    const owner = client.userId;
    if (
      !owner ||
      state.unloaded ||
      state.lifeStackFlight != null ||
      (!reset && this.data.lifeStacksLoaded)
    )
      return;
    const generation = ++state.lifeGeneration;
    state.lifeStackFlight = generation;
    const isCurrent = () =>
      !state.unloaded && state.lifeGeneration === generation && client.userId === owner;
    this.updateData({ lifeStacksLoading: true, error: "" });
    try {
      const groups = await client.request("/v1/life/stacks", lifeStacksResponseSchema);
      if (!isCurrent()) return;
      this.updateData({
        lifeStacks: groups.map((group) =>
          createLifeStack(
            group,
            this.data.lifeStacks.find((old) => old.kind === group.kind),
          ),
        ),
        lifeStacksLoaded: true,
      });
    } catch (error) {
      if (isCurrent()) this.updateData({ error: userMessage(error) });
    } finally {
      if (state.lifeStackFlight === generation) state.lifeStackFlight = null;
      if (isCurrent()) this.updateData({ lifeStacksLoading: false });
    }
  },
  stackTouchStart() {
    this.updateData({ stackDragging: true });
  },
  stackTouchEnd() {
    this.updateData({ stackDragging: false });
  },
  stackChanged(event: WechatMiniprogram.SwiperChange) {
    this.setStackCurrent(event.currentTarget.dataset.kind, Number(event.detail.current));
  },
  setStackCurrent(kind: string, current: number) {
    const group = this.data.lifeStacks.find((item) => item.kind === kind);
    if (!group || !Number.isInteger(current) || current < 0 || current >= group.items.length)
      return;
    this.updateData({
      lifeStacks: this.data.lifeStacks.map((item) =>
        item.kind === kind ? { ...item, current } : item,
      ),
    });
    if (current >= group.items.length - 2 && group.nextCursor) void this.loadStackMore(kind);
  },
  moveStack(event: WechatMiniprogram.TouchEvent) {
    const kind = event.currentTarget.dataset.kind;
    const group = this.data.lifeStacks.find((item) => item.kind === kind);
    if (!group) return;
    const current = group.current + Number(event.currentTarget.dataset.step);
    if (current >= group.items.length) {
      void this.loadStackMore(kind);
      return;
    }
    this.setStackCurrent(kind, current);
  },
  async loadStackMore(kindOrEvent: string | WechatMiniprogram.TouchEvent) {
    const kind =
      typeof kindOrEvent === "string" ? kindOrEvent : kindOrEvent.currentTarget.dataset.kind;
    const group = this.data.lifeStacks.find((item) => item.kind === kind);
    const state = this.runtime;
    const generation = state.lifeGeneration;
    const owner = client.userId;
    if (!group?.nextCursor || group.loading || !owner || state.unloaded) return;
    const update = (values: Partial<LifeStack>) =>
      this.updateData({
        lifeStacks: this.data.lifeStacks.map((item) =>
          item.kind === kind ? { ...item, ...values } : item,
        ),
      });
    const isCurrent = () =>
      !state.unloaded && generation === state.lifeGeneration && owner === client.userId;
    update({ loading: true, error: "" });
    try {
      const key = await client.newKey();
      if (!isCurrent()) return;
      const result = await client.request("/v1/life/deck", lifeDeckResponseSchema, {
        method: "POST",
        data: { kind, cursor: group.nextCursor, limit: 20 },
        key,
      });
      if (!isCurrent()) return;
      const currentGroup = this.data.lifeStacks.find((item) => item.kind === kind)!;
      const ids = new Set(currentGroup.items.map((item) => item.id));
      update({
        items: [
          ...currentGroup.items,
          ...createLifeStack({ kind: group.kind, title: group.title, ...result }).items.filter(
            (item) => !ids.has(item.id),
          ),
        ],
        nextCursor: result.nextCursor,
        asOf: result.asOf,
      });
    } catch (error) {
      if (isCurrent()) update({ error: userMessage(error) });
    } finally {
      if (isCurrent()) update({ loading: false });
    }
  },
  openCategory(event: WechatMiniprogram.TouchEvent) {
    const kind = event.currentTarget.dataset.kind;
    if (!this.data.lifeStacks.some((group) => group.kind === kind)) return;
    wx.navigateTo({ url: `/pages/life-list/index?kind=${kind}` });
  },
  viewLifeItem(event: WechatMiniprogram.TouchEvent) {
    const item = this.data.lifeStacks
      .flatMap((group) => group.items)
      .find((item) => item.id === event.currentTarget.dataset.id);
    if (item)
      wx.showModal({
        title: item.title,
        content: item.summary || item.title,
        showCancel: false,
        confirmText: "收起",
      });
  },
  async rateLifeItem(event: WechatMiniprogram.TouchEvent) {
    const state = this.runtime;
    const owner = client.userId;
    const generation = state.lifeGeneration;
    const id = event.currentTarget.dataset.id;
    const chosen = event.currentTarget.dataset.rating;
    const item = this.data.lifeStacks
      .flatMap((group) => group.items)
      .find((item) => item.id === id);
    if (!owner || !item || state.ratingFlights.has(id) || !["LIKE", "DISLIKE"].includes(chosen))
      return;
    const rating = item.myRating === chosen ? "NONE" : chosen;
    const signature = JSON.stringify({ rating });
    const isCurrent = () =>
      !state.unloaded && generation === state.lifeGeneration && owner === client.userId;
    state.ratingFlights.add(id);
    this.updateData({ ratingBusy: [...state.ratingFlights], error: "" });
    try {
      const previous = state.ratingPending.get(id);
      const pending =
        previous?.signature === signature ? previous : { signature, key: await client.newKey() };
      if (!isCurrent()) return;
      state.ratingPending.set(id, pending);
      const result = await client.request(`/v1/life/${id}/rating`, lifeRatingAcceptedSchema, {
        method: "POST",
        data: { rating },
        key: pending.key,
      });
      if (!isCurrent()) return;
      state.ratingPending.delete(id);
      this.updateData({
        lifeStacks: this.data.lifeStacks.map((group) => ({
          ...group,
          items: group.items.map((item) =>
            item.id === id ? { ...item, myRating: result.rating } : item,
          ),
        })),
      });
    } catch (error) {
      if (isCurrent()) this.updateData({ error: userMessage(error) });
    } finally {
      state.ratingFlights.delete(id);
      if (isCurrent()) this.updateData({ ratingBusy: [...state.ratingFlights] });
    }
  },
  async deleteWish() {
    const state = this.runtime;
    const owner = client.userId;
    const target = this.data.recommendation?.targetLifeObjectId;
    const generation = state.locationGeneration;
    if (!owner || !target || this.data.busy || state.unloaded || state.deleteFlight) return;
    const flight = { sessionId: this.data.sessionId, target };
    state.deleteFlight = flight;
    const isCurrent = () =>
      !state.unloaded && generation === state.locationGeneration && owner === client.userId;
    this.updateData({ busy: true, error: "" });
    try {
      const pending =
        state.deletePending?.signature === target
          ? state.deletePending
          : { signature: target, key: await client.newKey() };
      if (!isCurrent()) return;
      state.deletePending = pending;
      await client.request(`/v1/life/${target}`, lifeDeletedSchema, {
        method: "DELETE",
        key: pending.key,
      });
      if (!isCurrent()) return;
      state.deletePending = state.nowPending = state.feedbackPending = state.answerPending = null;
      state.exclusions = [...state.exclusions, target].slice(-100);
      wx.removeStorageSync(`${client.storageKey}:active:${owner}`);
      this.updateData({
        recommendation: null,
        question: null,
        sessionId: "",
        decided: false,
        canVerifyRoute: false,
        notice: "已删除该心愿。",
        lifeStacks: this.data.lifeStacks
          .map((group) =>
            createLifeStack(
              { ...group, items: group.items.filter((item) => item.id !== target) },
              group,
            ),
          )
          .filter((group) => group.items.length),
      });
      void this.refreshLists();
      await this.requestDecision();
    } catch (error) {
      if (isCurrent()) this.updateData({ error: userMessage(error) });
    } finally {
      if (state.deleteFlight === flight) state.deleteFlight = null;
      if (isCurrent()) this.updateData({ busy: false });
      else if (!state.unloaded && state.visible && owner === client.userId)
        void this.reconcileWishAfterReturn();
    }
  },
  async reconcileWishAfterReturn() {
    const state = this.runtime;
    const owner = client.userId;
    const generation = state.locationGeneration;
    const sessionId = this.data.sessionId;
    if (!owner || !sessionId || this.data.busy || state.unloaded) return;
    try {
      const result = await client.request(`/v1/now/sessions/${sessionId}`, nowResponseSchema);
      if (
        state.unloaded ||
        !state.visible ||
        owner !== client.userId ||
        generation !== state.locationGeneration ||
        sessionId !== this.data.sessionId
      )
        return;
      if (!result.recommendation) {
        state.deletePending = null;
        if (wx.getStorageSync(`${client.storageKey}:active:${owner}`) === sessionId)
          wx.removeStorageSync(`${client.storageKey}:active:${owner}`);
        this.updateData({
          recommendation: null,
          question: null,
          sessionId: "",
          decided: false,
          canVerifyRoute: false,
        });
        void this.decide();
      }
    } catch {
      // The old card remains until a fresh authenticated read confirms it is gone.
    }
  },
  openCapture() {
    if (this.data.voiceStatus === "finishing") {
      wx.showToast?.({ title: "最后一句正在收好", icon: "none" });
      return;
    }
    if (this.data.busy) return;
    if (client.userId) this.updateData({ sheet: true, inputMode: "menu", error: "", notice: "" });
  },
  closeCapture() {
    if (!this.data.busy) {
      this.cleanupMedia();
      this.updateData({ sheet: false, imageLoading: false });
    }
  },
  cleanupMedia() {
    const state = this.runtime;
    state.mediaGeneration++;
    if (
      state.voice &&
      state.voiceCardId &&
      this.data.cards.some((card) => card.id === state.voiceCardId && card.phase === "TRANSCRIBING")
    )
      this.failVoiceCard();
    if (state.localCaptureId)
      this.updateData({
        cards: this.data.cards.map((card) =>
          card.id === state.localCaptureId && card.phase === "SENDING"
            ? {
                ...card,
                phase: "FAILED_LOCAL",
                statusLabel: "还没确认收好",
                summary: "原始内容还在，可以稍后重试。",
              }
            : card,
        ),
      });
    state.voice?.cancel();
    state.voice = null;
    state.voiceHolding = state.voiceAutoSubmit = false;
    if (state.voiceFade) clearTimeout(state.voiceFade);
    this.updateData({
      voiceStatus: "idle",
      voiceHolding: false,
      voiceCancelGesture: false,
      voicePartial: "",
      voiceRows: [],
      imageLoading: false,
    });
  },
  chooseText() {
    if (this.data.busy || this.data.voiceStatus === "finishing") return;
    this.cleanupMedia();
    this.runtime.voiceSessionId = "";
    this.updateData({ inputMode: "text", error: "" });
  },
  async chooseImage() {
    const state = this.runtime;
    if (this.data.imageLoading || this.data.busy || this.data.voiceStatus === "finishing") return;
    this.cleanupMedia();
    const generation = state.mediaGeneration;
    let selectedImage = false;
    this.updateData({ inputMode: "image", imageLoading: true, error: "" });
    try {
      const caps = await client.request("/v1/media/capabilities", capabilitiesSchema);
      if (generation !== state.mediaGeneration || state.unloaded) return;
      if (!caps.image) {
        this.updateData({ error: "图片理解尚未配置。可以先留下文字，配置后再添加图片。" });
        return;
      }
      const image = await chooseCaptureImage();
      if (generation !== state.mediaGeneration || state.unloaded || !image) return;
      state.image = image;
      state.voiceSessionId = "";
      this.updateData({ imagePath: image.path });
      selectedImage = true;
    } catch (error) {
      if (generation === state.mediaGeneration) this.updateData({ error: userMessage(error) });
    } finally {
      if (generation === state.mediaGeneration) this.updateData({ imageLoading: false });
    }
    if (selectedImage && generation === state.mediaGeneration && !state.unloaded)
      void this.saveCapture();
  },
  removeImage() {
    this.runtime.image = null;
    this.updateData({ imagePath: "" });
  },
  chooseVoice() {
    if (!client.userId || this.data.busy || this.data.voiceStatus === "finishing") return;
    this.cleanupMedia();
    this.runtime.voiceSessionId = "";
    this.updateData({
      sheet: true,
      inputMode: "voice",
      voiceStatus: "idle",
      error: "",
      voicePrompt: "按住说话，松手就收好",
    });
    const generation = this.runtime.mediaGeneration;
    // Ask on the explicit voice-mode tap, before any hold gesture. First-time
    // permission dialogs cannot swallow the recording button's release event.
    if (typeof wx.authorize === "function")
      wx.authorize({
        scope: "scope.record",
        success: () => {
          if (generation === this.runtime.mediaGeneration)
            this.updateData({ voicePrompt: "按住说话，松手就收好" });
        },
        fail: () => {
          if (generation === this.runtime.mediaGeneration)
            this.updateData({ error: userMessage({ code: "VOICE_PERMISSION_REQUIRED" }) });
        },
      });
  },
  async voiceTouchStart(event: WechatMiniprogram.TouchEvent) {
    const state = this.runtime;
    if (
      !client.userId ||
      this.data.busy ||
      state.voiceHolding ||
      ["connecting", "recording", "finishing"].includes(this.data.voiceStatus)
    )
      return;
    this.cleanupMedia();
    const generation = state.mediaGeneration;
    state.voiceHolding = true;
    state.voiceRecorded = state.voiceAutoSubmit = false;
    state.voiceStartY = event.touches?.[0]?.clientY ?? 0;
    state.voiceLines = [];
    state.voiceBaseDraft = this.data.draft;
    state.voiceSessionId = "";
    this.updateData({
      sheet: true,
      inputMode: "voice",
      voiceStatus: "connecting",
      voiceHolding: true,
      voiceCancelGesture: false,
      voicePrompt: "允许使用麦克风后，就能开始说",
      error: "",
    });
    try {
      state.voice = new VoiceCapture(
        client,
        (event) => {
          if (generation !== state.mediaGeneration || state.unloaded) return;
          if (event.type === "partial")
            this.updateData({
              voicePartial: event.text.slice(-40),
              draft: [state.voiceBaseDraft, ...state.voiceLines, event.text]
                .filter(Boolean)
                .join("\n"),
            });
          else if (event.type === "final") {
            if (event.text.trim()) state.voiceLines.push(event.text);
            this.updateData({
              voicePartial: "",
              draft: [state.voiceBaseDraft, ...state.voiceLines].filter(Boolean).join("\n"),
            });
            this.updateVoiceRows();
          } else if (event.type === "done") {
            state.voiceSessionId = event.sessionId;
            this.updateData({
              voiceStatus: "done",
              voicePartial: "",
              draft: [state.voiceBaseDraft, event.text].filter(Boolean).join("\n"),
            });
            state.voice = null;
            if (state.voiceAutoSubmit) void this.saveCapture();
          } else if (event.type === "error") {
            state.voiceHolding = state.voiceAutoSubmit = false;
            this.updateData({
              voiceStatus: "idle",
              voiceHolding: false,
              voicePartial: "",
              error: userMessage({ code: event.code }),
            });
            this.failVoiceCard();
            state.voice = null;
          }
        },
        () => {
          if (generation !== state.mediaGeneration) return;
          state.voiceRecorded = true;
          this.updateData({ voiceStatus: "recording" });
        },
        () => {
          if (generation !== state.mediaGeneration) return;
          this.updateData({ voiceStatus: "finishing", voiceHolding: false });
          if (state.voiceHolding) this.releaseVoice();
        },
        (phase) => {
          if (generation === state.mediaGeneration)
            this.updateData({
              voicePrompt:
                phase === "permission" ? "允许使用麦克风后，就能开始说" : "正在听，上滑可取消",
            });
        },
        (level) => {
          if (generation === state.mediaGeneration) this.updateData({ voiceLevel: level });
        },
      );
      await state.voice.start();
    } catch (error) {
      if (generation === state.mediaGeneration) {
        state.voice?.cancel();
        state.voice = null;
        state.voiceHolding = state.voiceAutoSubmit = false;
        this.updateData({ voiceStatus: "idle", voiceHolding: false, error: userMessage(error) });
        this.failVoiceCard();
      }
    }
  },
  voiceTouchMove(event: WechatMiniprogram.TouchEvent) {
    if (!this.runtime.voiceHolding) return;
    const y = event.touches?.[0]?.clientY ?? this.runtime.voiceStartY;
    this.updateData({ voiceCancelGesture: this.runtime.voiceStartY - y > 72 });
  },
  voiceTouchEnd() {
    const state = this.runtime;
    if (!state.voiceHolding) return;
    if (this.data.voiceCancelGesture || !state.voiceRecorded) {
      this.cancelVoice();
      return;
    }
    this.releaseVoice();
    state.voice?.finish();
  },
  releaseVoice() {
    const state = this.runtime;
    state.voiceHolding = false;
    state.voiceAutoSubmit = true;
    if (!state.voiceCardId) state.voiceCardId = "voice-" + Date.now();
    const card: HomeCard = {
      id: state.voiceCardId,
      title: "留下一段话",
      summary: "正在把这段话收好。",
      phase: "TRANSCRIBING",
      imagePath: "",
      statusLabel: "语音收纳中",
    };
    this.updateData({
      sheet: false,
      tab: "now",
      voiceHolding: false,
      voiceCancelGesture: false,
      voiceStatus: "finishing",
      cards: [card, ...this.data.cards.filter((item) => item.id !== card.id)],
    });
  },
  failVoiceCard() {
    const id = this.runtime.voiceCardId;
    if (!id) return;
    this.updateData({
      cards: this.data.cards.map((card) =>
        card.id === id
          ? {
              ...card,
              phase: "FAILED_LOCAL",
              statusLabel: "还没收好",
              summary: this.data.draft.trim()
                ? "识别到的文字还在，可以编辑后重试。"
                : "这段话还没收好，请重新说一遍。",
            }
          : card,
      ),
    });
  },
  updateVoiceRows() {
    const state = this.runtime;
    if (state.voiceFade) clearTimeout(state.voiceFade);
    const total = state.voiceLines.length;
    this.updateData({
      voiceRows: state.voiceLines.slice(-2).map((text, index, lines) => ({
        text,
        id: total - lines.length + index,
        fading: index < lines.length - 1,
      })),
    });
    state.voiceFade = setTimeout(() => {
      this.updateData({ voiceRows: this.data.voiceRows.map((row) => ({ ...row, fading: true })) });
    }, 2500);
  },
  cancelVoice() {
    const state = this.runtime;
    if (!state.voiceHolding) return;
    const original = state.voiceBaseDraft;
    const id = state.voiceCardId;
    this.cleanupMedia();
    state.voiceCardId = "";
    state.voiceSessionId = "";
    this.updateData({
      draft: original,
      inputMode: "voice",
      voiceStatus: "idle",
      cards: this.data.cards.filter((card) => card.id !== id),
      notice: "这段话已取消。",
    });
  },
  retryCapture() {
    if (this.data.busy) return;
    if (this.runtime.voiceCardId && !this.runtime.voiceSessionId) {
      this.runtime.voiceSessionId = "";
      this.updateData({ inputMode: "text", sheet: true });
    } else void this.saveCapture();
  },
  editFailedCapture() {
    if (!this.data.busy)
      this.updateData({ sheet: true, inputMode: this.runtime.image ? "image" : "text" });
  },
  noop() {},
  editDraft(event: WechatMiniprogram.TextareaInput) {
    this.updateData({ draft: event.detail.value });
  },
  async saveCapture() {
    const state = this.runtime;
    if (
      this.data.busy ||
      this.data.imageLoading ||
      ["connecting", "recording", "finishing"].includes(this.data.voiceStatus)
    )
      return;
    const image = this.data.inputMode === "image" ? state.image : null;
    const input = createCaptureRequestSchema.safeParse({
      type: image
        ? "IMAGE"
        : this.data.inputMode === "voice" && state.voiceSessionId
          ? "VOICE"
          : "TEXT",
      text: this.data.draft || undefined,
      ...(image ? { image: { mimeType: image.mimeType, base64: image.base64 } } : {}),
      ...(!image && this.data.inputMode === "voice" && state.voiceSessionId
        ? { transcriptionSessionId: state.voiceSessionId }
        : {}),
      sourceChannel: "MINIPROGRAM",
    });
    if (!input.success) {
      this.updateData({ error: "请写下 1–5000 字的内容。" });
      return;
    }
    const signature = JSON.stringify(input.data);
    if (state.capturePending?.signature !== signature)
      state.localCaptureId = state.voiceCardId || "sending-" + Date.now();
    const localId = state.localCaptureId;
    const generation = state.mediaGeneration;
    const sending: HomeCard = {
      id: localId,
      title: image ? "留下一张图片" : "留下一个念头",
      summary: "正在把它收好。",
      phase: "SENDING",
      imagePath: image?.path ?? "",
      statusLabel: "正在收纳",
    };
    this.updateData({
      busy: true,
      sheet: false,
      tab: "now",
      error: "",
      cards: [
        sending,
        ...this.data.cards.filter((card) => card.id !== localId && card.id !== state.voiceCardId),
      ],
    });
    try {
      if (state.capturePending?.signature !== signature)
        state.capturePending = { signature, key: await client.newKey() };
      if (state.unloaded || generation !== state.mediaGeneration) return;
      const receipt = await client.request("/v1/captures", captureAcceptedSchema, {
        method: "POST",
        data: input.data,
        key: state.capturePending.key,
      });
      if (state.unloaded || generation !== state.mediaGeneration) return;
      state.capturePending = null;
      this.updateData({
        cards: this.data.cards.map((card) =>
          card.id === localId
            ? {
                ...card,
                id: receipt.captureId,
                phase: receipt.status,
                statusLabel: "已收纳",
                summary: "收好了，正在整理要点。",
              }
            : card,
        ),
      });
      this.cleanupMedia();
      state.image = null;
      state.voiceSessionId = state.voiceCardId = state.localCaptureId = "";
      this.updateData({ draft: "", imagePath: "", sheet: false, notice: "收纳好了", tab: "now" });
      wx.showToast?.({ title: "收纳好了", icon: "success", duration: 1400 });
      state.pendingDecisionCaptureId = receipt.captureId;
      state.pollCount = 0;
      void this.refreshLists();
    } catch (error) {
      if (generation === state.mediaGeneration)
        this.updateData({
          error: userMessage(error),
          cards: this.data.cards.map((card) =>
            card.id === localId
              ? {
                  ...card,
                  phase: "FAILED_LOCAL",
                  statusLabel: "还没收好",
                  summary: "原始内容还在，可以重试。",
                }
              : card,
          ),
        });
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
      const [sections, captures] = await Promise.all([
        client.request("/v1/life/sections", lifeSectionsResponseSchema),
        client.request("/v1/captures", captureListResponseSchema),
      ]);
      const readyForDecision = captures.some(
        (item) => item.id === state.pendingDecisionCaptureId && item.status === "READY",
      );
      const ids = new Set(captures.map((item) => item.id));
      const local = this.data.cards.filter(
        (card) =>
          !ids.has(card.id) &&
          ["TRANSCRIBING", "SENDING", "FAILED_LOCAL", "UPLOADED", "PROCESSING"].includes(
            card.phase,
          ),
      );
      this.updateData({
        sections,
        lifeCaptures: captures
          .filter((item) => item.status !== "READY" || !item.title)
          .map((item) => ({ ...item, statusLabel: statusLabels[item.status] ?? "已收纳" })),
        captures: captures.map((item) => ({
          ...item,
          statusLabel: statusLabels[item.status] ?? "已收纳",
        })),
        cards: [
          ...local,
          ...captures.map((item) =>
            captureCard(item, this.data.cards.find((card) => card.id === item.id)?.imagePath),
          ),
        ],
      });
      if (this.data.tab === "life" && (readyForDecision || !this.data.lifeStacksLoaded))
        void this.loadLifeStacks(readyForDecision);
      if (readyForDecision) this.refreshDecisionAfterCapture();
    } catch (error) {
      this.updateData({ error: userMessage(error) });
    } finally {
      state.loadingLists = false;
      const pending = this.data.cards.some((card) =>
        ["UPLOADED", "PROCESSING"].includes(card.phase),
      );
      if (pending && state.visible && !state.unloaded && client.userId) {
        const delays = [700, 1000, 1500, 2500, 4000, 6000, 10000, 15000];
        const delay =
          state.pollCount > 20 ? 30000 : delays[Math.min(state.pollCount, delays.length - 1)]!;
        state.pollCount++;
        state.poll = setTimeout(() => {
          void this.refreshLists();
        }, delay);
      }
    }
  },
  refreshDecisionAfterCapture() {
    const state = this.runtime;
    if (!state.pendingDecisionCaptureId || !state.visible || state.unloaded || !client.userId)
      return;
    if (this.data.recommendation?.progress?.state === "ACTIVE") {
      state.pendingDecisionCaptureId = "";
      return;
    }
    if (this.data.busy || this.data.sheet || this.data.voiceStatus === "finishing") {
      state.decisionRefresh = setTimeout(() => this.refreshDecisionAfterCapture(), 200);
      return;
    }
    state.pendingDecisionCaptureId = "";
    void this.decide();
  },
  manualRefresh() {
    const state = this.runtime;
    state.pollCount = 0;
    this.updateData({ error: "" });
    void this.refreshLists();
    if (this.data.tab === "life") void this.loadLifeStacks(true);
  },
  openSection(event: WechatMiniprogram.TouchEvent) {
    const section = event.currentTarget.dataset.section;
    wx.navigateTo({
      url: `/pages/life-list/index?section=${section}`,
      fail: () => {
        this.updateData({ error: "暂时无法打开列表，请重试。" });
      },
    });
  },
  async decide() {
    if (this.data.busy || this.data.voiceStatus === "finishing") return;
    this.updateData({ busy: true, error: "", notice: "" });
    try {
      await this.requestDecision();
    } catch (error) {
      this.updateData({ error: userMessage(error) });
    } finally {
      this.updateData({ busy: false });
    }
  },
  clearRequestLocation() {
    const state = this.runtime;
    state.locationGeneration++;
    state.nowPending = null;
    state.requestLocation = null;
    if (this.data.routeLocationBusy)
      this.updateData({ routeLocationBusy: false, busy: false, routeStatus: "" });
  },
  async verifyCurrentRoute() {
    const state = this.runtime;
    if (
      state.unloaded ||
      this.data.busy ||
      this.data.voiceStatus === "finishing" ||
      !this.data.canVerifyRoute ||
      this.data.recommendation?.progress?.state === "ACTIVE"
    )
      return;
    const generation = ++state.locationGeneration;
    const owner = client.userId;
    const focusObjectId = this.data.recommendation?.targetLifeObjectId;
    const isCurrent = () =>
      !state.unloaded && state.locationGeneration === generation && client.userId === owner;
    this.updateData({
      routeLocationBusy: true,
      busy: true,
      routeStatus: "正在获取当前位置…",
      error: "",
      notice: "",
    });
    try {
      let point: WechatMiniprogram.GetLocationSuccessCallbackResult;
      try {
        point = await getCurrentLocation();
      } catch (error) {
        if (isCurrent()) this.updateData({ error: userMessage(error) });
        return;
      }
      if (!isCurrent()) return;
      const observedAt = Date.now();
      state.requestLocation = {
        latitude: point.latitude,
        longitude: point.longitude,
        coordinateSystem: "GCJ02",
        source: "DEVICE",
        observedAt: new Date(observedAt).toISOString(),
        expiresAt: new Date(observedAt + 2 * 60 * 60 * 1000).toISOString(),
      };
      state.nowPending = state.answerPending = null;
      this.updateData({ routeStatus: "正在核对去程和返程…" });
      const result = await this.requestDecision(focusObjectId);
      if (!isCurrent() || !result) return;
      if (result.routeCheck?.status === "READY") {
        const plan = result.recommendation?.plan;
        this.updateData({
          notice:
            plan?.basis === "VERIFIED_ROUTE"
              ? `往返路线已核对：去程约 ${Math.ceil(plan.travelSeconds / 60)} 分钟，返程约 ${Math.ceil(plan.returnSeconds / 60)} 分钟。`
              : "往返路线已核对；当前时间或其他条件暂不适合出发，先保留准备建议。",
        });
      } else this.updateData({ error: routeUnavailableMessage(result.routeCheck?.reason) });
    } catch (error) {
      if (isCurrent()) this.updateData({ error: userMessage(error) });
    } finally {
      if (isCurrent()) this.updateData({ routeLocationBusy: false, busy: false, routeStatus: "" });
    }
  },
  async requestDecision(focusObjectId?: string) {
    const state = this.runtime;
    if (state.unloaded) return;
    const generation = state.locationGeneration;
    const owner = client.userId;
    if (state.requestLocation && Date.parse(state.requestLocation.expiresAt ?? "") <= Date.now())
      state.requestLocation = null;
    const input = createNowSessionRequestSchema.parse({
      context: state.requestLocation
        ? { location: state.requestLocation, willingToGoOut: true }
        : {},
      excludeObjectIds: state.exclusions,
      ...(focusObjectId ? { focusObjectId } : {}),
    });
    const signature = JSON.stringify(input);
    const pending =
      state.nowPending?.signature === signature
        ? state.nowPending
        : { signature, key: await client.newKey() };
    if (state.unloaded || generation !== state.locationGeneration || client.userId !== owner)
      return;
    state.nowPending = pending;
    const result = await client.request("/v1/now/sessions", nowResponseSchema, {
      method: "POST",
      data: input,
      key: pending.key,
    });
    if (state.unloaded || generation !== state.locationGeneration || client.userId !== owner)
      return;
    state.nowPending = null;
    state.feedbackPending = null;
    this.updateData({
      recommendation: result.recommendation,
      question: result.question,
      sessionId: result.sessionId,
      decided: true,
      quietReason: result.quietReason ?? "",
      canVerifyRoute: needsRouteLocation(result),
    });
    return result;
  },
  async answerQuestion(event: WechatMiniprogram.TouchEvent) {
    const state = this.runtime;
    const question = this.data.question;
    if (this.data.busy || !question) return;
    const optionId = event.currentTarget.dataset.option;
    if (!question.options.some((option) => option.id === optionId)) return;
    const data = { questionId: question.id, optionId };
    const signature = JSON.stringify(data);
    if (state.answerPending?.signature !== signature)
      state.answerPending = { signature, key: await client.newKey() };
    this.updateData({ busy: true, error: "" });
    try {
      const result = await client.request(
        `/v1/now/sessions/${this.data.sessionId}/answers`,
        nowResponseSchema,
        { method: "POST", data, key: state.answerPending.key },
      );
      if (state.unloaded) return;
      state.answerPending = null;
      this.updateData({
        recommendation: result.recommendation,
        question: result.question,
        sessionId: result.sessionId,
        decided: true,
        quietReason: result.quietReason ?? "",
        canVerifyRoute: needsRouteLocation(result),
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        [
          "DECISION_SESSION_EXPIRED",
          "NOW_QUESTION_NOT_FOUND",
          "NOW_ANSWER_CONFLICT",
          "NOW_QUESTION_NOT_PENDING",
        ].includes(String(error.code))
      ) {
        state.nowPending = state.answerPending = null;
        this.updateData({ question: null, decided: false });
      }
      this.updateData({ error: userMessage(error) });
    } finally {
      this.updateData({ busy: false });
    }
  },
  async feedback(event: WechatMiniprogram.TouchEvent) {
    const state = this.runtime;
    if (this.data.busy || !this.data.recommendation) return;
    const eventType = event.currentTarget.dataset.type as "ACCEPT" | "SKIP" | "COMPLETE" | "REJECT";
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
      const feedbackResult = await client.request(
        `/v1/now/sessions/${this.data.sessionId}/feedback`,
        feedbackAcceptedSchema,
        { method: "POST", data, key: state.feedbackPending.key },
      );
      if (state.unloaded) return;
      const target = this.data.recommendation.targetLifeObjectId;
      state.feedbackPending = null;
      if (eventType === "ACCEPT" && this.data.recommendation.plan && feedbackResult.progress) {
        if (client.userId)
          wx.setStorageSync(`${client.storageKey}:active:${client.userId}`, this.data.sessionId);
        this.updateData({
          recommendation: { ...this.data.recommendation, progress: feedbackResult.progress },
          notice: "已开始，实际用时会记录下来。",
        });
        const current = await client.request(
          `/v1/now/sessions/${this.data.sessionId}`,
          nowResponseSchema,
        );
        if (!state.unloaded && current.recommendation)
          this.updateData({ recommendation: current.recommendation });
        return;
      }
      if (client.userId) wx.removeStorageSync(`${client.storageKey}:active:${client.userId}`);
      this.updateData({ recommendation: null, question: null, sessionId: "", decided: false });
      if (eventType === "COMPLETE") {
        this.updateData({
          notice: `这一步完成了，${(feedbackResult.progress?.elapsedSeconds ?? 0) < 60 ? "用时不到 1 分钟" : `用了 ${Math.ceil((feedbackResult.progress?.elapsedSeconds ?? 0) / 60)} 分钟`}。`,
        });
        void this.refreshLists();
      } else if (eventType === "REJECT") this.updateData({ notice: "已结束这次安排。" });
      else if (eventType === "SKIP") {
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
