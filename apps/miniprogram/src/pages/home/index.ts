import "../../lib/zod-runtime";
import { createStoreBindings } from "mobx-miniprogram-bindings";
import { reaction } from "mobx-miniprogram";
import {
  captureAcceptedSchema,
  capturePageResponseSchema,
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
  locationChoicesRequestSchema,
  locationChoicesResponseSchema,
  locationSelectRequestSchema,
  locationSelectResponseSchema,
  locationPickerIntentRequestSchema,
  locationPickerIntentResponseSchema,
  locationMapSelectRequestSchema,
  locationMapSelectResponseSchema,
  lifeDetailResponseSchema,
  userSettingsResponseSchema,
  type CaptureResponse,
  type LifeSections,
  type NowContext,
  type NowResponse,
  type LocationChoice,
} from "@life/contracts";
import type { AppServices } from "../../lib/session";
import { userMessage } from "../../lib/errors";
import { getCurrentLocation, routeUnavailableMessage } from "../../lib/location";
import { createRouteView, departureMessage } from "../../lib/route-view";
import {
  capabilitiesSchema,
  chooseCaptureImage,
  VoiceCapture,
  type CaptureImage,
} from "../../lib/media";
import { createLifeStack, kindOptions, type LifeStack } from "../../lib/life";
import {
  getCaptureImageCacheEpoch,
  isCaptureImageCachePath,
  readCaptureImage,
} from "../../lib/capture-image";
import { getAppearance } from "../../lib/appearance";
const { client, sessionStore, routeCache } = getApp<{ globalData: AppServices }>().globalData;

type Pending = { signature: string; key: string };
type ChoiceOrigin = {
  owner: string;
  target: string;
  generation: number;
  expiresAt: number;
  location: NonNullable<NowContext["location"]> | null;
};
type ChoiceContext = ChoiceOrigin & {
  choices: LocationChoice[];
  choiceExpiresAt: number;
  pending: (Pending & { index: number }) | null;
};
type PickedDestination = {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
};
type PickerContext = {
  owner: string;
  target: string;
  intentToken: string;
  expiresAt: number;
  picked: PickedDestination | null;
  pending: Pending | null;
  nativeOpen: boolean;
};
function pickerMessage(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (/LOCATION_.*(?:EXPIRED|INVALID)/.test(code))
    return "这次地点选择已失效，请重新打开微信地图选择。";
  if (code === "LOCATION_OBJECT_CHANGED") return "这条记录已更新，请重新选择地点。";
  const message =
    error && typeof error === "object" && "errMsg" in error
      ? String(error.errMsg).toLowerCase()
      : "";
  if (/privacy|隐私/.test(message)) return "微信地图选点需要隐私授权，请同意后重新选择。";
  if (
    /api scope|not declared|requiredprivateinfos|not supported|接口.*(?:权限|未开通)/.test(message)
  )
    return "微信地图选点接口暂不可用，请检查 chooseLocation 接口开通与隐私声明。";
  if (/auth deny|auth denied|permission|authorize.*deny|拒绝|系统.*(?:关闭|定位)/.test(message))
    return "微信地图选点权限尚未开启，请检查微信与系统的位置权限后重新选择。";
  if (message) return "微信地图暂时无法打开，请稍后重新选择地点。";
  return userMessage(error);
}
function locationChoiceMessage(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return (
    (
      {
        LOCATION_CHOICES_EXPIRED: "地点选项已过期，请重新核对地点后再选。",
        LOCATION_CHOICE_INVALID: "这个地点选项已失效，请重新核对地点后再选。",
        LOCATION_OBJECT_CHANGED: "这条记录已更新，请重新核对地点后再选。",
      } as Record<string, string>
    )[code] ?? userMessage(error)
  );
}
type HomeCard = {
  id: string;
  title: string;
  summary: string;
  phase: string;
  imagePath: string;
  statusLabel: string;
  savedDate?: string;
  original?: string;
};
type HomeSections = (Omit<LifeSections[number], "items"> & {
  items: (LifeSections[number]["items"][number] & { kindLabel: string })[];
})[];
function savedDateLabel(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function captureCard(item: CaptureResponse, imagePath = ""): HomeCard {
  const firstLine = (item.text ?? "").trim().split(/[\r\n]/, 1)[0] ?? "";
  const characters = [...firstLine];
  const textTitle = characters.slice(0, 48).join("") + (characters.length > 48 ? "…" : "");
  return {
    id: item.id,
    title:
      item.title?.trim() || textTitle || (item.type === "IMAGE" ? "留下一张图片" : "留下一个念头"),
    original: item.text ?? "",
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
    savedDate: savedDateLabel(item.createdAt),
  };
}
const statusLabels: Record<string, string> = {
  UPLOADED: "已收纳",
  PROCESSING: "在慢慢整理",
  READY: "已收纳",
  NEEDS_REVIEW: "等待核对",
  FAILED: "理解未完成，原文已保留",
};
function needsRouteLocation(result: NowResponse) {
  const recommendation = result.recommendation;
  return (
    !!recommendation &&
    result.candidates.some(
      (candidate) =>
        candidate.lifeObjectId === recommendation.targetLifeObjectId &&
        candidate.actionMode === "DO" &&
        (result.routeCheck?.status === "READY" ||
          candidate.routeCheck?.status === "READY" ||
          (recommendation.plan?.mode === "PREPARE" &&
            ["ROUTE_UNVERIFIED", "REGION_REQUIRES_TRAVEL", "NOT_GOING_OUT"].includes(
              candidate.filterReason ?? "",
            ))),
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
    nextDecisionContext: null as Pick<
      NowContext,
      "availableMinutes" | "budgetMinor" | "willingToGoOut"
    > | null,
    requestLocation: null as NowContext["location"] | null,
    locationGeneration: 0,
    choiceEpoch: 0,
    choiceContext: null as ChoiceContext | null,
    choiceOriginTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    pickerEpoch: 0,
    pickerContext: null as PickerContext | null,
    mapRefreshGeneration: null as number | null,
    pickerIdentityDispose: null as (() => void) | null,
    pendingDecisionCaptureId: "",
    decisionRefresh: undefined as ReturnType<typeof setTimeout> | undefined,
    feedbackPending: null as (Pending & { clientEventId: string }) | null,
    exclusions: [] as string[],
    lastUser: client.userId ?? "",
    loadingLists: false,
    listGeneration: 0,
    captureCursor: null as string | null,
    operationEpoch: 0,
    detailReturn: false,
    feedbackReceipt: null as {
      owner: string;
      sessionId: string;
      target: string;
      eventType: "ACCEPT" | "SKIP" | "COMPLETE" | "REJECT";
      recommendation: NonNullable<NowResponse["recommendation"]>;
      result: ReturnType<typeof feedbackAcceptedSchema.parse>;
    } | null,
    mediaGeneration: 0,
    image: null as CaptureImage | null,
    imagePickerOpen: false,
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
    onboardingCheckedUser: "",
    onboardingFlight: false,
    pictureGeneration: 0,
    pictureCacheEpoch: getCaptureImageCacheEpoch(),
    pictureCache: new Map<string, Awaited<ReturnType<typeof readCaptureImage>>>(),
    pictureFlights: new Map<string, ReturnType<typeof readCaptureImage>>(),
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
    reduceMotion: false,
    tab: "now",
    conditionsSheet: false,
    routeSheet: false,
    locationSheet: false,
    conditionGoingOut: "any",
    conditionMinutes: "any",
    conditionBudget: "any",
    captureReview: null as (HomeCard & { original: string }) | null,
    recommendationImage: "",
    topInset: 60,
    bottomInset: 24,
    sheet: false,
    inputMode: "menu",
    imagePath: "",
    imageLoading: false,
    capturePermission: "" as "" | "scope.record" | "image",
    voiceStatus: "idle",
    voiceLevel: 0,
    waveBars: [0.35, 0.7, 1, 0.55, 0.9, 0.4, 0.75, 1, 0.5, 0.8, 0.4],
    voicePrompt: "正在准备语音…",
    voicePartial: "",
    voiceRows: [] as { text: string; fading: boolean; id: number }[],
    voiceCancelGesture: false,
    voiceHolding: false,
    cards: [] as HomeCard[],
    capturesHasMore: false,
    capturesLoading: false,
    capturesMoreError: "",
    question: null as NowResponse["question"],
    draft: "",
    notice: "",
    error: "",
    busy: false,
    loginLabel: __MINIPROGRAM_CONFIG__.loginMode === "mock" ? "开发模式登录" : "微信登录并开始使用",
    onboardingError: "",
    sections: [] as HomeSections,
    captures: [] as (CaptureResponse & { statusLabel: string })[],
    lifeCaptures: [] as (CaptureResponse & { statusLabel: string })[],
    recommendation: null as NowResponse["recommendation"],
    sessionId: "",
    decided: false,
    quietReason: "",
    canVerifyRoute: false,
    routeLocationBusy: false,
    routeStatus: "",
    routeView: null as ReturnType<typeof createRouteView>,
    departureReason: "",
    locationChoices: [] as (Omit<LocationChoice, "token"> & { choiceKey: string })[],
    locationChoiceBusy: false,
    mapPickerBusy: false,
    mapSelection: null as Pick<PickedDestination, "name" | "address"> | null,
    mapDestination: null as NonNullable<NowResponse["selectedDestination"]> | null,
    hasConfirmedDestination: false,
    routeNeedsEntrance: false,
    lifeStacks: [] as LifeStack[],
    lifeStacksLoaded: false,
    lifeStacksLoading: false,
    stackDragging: false,
    ratingBusy: [] as string[],
  };
}

Page({
  data: createData(),
  runtime: null as unknown as ReturnType<typeof createRuntime>,
  updateData(values: Partial<ReturnType<typeof createData>>) {
    if (this.runtime.unloaded) return;
    if ("recommendation" in values) {
      const target = values.recommendation?.targetLifeObjectId;
      const cached = routeCache.get(client.userId, target);
      const sameTarget = target === this.data.recommendation?.targetLifeObjectId;
      if (!sameTarget) {
        this.setData({ recommendationImage: "" });
        this.clearMapPicker();
        this.setData({ mapDestination: null, hasConfirmedDestination: false });
        this.clearLocationChoices();
        if (this.data.routeLocationBusy) this.clearRequestLocation();
      }
      this.setData({
        ...values,
        routeView: cached?.view ?? null,
        departureReason: cached ? `上次查询：${cached.departureReason}` : "",
        canVerifyRoute:
          values.recommendation?.progress?.state !== "ACTIVE" &&
          ((values.canVerifyRoute ?? (sameTarget && this.data.canVerifyRoute)) || !!cached),
      });
      if (target && !sameTarget) void this.loadRecommendationImage(target);
    } else this.setData(values);
  },
  clearPictures() {
    const state = this.runtime;
    state.pictureGeneration++;
    state.pictureCache.forEach((picture) => picture?.dispose());
    state.pictureCache.clear();
    state.pictureFlights.clear();
    state.pictureCacheEpoch = getCaptureImageCacheEpoch();
  },
  invalidateClearedPictures() {
    const state = this.runtime;
    if (state.pictureCacheEpoch === getCaptureImageCacheEpoch()) return false;
    this.clearPictures();
    this.updateData({
      recommendationImage: "",
      cards: this.data.cards.map((card) => ({
        ...card,
        imagePath: isCaptureImageCachePath(card.imagePath) ? "" : card.imagePath,
      })),
      captureReview: this.data.captureReview
        ? {
            ...this.data.captureReview,
            imagePath: isCaptureImageCachePath(this.data.captureReview.imagePath)
              ? ""
              : this.data.captureReview.imagePath,
          }
        : null,
    });
    return true;
  },
  async restoreReviewImage() {
    const state = this.runtime;
    const review = this.data.captureReview;
    if (!review || review.imagePath) return;
    const capture = this.data.captures.find((item) => item.id === review.id);
    if (capture?.type !== "IMAGE") return;
    const generation = state.pictureGeneration;
    const owner = client.userId;
    try {
      const picture = await this.readHomeCaptureImage(review.id);
      if (
        picture &&
        !state.unloaded &&
        generation === state.pictureGeneration &&
        owner === client.userId &&
        state.pictureCacheEpoch === getCaptureImageCacheEpoch() &&
        this.data.captureReview?.id === review.id
      )
        this.updateData({ captureReview: { ...this.data.captureReview, imagePath: picture.path } });
    } catch {
      // Original text remains available if its optional image cannot be restored.
    }
  },
  async readHomeCaptureImage(id: string) {
    this.invalidateClearedPictures();
    const state = this.runtime;
    const owner = client.userId;
    const generation = state.pictureGeneration;
    if (!owner || state.unloaded) return null;
    if (state.pictureCache.has(id)) return state.pictureCache.get(id) ?? null;
    const existing = state.pictureFlights.get(id);
    if (existing) return existing;
    const flight = readCaptureImage(client, id).then((picture) => {
      if (
        state.unloaded ||
        state.pictureGeneration !== generation ||
        client.userId !== owner ||
        state.pictureCacheEpoch !== getCaptureImageCacheEpoch()
      ) {
        picture?.dispose();
        return null;
      }
      state.pictureCache.set(id, picture);
      return picture;
    });
    state.pictureFlights.set(id, flight);
    try {
      return await flight;
    } finally {
      if (state.pictureFlights.get(id) === flight) state.pictureFlights.delete(id);
    }
  },
  async loadRecommendationImage(target: string) {
    this.invalidateClearedPictures();
    const state = this.runtime;
    const owner = client.userId;
    const generation = state.pictureGeneration;
    const isCurrent = () =>
      !state.unloaded &&
      owner === client.userId &&
      generation === state.pictureGeneration &&
      state.pictureCacheEpoch === getCaptureImageCacheEpoch() &&
      target === this.data.recommendation?.targetLifeObjectId;
    try {
      const detail = await client.request(`/v1/life/${target}`, lifeDetailResponseSchema);
      if (!isCurrent()) return;
      const sources = detail.sources.filter((source) => source.sourceType === "CAPTURE");
      sources.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
      for (const source of sources.slice(0, 3)) {
        const image = await this.readHomeCaptureImage(source.sourceId);
        if (!isCurrent()) return;
        if (image) {
          this.updateData({ recommendationImage: image.path });
          return;
        }
      }
    } catch {
      // Source images are optional; recommendations remain readable if unavailable.
    }
  },
  async loadJournalImages() {
    this.invalidateClearedPictures();
    const state = this.runtime;
    const owner = client.userId;
    const generation = state.pictureGeneration;
    const captures = this.data.captures.filter((capture) => capture.type === "IMAGE").slice(0, 12);
    for (const capture of captures) {
      if (state.unloaded || client.userId !== owner || state.pictureGeneration !== generation)
        return;
      const card = this.data.cards.find((item) => item.id === capture.id);
      if (card?.imagePath) continue;
      try {
        const picture = await this.readHomeCaptureImage(capture.id);
        if (
          state.unloaded ||
          client.userId !== owner ||
          state.pictureGeneration !== generation ||
          state.pictureCacheEpoch !== getCaptureImageCacheEpoch()
        )
          return;
        if (picture)
          this.updateData({
            cards: this.data.cards.map((item) =>
              item.id === capture.id ? { ...item, imagePath: picture.path } : item,
            ),
          });
      } catch {
        // Keep the original text and status when a historic image cannot be read.
      }
    }
  },
  restoreRouteView() {
    const cached = routeCache.get(client.userId, this.data.recommendation?.targetLifeObjectId);
    this.updateData({
      routeView: cached?.view ?? null,
      departureReason: cached ? `上次查询：${cached.departureReason}` : "",
      canVerifyRoute:
        this.data.recommendation?.progress?.state !== "ACTIVE" &&
        (this.data.canVerifyRoute || !!cached),
    });
  },
  applyNow(result: NowResponse) {
    const selected = result.selectedDestination;
    const target = result.recommendation?.targetLifeObjectId;
    const mapDestination = selected && selected.lifeObjectId === target ? selected : null;
    if (target && result.selectedDestination !== undefined) {
      const cached = routeCache.get(client.userId, target);
      if (
        !mapDestination ||
        (cached?.view.destinationAddress &&
          cached.view.destinationAddress !== mapDestination.address)
      )
        routeCache.remove(client.userId ?? "", target);
    }
    this.updateData({
      recommendation: result.recommendation,
      question: result.question,
      sessionId: result.sessionId,
      decided: true,
      quietReason: result.quietReason ?? "",
      canVerifyRoute: needsRouteLocation(result),
      mapDestination,
      hasConfirmedDestination: !!mapDestination,
      routeNeedsEntrance:
        !!mapDestination &&
        result.routeCheck?.status === "UNAVAILABLE" &&
        ["NO_ROUTE", "INVALID_LOCATION"].includes(result.routeCheck.reason ?? ""),
    });
  },
  resetSessionContent() {
    const state = this.runtime;
    state.operationEpoch++;
    state.listGeneration++;
    state.captureCursor = null;
    state.feedbackReceipt = null;
    state.detailReturn = false;
    state.loadingLists = false;
    this.clearMapPicker();
    this.clearRequestLocation();
    state.lifeGeneration++;
    state.lifeStackFlight = null;
    state.ratingPending.clear();
    state.ratingFlights.clear();
    state.deletePending = null;
    state.deleteFlight = null;
    this.cleanupMedia();
    this.clearPictures();
    state.image = null;
    state.voiceSessionId = "";
    state.capturePending = state.nowPending = state.feedbackPending = null;
    state.nextDecisionContext = null;
    state.exclusions = [];
    state.pendingDecisionCaptureId = "";
    if (state.decisionRefresh) clearTimeout(state.decisionRefresh);
    state.answerPending = null;
    state.localCaptureId = state.voiceCardId = "";
    this.updateData({
      draft: "",
      busy: false,
      capturesHasMore: false,
      capturesLoading: false,
      capturesMoreError: "",
      notice: "",
      sections: [],
      captures: [],
      lifeCaptures: [],
      recommendation: null,
      sessionId: "",
      decided: false,
      sheet: false,
      conditionsSheet: false,
      routeSheet: false,
      locationSheet: false,
      captureReview: null,
      recommendationImage: "",
      inputMode: "menu",
      capturePermission: "",
      imagePath: "",
      imageLoading: false,
      voiceStatus: "idle",
      voicePartial: "",
      voiceRows: [],
      cards: [],
      question: null,
      canVerifyRoute: false,
      mapDestination: null,
      hasConfirmedDestination: false,
      routeNeedsEntrance: false,
      lifeStacks: [],
      lifeStacksLoaded: false,
      lifeStacksLoading: false,
      ratingBusy: [],
      stackDragging: false,
      voiceHolding: false,
      voiceCancelGesture: false,
    });
  },
  onLoad(options: Record<string, string | undefined> = {}) {
    this.runtime = createRuntime();
    const state = this.runtime;
    const info = wx.getWindowInfo();
    const menu = wx.getMenuButtonBoundingClientRect();
    this.updateData({
      ...(options.tab && ["now", "life", "journal"].includes(options.tab)
        ? { tab: options.tab }
        : {}),
      topInset: Math.max(menu.bottom + 16, info.statusBarHeight + 44),
      bottomInset: Math.max(16, info.screenHeight - (info.safeArea?.bottom ?? info.screenHeight)),
    });
    state.binding = createStoreBindings(this, {
      store: sessionStore,
      fields: ["userId"],
      actions: [],
    });
    state.binding.updateStoreBindings();
    state.pickerIdentityDispose = reaction(
      () => sessionStore.userId,
      () => {
        this.resetSessionContent();
        state.lastUser = client.userId ?? "";
        this.updateData({ reduceMotion: getAppearance(client).reduceMotion });
        if (!client.userId) this.updateData({ busy: false });
      },
    );
  },
  onShow() {
    const state = this.runtime;
    state.visible = true;
    state.pollCount = 0;
    this.updateData({ reduceMotion: getAppearance(client).reduceMotion });
    if (state.lastUser !== (client.userId ?? "")) {
      this.resetSessionContent();
      state.lastUser = client.userId ?? "";
    }
    const imagesCleared = this.invalidateClearedPictures();
    this.restoreRouteView();
    if (client.userId) {
      void this.checkOnboarding();
      if (imagesCleared) {
        const target = this.data.recommendation?.targetLifeObjectId;
        if (target) void this.loadRecommendationImage(target);
        void this.loadJournalImages();
        void this.restoreReviewImage();
      }
      void this.refreshLists();
      if (state.feedbackReceipt) void this.consumeFeedbackReceipt();
      else if (state.detailReturn && this.data.sessionId) void this.refreshCurrentSession();
      else void this.restoreActivePlan();
      if (this.data.tab === "life") void this.loadLifeStacks(true);
      if (state.deletePending || state.deleteFlight) void this.reconcileWishAfterReturn();
      state.detailReturn = false;
    }
  },
  async refreshCurrentSession() {
    const state = this.runtime;
    const owner = client.userId;
    const sessionId = this.data.sessionId;
    const operation = state.operationEpoch;
    if (!owner || !sessionId || this.data.busy || state.unloaded) return;
    const isCurrent = () =>
      !state.unloaded &&
      state.visible &&
      client.userId === owner &&
      operation === state.operationEpoch &&
      !this.data.busy &&
      sessionId === this.data.sessionId;
    try {
      const current = await client.request(`/v1/now/sessions/${sessionId}`, nowResponseSchema);
      if (!isCurrent()) return;
      const progress = current.recommendation?.progress?.state;
      if (
        progress === "COMPLETED" ||
        progress === "CANCELLED" ||
        (!current.recommendation && !current.question)
      ) {
        if (wx.getStorageSync(`${client.storageKey}:active:${owner}`) === sessionId)
          wx.removeStorageSync(`${client.storageKey}:active:${owner}`);
        this.updateData({
          recommendation: null,
          question: null,
          sessionId: "",
          decided: false,
          canVerifyRoute: false,
        });
      } else this.applyNow(current);
    } catch {
      if (isCurrent()) this.updateData({ error: "暂时无法更新这次建议，请重试。" });
    }
  },
  async restoreActivePlan() {
    const state = this.runtime;
    const operation = state.operationEpoch;
    const owner = client.userId;
    if (!owner || this.data.busy || this.data.sessionId) return;
    const key = `${client.storageKey}:active:${owner}`;
    const sessionId = wx.getStorageSync(key);
    if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(sessionId)) return;
    try {
      const result = await client.request(`/v1/now/sessions/${sessionId}`, nowResponseSchema);
      if (
        state.unloaded ||
        client.userId !== owner ||
        operation !== state.operationEpoch ||
        this.data.sessionId ||
        this.data.busy
      )
        return;
      if (result.recommendation?.progress?.state === "ACTIVE") {
        this.applyNow(result);
        this.updateData({ canVerifyRoute: false });
      } else wx.removeStorageSync(key);
    } catch {
      /* Preserve the session id for retry after a transient network failure. */
    }
  },
  onHide() {
    const state = this.runtime;
    state.visible = false;
    state.operationEpoch++;
    this.updateData({ busy: false });
    if (state.pickerContext && !state.pickerContext.nativeOpen && !state.pickerContext.picked)
      this.clearMapPicker();
    state.lifeGeneration++;
    state.lifeStackFlight = null;
    this.updateData({
      stackDragging: false,
      ratingBusy: [],
      lifeStacksLoading: false,
      lifeStacks: this.data.lifeStacks.map((group) => ({ ...group, loading: false })),
      ...(state.deleteFlight ? { busy: false } : {}),
    });
    if (state.mapRefreshGeneration != null) {
      state.mapRefreshGeneration = null;
      this.updateData({ mapPickerBusy: false, busy: false });
    }
    this.clearRequestLocation();
    // Camera/album pickers may hide the page; their explicit selection remains valid.
    if (!state.imagePickerOpen) this.cleanupMedia();
    if (state.poll) clearTimeout(state.poll);
    if (state.decisionRefresh) clearTimeout(state.decisionRefresh);
  },
  onUnload() {
    const state = this.runtime;
    state.pickerIdentityDispose?.();
    state.pickerIdentityDispose = null;
    this.clearMapPicker();
    this.clearRequestLocation();
    this.cleanupMedia();
    this.clearPictures();
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
    if (client.userId) void this.checkOnboarding();
  },
  async checkOnboarding() {
    const state = this.runtime;
    const owner = client.userId;
    if (!owner || state.onboardingCheckedUser === owner || state.onboardingFlight) return;
    state.onboardingFlight = true;
    try {
      const settings = await client.request("/v1/settings", userSettingsResponseSchema);
      if (state.unloaded || !state.visible || client.userId !== owner) return;
      state.onboardingCheckedUser = owner;
      this.updateData({ onboardingError: "" });
      if (!settings.onboardingCompleted)
        wx.navigateTo({
          url: "/pages/onboarding/index",
          fail: () => {
            state.onboardingCheckedUser = "";
            this.updateData({ onboardingError: "暂时无法打开首次设定，请重试。" });
          },
        });
    } catch {
      if (!state.unloaded && state.visible && client.userId === owner)
        this.updateData({ onboardingError: "首次设定暂时未能读取，可以重试或稍后在设置中填写。" });
    } finally {
      state.onboardingFlight = false;
    }
  },
  openPrivacy() {
    wx.openPrivacyContract({
      fail: () => this.updateData({ error: "暂时无法打开隐私说明，请稍后重试。" }),
    });
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
    const tab = event.currentTarget.dataset.tab;
    if (!["now", "journal", "life"].includes(tab)) return;
    this.updateData({ tab });
    if (client.userId && tab === "journal") void this.refreshLists();
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
    const id = event.currentTarget.dataset.id;
    if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) return;
    this.runtime.detailReturn = true;
    wx.navigateTo({
      url: `/pages/life-detail/index?id=${id}`,
      fail: () => this.updateData({ error: "暂时无法打开详情，请重试。" }),
    });
  },
  openSettings() {
    wx.navigateTo({ url: "/pages/settings/index" });
  },
  openSearch() {
    wx.navigateTo({ url: "/pages/life-list/index?mode=search" });
  },
  openNearby() {
    wx.navigateTo({ url: "/pages/life-list/index?mode=nearby" });
  },
  viewRecommendation() {
    const id = this.data.recommendation?.targetLifeObjectId;
    if (id) {
      this.runtime.detailReturn = true;
      wx.navigateTo({ url: `/pages/life-detail/index?id=${id}` });
    }
  },
  async viewCapture(event: WechatMiniprogram.TouchEvent) {
    this.invalidateClearedPictures();
    const card = this.data.cards.find((item) => item.id === event.currentTarget.dataset.id);
    if (!card) return;
    const capture = this.data.captures.find((item) => item.id === card.id);
    this.updateData({
      captureReview: {
        ...card,
        original:
          capture?.text ??
          card.original ??
          (card.id === this.runtime.localCaptureId || card.id === this.runtime.voiceCardId
            ? this.data.draft
            : ""),
      },
    });
    if (capture?.type === "IMAGE" && !card.imagePath) {
      const owner = client.userId;
      try {
        const picture = await this.readHomeCaptureImage(card.id);
        if (
          picture &&
          !this.runtime.unloaded &&
          client.userId === owner &&
          picture.cacheEpoch === getCaptureImageCacheEpoch() &&
          this.data.captureReview?.id === card.id
        )
          this.updateData({
            captureReview: { ...this.data.captureReview, imagePath: picture.path },
          });
      } catch {
        // Original text and the capture status remain available for review.
      }
    }
  },
  closeCaptureReview() {
    this.updateData({ captureReview: null });
  },
  previewCaptureImage() {
    const path = this.data.captureReview?.imagePath || this.data.imagePath;
    if (path) wx.previewImage({ current: path, urls: [path] });
  },
  openConditions() {
    if (this.data.busy || this.data.recommendation?.progress?.state === "ACTIVE") return;
    this.updateData({
      conditionsSheet: true,
      conditionGoingOut: "any",
      conditionMinutes: "any",
      conditionBudget: "any",
    });
  },
  closeConditions() {
    if (!this.data.busy) this.updateData({ conditionsSheet: false });
  },
  selectCondition(event: WechatMiniprogram.TouchEvent) {
    const { field, value } = event.currentTarget.dataset;
    if (field === "goingOut" && ["any", "yes", "no"].includes(value))
      this.updateData({ conditionGoingOut: value });
    if (field === "minutes" && ["any", "30", "120", "240"].includes(value))
      this.updateData({ conditionMinutes: value });
    if (field === "budget" && ["any", "10000", "0"].includes(value))
      this.updateData({ conditionBudget: value });
  },
  async applyConditions() {
    if (this.data.busy) return;
    const { conditionGoingOut, conditionMinutes, conditionBudget } = this.data;
    this.clearRequestLocation();
    this.runtime.nextDecisionContext = {
      ...(conditionGoingOut !== "any" ? { willingToGoOut: conditionGoingOut === "yes" } : {}),
      ...(conditionMinutes !== "any" ? { availableMinutes: Number(conditionMinutes) } : {}),
      ...(conditionBudget !== "any" ? { budgetMinor: Number(conditionBudget) } : {}),
    };
    this.updateData({ conditionsSheet: false });
    await this.decide();
  },
  async decideWithoutConditions() {
    if (this.data.busy) return;
    this.runtime.nextDecisionContext = null;
    this.updateData({ conditionsSheet: false });
    await this.decide();
  },
  openRouteSheet() {
    if (this.data.recommendation) this.updateData({ routeSheet: true });
  },
  closeRouteSheet() {
    if (!this.data.busy) this.updateData({ routeSheet: false });
  },
  openLocationSheet() {
    if (!this.data.busy) this.updateData({ locationSheet: true });
  },
  closeLocationSheet() {
    if (!this.data.busy) this.updateData({ locationSheet: false });
  },
  async confirmRouteLocation() {
    this.updateData({ locationSheet: false });
    if (this.data.busy) return;
    this.clearLocationChoices();
    await this.runRouteVerification();
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
      routeCache.remove(owner, target);
      state.exclusions = [...state.exclusions, target].slice(-100);
      wx.removeStorageSync(`${client.storageKey}:active:${owner}`);
      this.updateData({
        recommendation: null,
        question: null,
        sessionId: "",
        decided: false,
        canVerifyRoute: false,
        notice: "已删除这条记录。",
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
    state.imagePickerOpen = false;
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
    this.updateData({ inputMode: "image", imageLoading: true, error: "", capturePermission: "" });
    try {
      const caps = await client.request("/v1/media/capabilities", capabilitiesSchema);
      if (generation !== state.mediaGeneration || state.unloaded) return;
      if (!caps.image) {
        this.updateData({ error: "图片理解尚未配置。可以先留下文字，配置后再添加图片。" });
        return;
      }
      state.imagePickerOpen = true;
      const image = await chooseCaptureImage();
      if (generation !== state.mediaGeneration || state.unloaded || !image) return;
      state.image = image;
      state.voiceSessionId = "";
      this.updateData({ imagePath: image.path });
    } catch (error) {
      if (generation === state.mediaGeneration)
        this.updateData({
          error: userMessage(error),
          capturePermission:
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "IMAGE_PERMISSION_REQUIRED"
              ? "image"
              : "",
        });
    } finally {
      if (generation === state.mediaGeneration) {
        state.imagePickerOpen = false;
        this.updateData({ imageLoading: false });
      }
    }
  },
  openCapturePermissions() {
    const state = this.runtime;
    const owner = client.userId;
    const generation = state.mediaGeneration;
    if (
      !owner ||
      this.data.busy ||
      !this.data.capturePermission ||
      typeof wx.openSetting !== "function"
    )
      return;
    wx.openSetting({
      success: () => {
        if (!state.unloaded && owner === client.userId && generation === state.mediaGeneration)
          this.updateData({
            capturePermission: "",
            error: "",
            notice: "已返回权限设置，可以重新选择图片或按住说话。",
          });
      },
      fail: () => {
        if (!state.unloaded && owner === client.userId && generation === state.mediaGeneration)
          this.updateData({ error: "暂时无法打开微信权限设置，请稍后重试。" });
      },
    });
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
      capturePermission: "",
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
            this.updateData({
              error: userMessage({ code: "VOICE_PERMISSION_REQUIRED" }),
              capturePermission: "scope.record",
            });
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
        this.updateData({
          voiceStatus: "idle",
          voiceHolding: false,
          error: userMessage(error),
          capturePermission:
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "VOICE_PERMISSION_REQUIRED"
              ? "scope.record"
              : "",
        });
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
    this.updateData({ draft: event.detail.value.slice(0, 5000) });
  },
  async saveCapture() {
    const state = this.runtime;
    if (
      !client.userId ||
      state.unloaded ||
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
    const previousLocalId = state.localCaptureId;
    if (state.capturePending?.signature !== signature)
      state.localCaptureId = state.voiceCardId || "sending-" + Date.now();
    const localId = state.localCaptureId;
    const generation = state.mediaGeneration;
    const owner = client.userId;
    const operation = state.operationEpoch;
    const isCurrent = () =>
      !state.unloaded &&
      client.userId === owner &&
      generation === state.mediaGeneration &&
      operation === state.operationEpoch;
    const sending: HomeCard = {
      id: localId,
      title: image ? "留下一张图片" : "留下一个念头",
      summary: "正在把它收好。",
      phase: "SENDING",
      imagePath: image?.path ?? "",
      statusLabel: "正在收纳",
      original: input.data.text ?? "",
    };
    this.updateData({
      busy: true,
      sheet: false,
      tab: "now",
      error: "",
      cards: [
        sending,
        ...this.data.cards.filter(
          (card) =>
            card.id !== localId && card.id !== previousLocalId && card.id !== state.voiceCardId,
        ),
      ],
    });
    try {
      if (state.capturePending?.signature !== signature) {
        const key = await client.newKey();
        if (!isCurrent()) return;
        state.capturePending = { signature, key };
      }
      if (!isCurrent()) return;
      const receipt = await client.request("/v1/captures", captureAcceptedSchema, {
        method: "POST",
        data: input.data,
        key: state.capturePending.key,
      });
      if (!isCurrent()) return;
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
      if (isCurrent())
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
      if (!state.unloaded && client.userId === owner && operation === state.operationEpoch)
        this.updateData({ busy: false });
    }
  },
  renderCaptures(captures: CaptureResponse[]) {
    const ids = new Set(captures.map((item) => item.id));
    const local = this.data.cards.filter(
      (card) =>
        !ids.has(card.id) &&
        ["TRANSCRIBING", "SENDING", "FAILED_LOCAL", "UPLOADED", "PROCESSING"].includes(card.phase),
    );
    this.updateData({
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
    void this.loadJournalImages();
  },
  async loadMoreCaptures() {
    const state = this.runtime;
    const cursor = state.captureCursor;
    const owner = client.userId;
    if (!owner || !cursor || state.loadingLists || this.data.capturesLoading || state.unloaded)
      return;
    const generation = state.listGeneration;
    const isCurrent = () =>
      !state.unloaded && owner === client.userId && generation === state.listGeneration;
    this.updateData({ capturesLoading: true, capturesMoreError: "" });
    try {
      const page = await client.request(
        `/v1/captures/page?cursor=${encodeURIComponent(cursor)}`,
        capturePageResponseSchema,
      );
      if (!isCurrent()) return;
      const seen = new Set(this.data.captures.map((item) => item.id));
      this.renderCaptures([
        ...this.data.captures,
        ...page.items.filter((item) => !seen.has(item.id)),
      ]);
      state.captureCursor = page.nextCursor;
      this.updateData({ capturesHasMore: !!page.nextCursor });
    } catch (error) {
      if (isCurrent()) this.updateData({ capturesMoreError: userMessage(error) });
    } finally {
      if (isCurrent()) this.updateData({ capturesLoading: false });
    }
  },
  async refreshLists(resetPages = true) {
    const state = this.runtime;
    if (!client.userId || state.loadingLists || state.unloaded) return;
    state.loadingLists = true;
    const owner = client.userId;
    const generation = ++state.listGeneration;
    this.updateData({ capturesLoading: false, capturesMoreError: "" });
    if (state.poll) clearTimeout(state.poll);
    try {
      const [sections, page] = await Promise.all([
        client.request("/v1/life/sections", lifeSectionsResponseSchema),
        client.request("/v1/captures/page", capturePageResponseSchema),
      ]);
      if (state.unloaded || client.userId !== owner || generation !== state.listGeneration) return;
      const captures = page.items;
      if (resetPages) state.captureCursor = page.nextCursor;
      this.updateData({ capturesHasMore: !!state.captureCursor });
      const readyForDecision = captures.some(
        (item) => item.id === state.pendingDecisionCaptureId && item.status === "READY",
      );
      this.updateData({
        sections: sections.map((section) => ({
          ...section,
          items: section.items.map((item) => ({
            ...item,
            kindLabel:
              kindOptions.find((option) => option.value === item.kind)?.label ?? "生活记录",
          })),
        })),
      });
      const ids = new Set(captures.map((item) => item.id));
      this.renderCaptures(
        resetPages
          ? captures
          : [...captures, ...this.data.captures.filter((item) => !ids.has(item.id))],
      );
      if (this.data.tab === "life" && (readyForDecision || !this.data.lifeStacksLoaded))
        void this.loadLifeStacks(readyForDecision);
      if (readyForDecision) this.refreshDecisionAfterCapture();
    } catch (error) {
      if (!state.unloaded && client.userId === owner)
        this.updateData({ error: userMessage(error) });
    } finally {
      if (generation === state.listGeneration) state.loadingLists = false;
      if (!state.unloaded && state.visible && client.userId && client.userId !== owner)
        void this.refreshLists();
      const pending = this.data.cards.some((card) =>
        ["UPLOADED", "PROCESSING"].includes(card.phase),
      );
      if (pending && state.visible && !state.unloaded && client.userId) {
        const delays = [700, 1000, 1500, 2500, 4000, 6000, 10000, 15000];
        const delay =
          state.pollCount > 20 ? 30000 : delays[Math.min(state.pollCount, delays.length - 1)]!;
        state.pollCount++;
        state.poll = setTimeout(() => {
          void this.refreshLists(false);
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
    if (this.data.sessionId && !this.data.busy) void this.refreshCurrentSession();
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
    const state = this.runtime;
    const owner = client.userId;
    const operation = state.operationEpoch;
    const isCurrent = () =>
      !state.unloaded && owner === client.userId && operation === state.operationEpoch;
    if (!owner || state.unloaded || this.data.busy || this.data.voiceStatus === "finishing") return;
    if (state.feedbackPending) {
      this.updateData({ error: "上次反馈尚未确认，请先重试原来的选择。" });
      return;
    }
    this.updateData({ busy: true, error: "", notice: "" });
    try {
      await this.requestDecision();
    } catch (error) {
      if (isCurrent()) this.updateData({ error: userMessage(error) });
    } finally {
      if (isCurrent()) this.updateData({ busy: false });
    }
  },
  clearRequestLocation() {
    const state = this.runtime;
    state.locationGeneration++;
    state.nowPending = null;
    state.requestLocation = null;
    this.clearLocationChoices();
    if (this.data.routeLocationBusy)
      this.updateData({ routeLocationBusy: false, busy: false, routeStatus: "" });
  },
  clearMapPicker() {
    this.runtime.pickerEpoch++;
    this.runtime.pickerContext = null;
    this.runtime.mapRefreshGeneration = null;
    this.updateData({
      mapSelection: null,
      mapPickerBusy: false,
      ...(this.data.mapPickerBusy ? { busy: false } : {}),
    });
  },
  cancelMapSelection() {
    if (this.data.busy) return;
    this.clearMapPicker();
    this.updateData({ notice: "已取消地点选择，原建议保留。", error: "" });
  },
  async chooseDestination() {
    const state = this.runtime;
    const owner = client.userId;
    const target = this.data.recommendation?.targetLifeObjectId;
    if (
      state.unloaded ||
      this.data.busy ||
      !owner ||
      !target ||
      this.data.recommendation?.progress?.state === "ACTIVE"
    )
      return;
    this.clearMapPicker();
    this.clearLocationChoices();
    const epoch = state.pickerEpoch;
    const context: PickerContext = {
      owner,
      target,
      intentToken: "",
      expiresAt: 0,
      picked: null,
      pending: null,
      nativeOpen: false,
    };
    state.pickerContext = context;
    const isCurrent = () =>
      !state.unloaded &&
      this.runtime === state &&
      state.pickerEpoch === epoch &&
      state.pickerContext === context &&
      client.userId === owner &&
      this.data.recommendation?.targetLifeObjectId === target;
    this.updateData({ mapPickerBusy: true, busy: true, error: "", notice: "" });
    try {
      const key = await client.newKey();
      if (!isCurrent()) return;
      const intent = await client.request(
        "/v1/locations/picker-intents",
        locationPickerIntentResponseSchema,
        {
          method: "POST",
          key,
          data: locationPickerIntentRequestSchema.parse({ lifeObjectId: target }),
        },
      );
      if (!isCurrent()) return;
      if (intent.lifeObjectId !== target) throw new Error("Invalid picker target");
      context.intentToken = intent.intentToken;
      context.expiresAt = Date.parse(intent.expiresAt);
      if (context.expiresAt <= Date.now()) {
        this.clearMapPicker();
        this.updateData({ error: "这次地点选择已失效，请重新打开微信地图选择。" });
        return;
      }
      if (typeof wx.chooseLocation !== "function") {
        this.clearMapPicker();
        this.updateData({ error: "当前微信暂不支持地图选点，请更新微信后重新选择。" });
        return;
      }
      // The native picker may hide this page. Its intent is independent of GPS/choice epochs.
      context.nativeOpen = true;
      wx.chooseLocation({
        success: (point) => {
          if (!isCurrent() || context.picked) return;
          if (context.expiresAt <= Date.now()) {
            this.clearMapPicker();
            this.updateData({ error: "这次地点选择已失效，请重新打开微信地图选择。" });
            return;
          }
          const picked = {
            name: typeof point.name === "string" ? point.name.trim() : "",
            address: typeof point.address === "string" ? point.address.trim() : "",
            latitude: point.latitude,
            longitude: point.longitude,
          };
          const parsed = locationMapSelectRequestSchema.safeParse({
            lifeObjectId: target,
            intentToken: context.intentToken,
            name: picked.name,
            address: picked.address,
            location: {
              latitude: picked.latitude,
              longitude: picked.longitude,
              coordinateSystem: "GCJ02",
            },
          });
          if (!parsed.success) {
            this.clearMapPicker();
            this.updateData({ error: "微信地图没有返回完整有效的地点信息，请重新选择。" });
            return;
          }
          context.picked = picked;
          context.nativeOpen = false;
          this.updateData({
            mapSelection: { name: picked.name, address: picked.address },
            mapPickerBusy: false,
            busy: false,
          });
        },
        fail: (error) => {
          if (!isCurrent() || context.picked) return;
          this.clearMapPicker();
          this.updateData(
            /cancel|取消/i.test(error.errMsg)
              ? { notice: "已取消地点选择，原建议保留。", error: "" }
              : { error: pickerMessage(error) },
          );
        },
      });
    } catch (error) {
      if (!isCurrent()) return;
      this.clearMapPicker();
      this.updateData({ error: pickerMessage(error) });
    }
  },
  async confirmMapSelection() {
    const state = this.runtime;
    const context = state.pickerContext;
    const epoch = state.pickerEpoch;
    if (state.unloaded || this.data.busy || !context?.picked) return;
    const isCurrent = () =>
      !state.unloaded &&
      this.runtime === state &&
      state.pickerEpoch === epoch &&
      state.pickerContext === context &&
      client.userId === context.owner &&
      this.data.recommendation?.targetLifeObjectId === context.target;
    if (!isCurrent()) return;
    if (context.expiresAt <= Date.now()) {
      this.clearMapPicker();
      this.updateData({ error: "这次地点选择已失效，请重新打开微信地图选择。" });
      return;
    }
    this.updateData({ mapPickerBusy: true, busy: true, error: "", notice: "" });
    try {
      const picked = context.picked;
      const data = locationMapSelectRequestSchema.parse({
        lifeObjectId: context.target,
        intentToken: context.intentToken,
        name: picked.name,
        address: picked.address,
        location: {
          latitude: picked.latitude,
          longitude: picked.longitude,
          coordinateSystem: "GCJ02",
        },
      });
      if (!context.pending)
        context.pending = { signature: JSON.stringify(data), key: await client.newKey() };
      if (!isCurrent()) return;
      // A lost receipt may still have changed the saved destination. Do not reuse its old route.
      routeCache.remove(context.owner, context.target);
      this.updateData({ routeView: null, departureReason: "" });
      const result = await client.request(
        "/v1/locations/map-select",
        locationMapSelectResponseSchema,
        { method: "POST", data, key: context.pending.key },
      );
      if (!isCurrent()) return;
      if (result.lifeObjectId !== context.target) throw new Error("Invalid selected target");
      this.clearRequestLocation();
      state.answerPending = state.feedbackPending = null;
      this.clearMapPicker();
      this.updateData({
        routeView: null,
        departureReason: "",
        mapDestination: {
          lifeObjectId: context.target,
          name: picked.name,
          address: picked.address,
          source: "USER_SELECTED_MAP",
        },
        hasConfirmedDestination: true,
        question: null,
        sessionId: "",
        canVerifyRoute: true,
        mapPickerBusy: true,
        busy: true,
      });
      const generation = state.locationGeneration;
      state.mapRefreshGeneration = generation;
      const refreshCurrent = () =>
        !state.unloaded &&
        this.runtime === state &&
        client.userId === context.owner &&
        state.locationGeneration === generation &&
        state.mapRefreshGeneration === generation &&
        this.data.recommendation?.targetLifeObjectId === context.target;
      try {
        // Refresh the object version without requesting current device coordinates.
        await this.requestDecision(context.target);
        if (refreshCurrent())
          this.updateData({
            canVerifyRoute: true,
            notice: "已保存你选择的位置。点击核对路程后，再查询当前位置与路线。",
          });
      } catch (error) {
        if (refreshCurrent())
          this.updateData({
            canVerifyRoute: true,
            error: `地点已保存；更新建议暂时失败。${userMessage(error)}`,
          });
      } finally {
        if (refreshCurrent()) {
          state.mapRefreshGeneration = null;
          this.updateData({ mapPickerBusy: false, busy: false });
        }
      }
    } catch (error) {
      if (!isCurrent()) return;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (/LOCATION_.*(?:EXPIRED|INVALID|OBJECT_CHANGED)/.test(code)) this.clearMapPicker();
      this.updateData({ error: pickerMessage(error) });
    } finally {
      if (isCurrent()) this.updateData({ mapPickerBusy: false, busy: false });
    }
  },
  async verifyCurrentRoute() {
    const state = this.runtime;
    const owner = client.userId;
    const target = this.data.recommendation?.targetLifeObjectId;
    const operation = state.operationEpoch;
    if (
      !owner ||
      !target ||
      state.unloaded ||
      this.data.busy ||
      !this.data.canVerifyRoute ||
      !this.data.hasConfirmedDestination ||
      this.data.recommendation?.progress?.state === "ACTIVE"
    )
      return;
    const isCurrent = () =>
      !state.unloaded &&
      owner === client.userId &&
      target === this.data.recommendation?.targetLifeObjectId &&
      operation === state.operationEpoch;
    this.updateData({ busy: true, error: "" });
    let allowed = false;
    try {
      const settings = await client.request("/v1/settings", userSettingsResponseSchema);
      if (!isCurrent()) return;
      allowed = settings.privacy.useLocation;
      if (!allowed) this.updateData({ locationSheet: true });
    } catch (error) {
      if (isCurrent()) this.updateData({ error: userMessage(error) });
      return;
    } finally {
      if (isCurrent()) this.updateData({ busy: false });
    }
    if (!isCurrent() || !allowed) return;
    this.clearLocationChoices();
    await this.runRouteVerification();
  },
  clearLocationChoices() {
    this.runtime.choiceEpoch++;
    this.runtime.choiceContext = null;
    if (this.runtime.choiceOriginTimer) clearTimeout(this.runtime.choiceOriginTimer);
    this.runtime.choiceOriginTimer = undefined;
    this.updateData({
      locationChoices: [],
      locationChoiceBusy: false,
      ...(this.data.locationChoiceBusy ? { busy: false, routeStatus: "" } : {}),
    });
  },
  cancelLocationChoices() {
    if (this.data.locationChoiceBusy) return;
    this.clearLocationChoices();
    this.updateData({ notice: "已取消地点选择，原建议保留。", error: "" });
  },
  async loadLocationChoices(origin: ChoiceOrigin) {
    const state = this.runtime;
    const epoch = state.choiceEpoch;
    const isCurrent = () =>
      !state.unloaded &&
      this.runtime === state &&
      state.choiceEpoch === epoch &&
      state.locationGeneration === origin.generation &&
      client.userId === origin.owner &&
      this.data.recommendation?.targetLifeObjectId === origin.target;
    this.updateData({ routeStatus: "正在查找可能的地点…" });
    const key = await client.newKey();
    if (!isCurrent()) return false;
    const result = await client.request("/v1/locations/choices", locationChoicesResponseSchema, {
      method: "POST",
      key,
      data: locationChoicesRequestSchema.parse({
        lifeObjectId: origin.target,
      }),
    });
    if (!isCurrent() || result.lifeObjectId !== origin.target) return false;
    if (!result.choices.length) {
      this.updateData({
        error: routeUnavailableMessage(result.reason ?? "DESTINATION_UNRESOLVED"),
      });
      return true;
    }
    state.choiceContext = {
      ...origin,
      choices: result.choices,
      choiceExpiresAt: Date.parse(result.expiresAt),
      pending: null,
    };
    const context = state.choiceContext;
    state.choiceOriginTimer = setTimeout(
      () => {
        if (state.choiceContext === context) context.location = null;
        state.choiceOriginTimer = undefined;
      },
      Math.max(0, origin.expiresAt - Date.now()),
    );
    this.updateData({
      locationChoices: result.choices.map(({ token: _token, ...choice }, index) => ({
        ...choice,
        choiceKey: `${choice.city}:${index}`,
      })),
      error: "",
      notice: "",
    });
    return true;
  },
  async selectLocationChoice(event: WechatMiniprogram.TouchEvent) {
    const state = this.runtime;
    const context = state.choiceContext;
    const epoch = state.choiceEpoch;
    const index = Number(event.currentTarget.dataset.index);
    if (!context || this.data.busy || !Number.isInteger(index) || !context.choices[index]) return;
    const isCurrent = () =>
      !state.unloaded &&
      this.runtime === state &&
      state.choiceEpoch === epoch &&
      state.choiceContext === context &&
      state.locationGeneration === context.generation &&
      client.userId === context.owner &&
      this.data.recommendation?.targetLifeObjectId === context.target;
    if (!isCurrent()) return;
    if (context.choiceExpiresAt <= Date.now()) {
      this.clearLocationChoices();
      this.updateData({ error: "地点选项已过期，请重新核对地点后再选。", canVerifyRoute: true });
      return;
    }
    if (context.pending && context.pending.index !== index) {
      this.updateData({ error: "上次选择尚未确认，请先重试原来的地点。" });
      return;
    }
    this.updateData({ locationChoiceBusy: true, busy: true, error: "", notice: "" });
    try {
      const data = locationSelectRequestSchema.parse({
        lifeObjectId: context.target,
        choiceToken: context.choices[index]!.token,
      });
      if (!context.pending)
        context.pending = { index, signature: JSON.stringify(data), key: await client.newKey() };
      if (!isCurrent()) return;
      const result = await client.request("/v1/locations/select", locationSelectResponseSchema, {
        method: "POST",
        key: context.pending.key,
        data,
      });
      if (!isCurrent() || result.lifeObjectId !== context.target) return;
      routeCache.remove(context.owner, context.target);
      state.nowPending = state.answerPending = state.feedbackPending = null;
      this.clearLocationChoices();
      this.updateData({ routeView: null, departureReason: "", canVerifyRoute: true });
      // A fresh Now request must use the selected object's new version.
      await this.runRouteVerification(context);
    } catch (error) {
      if (!isCurrent()) return;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (
        ["LOCATION_CHOICES_EXPIRED", "LOCATION_CHOICE_INVALID", "LOCATION_OBJECT_CHANGED"].includes(
          code,
        )
      )
        this.clearLocationChoices();
      this.updateData({ error: locationChoiceMessage(error), canVerifyRoute: true });
    } finally {
      if (isCurrent()) this.updateData({ locationChoiceBusy: false, busy: false });
    }
  },
  async runRouteVerification(reuse?: ChoiceOrigin) {
    const state = this.runtime;
    if (
      state.unloaded ||
      this.data.busy ||
      this.data.voiceStatus === "finishing" ||
      !this.data.canVerifyRoute ||
      !this.data.hasConfirmedDestination ||
      this.data.recommendation?.progress?.state === "ACTIVE"
    )
      return;
    const owner = client.userId;
    const focusObjectId = this.data.recommendation?.targetLifeObjectId;
    if (!owner || !focusObjectId) return;
    const reusedLocation =
      reuse &&
      reuse.owner === owner &&
      reuse.target === focusObjectId &&
      reuse.generation === state.locationGeneration &&
      reuse.expiresAt > Date.now()
        ? reuse.location
        : null;
    const generation = ++state.locationGeneration;
    const isCurrent = () =>
      !state.unloaded &&
      this.runtime === state &&
      state.locationGeneration === generation &&
      client.userId === owner &&
      this.data.recommendation?.targetLifeObjectId === focusObjectId;
    this.updateData({
      routeLocationBusy: true,
      busy: true,
      routeStatus: "正在获取当前位置…",
      error: "",
      notice: "",
    });
    try {
      if (reusedLocation) state.requestLocation = reusedLocation;
      else {
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
          expiresAt: new Date(observedAt + 2 * 60 * 1000).toISOString(),
        };
      }
      state.nowPending = state.answerPending = null;
      this.updateData({ routeStatus: "正在查询去程和返程…" });
      const result = await this.requestDecision(focusObjectId);
      if (!isCurrent() || !result) return;
      if (result.routeCheck?.status === "READY") {
        const freshRouteView =
          result.recommendation?.targetLifeObjectId === focusObjectId
            ? createRouteView(result.routeCheck)
            : null;
        if (freshRouteView && owner && focusObjectId)
          routeCache.set(owner, focusObjectId, {
            view: freshRouteView,
            departureReason: departureMessage(result),
          });
        const cached = routeCache.get(owner, result.recommendation?.targetLifeObjectId);
        const routeView = freshRouteView ?? cached?.view ?? null;
        this.updateData({
          routeView,
          departureReason: freshRouteView
            ? departureMessage(result)
            : cached
              ? `上次查询：${cached.departureReason}`
              : "",
          notice: routeView
            ? ""
            : departureMessage(result).startsWith("腾讯地图")
              ? departureMessage(result)
              : `腾讯地图已计算到该位置的往返路线。${departureMessage(result)}`,
        });
      } else {
        const reason = result.routeCheck?.reason;
        if (isCurrent()) this.updateData({ error: routeUnavailableMessage(reason) });
      }
    } catch (error) {
      if (isCurrent()) this.updateData({ error: userMessage(error) });
    } finally {
      if (isCurrent()) {
        // Device coordinates and idempotency signatures live only during this query.
        state.requestLocation = null;
        state.nowPending = null;
        this.updateData({ routeLocationBusy: false, busy: false, routeStatus: "" });
      }
    }
  },
  openRouteDestination() {
    const route = this.data.routeView;
    if (!route || this.runtime.unloaded || this.data.busy) return;
    try {
      wx.openLocation({
        latitude: route.latitude,
        longitude: route.longitude,
        name: route.destinationLabel,
        scale: 16,
        fail: () => this.updateData({ error: "暂时无法打开微信地图，请稍后再试。" }),
      });
    } catch {
      this.updateData({ error: "暂时无法打开微信地图，请稍后再试。" });
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
      context: {
        ...(state.requestLocation ? { location: state.requestLocation, willingToGoOut: true } : {}),
        ...state.nextDecisionContext,
      },
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
    state.nextDecisionContext = null;
    state.feedbackPending = null;
    this.applyNow(result);
    return result;
  },
  async answerQuestion(event: WechatMiniprogram.TouchEvent) {
    const state = this.runtime;
    const question = this.data.question;
    const owner = client.userId;
    const sessionId = this.data.sessionId;
    const operation = state.operationEpoch;
    const isCurrent = () =>
      !state.unloaded &&
      owner === client.userId &&
      operation === state.operationEpoch &&
      sessionId === this.data.sessionId;
    if (this.data.busy || !question) return;
    const optionId = event.currentTarget.dataset.option;
    if (!question.options.some((option) => option.id === optionId)) return;
    const data = { questionId: question.id, optionId };
    const signature = JSON.stringify(data);
    this.updateData({ busy: true, error: "" });
    try {
      if (state.answerPending?.signature !== signature) {
        const key = await client.newKey();
        if (!isCurrent()) return;
        state.answerPending = { signature, key };
      }
      const result = await client.request(
        `/v1/now/sessions/${sessionId}/answers`,
        nowResponseSchema,
        { method: "POST", data, key: state.answerPending.key },
      );
      if (!isCurrent()) return;
      state.answerPending = null;
      this.applyNow(result);
    } catch (error) {
      if (!isCurrent()) return;
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
      if (isCurrent()) this.updateData({ busy: false });
    }
  },
  async consumeFeedbackReceipt() {
    const state = this.runtime;
    const receipt = state.feedbackReceipt;
    if (!receipt || receipt.owner !== client.userId || state.unloaded) return;
    const operation = state.operationEpoch;
    const isCurrent = () =>
      !state.unloaded && receipt.owner === client.userId && operation === state.operationEpoch;
    state.feedbackReceipt = null;
    const { eventType, result, recommendation, sessionId, target } = receipt;
    const marker = `${client.storageKey}:active:${receipt.owner}`;
    this.updateData({ busy: true });
    try {
      if (eventType === "ACCEPT" && recommendation.plan && result.progress) {
        wx.setStorageSync(marker, sessionId);
        this.updateData({
          recommendation: { ...recommendation, progress: result.progress },
          notice: "已开始，实际用时会记录下来。",
        });
        const current = await client.request(`/v1/now/sessions/${sessionId}`, nowResponseSchema);
        if (isCurrent() && this.data.sessionId === sessionId && current.recommendation)
          this.applyNow(current);
        return;
      }
      wx.removeStorageSync(marker);
      this.updateData({ recommendation: null, question: null, sessionId: "", decided: false });
      if (eventType === "COMPLETE") {
        const seconds = result.progress?.elapsedSeconds;
        this.updateData({
          notice:
            seconds == null
              ? "这一步完成了。"
              : `这一步完成了，${seconds < 60 ? "用时不到 1 分钟" : `用了 ${Math.ceil(seconds / 60)} 分钟`}。`,
        });
        void this.refreshLists();
      } else if (eventType === "REJECT") this.updateData({ notice: "已结束这次安排。" });
      else if (eventType === "SKIP") {
        state.exclusions = [...state.exclusions, target].slice(-100);
        await this.requestDecision();
      } else this.updateData({ notice: "记下了，按自己的节奏开始吧。" });
    } catch (error) {
      if (isCurrent()) this.updateData({ error: userMessage(error) });
    } finally {
      if (isCurrent()) this.updateData({ busy: false });
    }
  },
  async feedback(event: WechatMiniprogram.TouchEvent) {
    const state = this.runtime;
    const owner = client.userId;
    const sessionId = this.data.sessionId;
    const recommendation = this.data.recommendation;
    const operation = state.operationEpoch;
    const isCurrent = () =>
      !state.unloaded &&
      owner === client.userId &&
      operation === state.operationEpoch &&
      sessionId === this.data.sessionId;
    if (!owner || state.unloaded || this.data.busy || !recommendation || !sessionId) return;
    const eventType = event.currentTarget.dataset.type as "ACCEPT" | "SKIP" | "COMPLETE" | "REJECT";
    if (!["ACCEPT", "SKIP", "COMPLETE", "REJECT"].includes(eventType)) return;
    this.updateData({ busy: true, error: "" });
    try {
      const signature = sessionId + ":" + eventType;
      if (state.feedbackPending && state.feedbackPending.signature !== signature) {
        this.updateData({ error: "上次反馈尚未确认，请先重试原来的选择。" });
        return;
      }
      if (!state.feedbackPending) {
        const key = await client.newKey();
        const clientEventId = await client.newKey();
        if (!isCurrent()) return;
        state.feedbackPending = { signature, key, clientEventId };
      }
      const pending = state.feedbackPending;
      const data = createFeedbackRequestSchema.parse({
        eventType,
        clientEventId: pending.clientEventId,
      });
      const result = await client.request(
        `/v1/now/sessions/${sessionId}/feedback`,
        feedbackAcceptedSchema,
        { method: "POST", data, key: pending.key },
      );
      if (state.unloaded || owner !== client.userId || sessionId !== this.data.sessionId) return;
      if (state.feedbackPending === pending) state.feedbackPending = null;
      state.feedbackReceipt = {
        owner,
        sessionId,
        target: recommendation.targetLifeObjectId,
        eventType,
        recommendation,
        result,
      };
      // A successful hidden write is reconciled on return without posting it again.
      if (!isCurrent()) {
        if (state.visible) void this.consumeFeedbackReceipt();
        return;
      }
      await this.consumeFeedbackReceipt();
    } catch (error) {
      if (isCurrent()) this.updateData({ error: userMessage(error) });
    } finally {
      if (isCurrent()) this.updateData({ busy: false });
    }
  },
});
