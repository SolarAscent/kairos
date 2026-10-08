import "../../lib/zod-runtime";
import { reaction } from "mobx-miniprogram";
import { z } from "zod";
import {
  captureResponseSchema,
  lifeDeletedSchema,
  lifeRatingAcceptedSchema,
  lifeUpdatedSchema,
  patchLifeObjectRequestSchema,
  ticketVerificationRequestSchema,
  reminderSubscriptionRequestSchema,
  uuidSchema,
  locationPickerIntentRequestSchema,
  locationPickerIntentResponseSchema,
  locationMapSelectRequestSchema,
  locationMapSelectResponseSchema,
  type LocationMapSelectRequest,
} from "@life/contracts";
import { getAppearance } from "../../lib/appearance";
import type { AppServices } from "../../lib/session";
import { readCaptureImage } from "../../lib/capture-image";
import { ClientError } from "../../lib/client";
import { userMessage } from "../../lib/errors";
import {
  detailResponseSchema,
  displayDetail,
  uiCapabilitiesSchema,
  type LifeDetail,
} from "../../lib/life-detail";
const { client, routeCache, sessionStore } = getApp<{ globalData: AppServices }>().globalData;
function runtime() {
  return {
    identityDispose: undefined as (() => void) | undefined,
    owner: client.userId,
    hidden: false,
    unloaded: false,
    generation: 0,
    sourceGeneration: 0,
    sourceId: "",
    imageDispose: undefined as (() => void) | undefined,
    sourceImageDispose: undefined as (() => void) | undefined,
    id: "",
    pickerEpoch: 0,
    pickerContext: null as {
      intentToken: string;
      expiresAt: number;
      picked: LocationMapSelectRequest | null;
    } | null,
    flights: new Set<string>(),
    pending: new Map<string, { signature: string; key: string }>(),
  };
}
function data() {
  return {
    topInset: 92,
    bottomInset: 24,
    loggedIn: Boolean(client.userId),
    reduceMotion: getAppearance(client).reduceMotion,
    loading: false,
    error: "",
    detail: null as LifeDetail | null,
    view: null as ReturnType<typeof displayDetail> | null,
    busy: false,
    editing: false,
    draftTitle: "",
    draftSummary: "",
    statusOptions: ["等待发生", "已经发生", "归档"],
    statusIndex: 0,
    myRating: "NONE",
    sourceOpen: false,
    sourceLoading: false,
    sourceText: "",
    sourceTitle: "",
    sourceError: "",
    capabilityMessage: "",
    ticketVerificationAvailable: false,
    reminderDeliveryAvailable: false,
    storeEditing: false,
    storeQuery: "",
    mapPickerBusy: false,
    mapSelection: null as { name: string; address: string } | null,
    locationNotice: "",
    heroImagePath: "",
    sourceImagePath: "",
  };
}
Page({
  data: data(),
  runtime: null as unknown as ReturnType<typeof runtime>,
  updateData(values: Partial<ReturnType<typeof data>>) {
    if (!this.runtime.unloaded) this.setData(values);
  },
  current(state: ReturnType<typeof runtime>, generation = state.generation) {
    return (
      this.runtime === state &&
      !state.hidden &&
      !state.unloaded &&
      state.generation === generation &&
      Boolean(state.owner) &&
      state.owner === client.userId
    );
  },
  observeIdentity() {
    const state = this.runtime;
    state.identityDispose = reaction(
      () => sessionStore.userId,
      () => {
        if (this.runtime === state && !state.unloaded) this.syncOwner();
      },
    );
  },
  syncOwner() {
    const state = this.runtime;
    if (state.owner === client.userId || state.unloaded) return;
    this.disposeImages();
    state.identityDispose?.();
    state.unloaded = true;
    state.generation++;
    state.pickerEpoch++;
    this.runtime = runtime();
    this.runtime.id = state.id;
    this.runtime.hidden = state.hidden;
    const { topInset, bottomInset } = this.data;
    this.updateData({ ...data(), topInset, bottomInset });
    this.observeIdentity();
    if (!this.runtime.hidden && this.runtime.owner && this.runtime.id) void this.loadDetail();
  },
  onLoad(options: Record<string, string | undefined>) {
    this.runtime = runtime();
    const id = uuidSchema.safeParse(options.id);
    const info = wx.getWindowInfo();
    this.updateData({
      topInset: Math.max(
        wx.getMenuButtonBoundingClientRect().bottom + 16,
        info.statusBarHeight + 44,
      ),
      bottomInset: Math.max(24, info.screenHeight - (info.safeArea?.bottom ?? info.screenHeight)),
    });
    if (!id.success) {
      this.updateData({ error: "这条记录的链接无效，请返回生活页重新打开。" });
      return;
    }
    this.runtime.id = id.data;
    this.observeIdentity();
    void this.loadDetail();
  },
  onShow() {
    const wasHidden = this.runtime.hidden;
    this.runtime.hidden = false;
    this.updateData({ reduceMotion: getAppearance(client).reduceMotion });
    if (this.runtime.owner === client.userId) this.renderMapSelection();
    if (this.runtime.owner !== client.userId) {
      this.syncOwner();
    } else if ((wasHidden || !this.data.detail) && !this.data.loading && this.runtime.id) {
      const state = this.runtime;
      void this.loadDetail().then(() => {
        if (
          this.runtime === state &&
          this.current(state) &&
          this.data.sourceOpen &&
          !this.data.sourceText &&
          state.sourceId
        )
          void this.openSource({
            currentTarget: { dataset: { id: state.sourceId } },
          } as unknown as WechatMiniprogram.TouchEvent);
      });
    }
  },
  onHide() {
    this.runtime.hidden = true;
    this.runtime.generation++;
    this.updateData({ busy: false, loading: false, sourceLoading: false });
  },
  onUnload() {
    this.runtime.identityDispose?.();
    this.runtime.identityDispose = undefined;
    this.disposeImages();
    this.runtime.pickerEpoch++;
    this.runtime.unloaded = true;
    this.runtime.generation++;
  },
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: "/pages/home/index?tab=life" });
  },
  login() {
    wx.reLaunch({ url: "/pages/home/index" });
  },
  async loadDetail() {
    const state = this.runtime;
    if (!state.owner) {
      this.updateData({ detail: null, view: null, loggedIn: false });
      return;
    }
    const generation = ++state.generation;
    this.updateData({ loading: true, error: "", loggedIn: true });
    try {
      const detail = await client.request(`/v1/life/${state.id}`, detailResponseSchema);
      if (!this.current(state, generation)) return;
      this.updateData({
        detail,
        view: displayDetail(detail),
        myRating: detail.myRating ?? "NONE",
      });
      void this.loadCapabilities(state, generation);
      void this.loadHeroImage(state, generation, detail);
    } catch (error) {
      if (this.current(state, generation)) this.updateData({ error: userMessage(error) });
    } finally {
      if (this.current(state, generation)) this.updateData({ loading: false });
    }
  },
  async loadCapabilities(state: ReturnType<typeof runtime>, generation: number) {
    try {
      const capabilities = await client.request("/v1/ui-capabilities", uiCapabilitiesSchema);
      if (this.current(state, generation))
        this.updateData({
          ticketVerificationAvailable: capabilities.ticketVerification.available,
          reminderDeliveryAvailable: capabilities.reminderDelivery.available,
          capabilityMessage:
            !capabilities.ticketVerification.available || !capabilities.reminderDelivery.available
              ? "票券核验与消息提醒尚未接入。可先保存原文、门店备注和时间。"
              : "",
        });
    } catch {
      if (this.current(state, generation))
        this.updateData({ capabilityMessage: "暂时无法确认核验与提醒服务状态。" });
    }
  },
  edit() {
    const detail = this.data.detail;
    if (!detail || this.data.busy) return;
    this.updateData({
      editing: true,
      draftTitle: detail.title,
      draftSummary: detail.summary ?? "",
      statusIndex: Math.max(0, ["ACTIVE", "RESOLVED", "ARCHIVED"].indexOf(detail.status)),
      error: "",
    });
  },
  closeEdit() {
    if (!this.data.busy) this.updateData({ editing: false });
  },
  titleInput(event: WechatMiniprogram.Input) {
    this.updateData({ draftTitle: event.detail.value });
  },
  summaryInput(event: WechatMiniprogram.TextareaInput) {
    this.updateData({ draftSummary: event.detail.value });
  },
  statusChange(event: WechatMiniprogram.PickerChange) {
    this.updateData({ statusIndex: Number(event.detail.value) });
  },
  async mutation<T>(
    action: string,
    input: unknown,
    path: string,
    schema: z.ZodType<T>,
    method: "POST" | "PATCH" | "DELETE",
  ) {
    const state = this.runtime,
      generation = state.generation;
    if (!this.current(state, generation) || state.flights.size) return null;
    state.flights.add(action);
    this.updateData({ busy: true, error: "" });
    const signature = JSON.stringify(input);
    try {
      const previous = state.pending.get(action);
      const pending =
        previous?.signature === signature ? previous : { signature, key: await client.newKey() };
      if (!this.current(state, generation)) return null;
      state.pending.set(action, pending);
      const result = await client.request(path, schema, { method, data: input, key: pending.key });
      if (!this.current(state, generation)) return null;
      state.pending.delete(action);
      return result;
    } catch (error) {
      if (this.current(state, generation))
        this.updateData({
          error:
            error instanceof ClientError && error.status === 501
              ? action === "verify"
                ? "票券核验尚未接入，未核销这张票券。"
                : "消息提醒尚未接入，未创建提醒。"
              : userMessage(error),
        });
      return null;
    } finally {
      state.flights.delete(action);
      if (this.current(state, generation)) this.updateData({ busy: false });
    }
  },
  async saveEdit() {
    const parsed = patchLifeObjectRequestSchema.safeParse({
      title: this.data.draftTitle,
      summary: this.data.draftSummary || null,
      status: ["ACTIVE", "RESOLVED", "ARCHIVED"][this.data.statusIndex],
    });
    if (!parsed.success) {
      this.updateData({ error: "请填写标题（最多240字），正文最多1200字。" });
      return;
    }
    const result = await this.mutation(
      "edit",
      parsed.data,
      `/v1/life/${this.runtime.id}`,
      lifeUpdatedSchema,
      "PATCH",
    );
    if (result) {
      routeCache.remove(this.runtime.owner ?? "", this.runtime.id);
      this.cancelMapSelection();
      this.updateData({ editing: false });
      await this.loadDetail();
    }
  },
  async markHappened() {
    const result = await this.mutation(
      "status",
      patchLifeObjectRequestSchema.parse({ status: "RESOLVED" }),
      `/v1/life/${this.runtime.id}`,
      lifeUpdatedSchema,
      "PATCH",
    );
    if (result) {
      routeCache.remove(this.runtime.owner ?? "", this.runtime.id);
      this.cancelMapSelection();
      await this.loadDetail();
    }
  },
  async rate(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.detail || !["ACTIVE", "RESOLVED"].includes(this.data.detail.status)) return;
    const chosen = event.currentTarget.dataset.rating;
    if (!["LIKE", "DISLIKE"].includes(chosen)) return;
    const rating = this.data.myRating === chosen ? "NONE" : chosen;
    const result = await this.mutation(
      "rating",
      { rating },
      `/v1/life/${this.runtime.id}/rating`,
      lifeRatingAcceptedSchema,
      "POST",
    );
    if (result) this.updateData({ myRating: result.rating });
  },
  async remove() {
    const state = this.runtime,
      generation = state.generation;
    const confirmation = await wx.showModal({
      title: "删除这条生活记录？",
      content: "删除后将从生活列表移除。",
      confirmText: "删除",
      confirmColor: "#9a4100",
    });
    if (!confirmation.confirm || !this.current(state, generation)) return;
    routeCache.remove(state.owner ?? "", state.id);
    const result = await this.mutation(
      "delete",
      {},
      `/v1/life/${state.id}`,
      lifeDeletedSchema,
      "DELETE",
    );
    if (result) this.goBack();
  },
  async openSource(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (
      !uuidSchema.safeParse(id).success ||
      !this.data.view?.captureSources.some((source) => source.id === id)
    )
      return;
    const state = this.runtime,
      generation = state.generation,
      sourceGeneration = ++state.sourceGeneration;
    state.sourceId = id;
    state.sourceImageDispose?.();
    state.sourceImageDispose = undefined;
    this.updateData({
      sourceImagePath: "",
      sourceOpen: true,
      sourceLoading: true,
      sourceText: "",
      sourceTitle: "",
      sourceError: "",
    });
    try {
      const source = await client.request(`/v1/captures/${id}`, captureResponseSchema);
      if (
        !this.current(state, generation) ||
        !this.data.sourceOpen ||
        sourceGeneration !== state.sourceGeneration
      )
        return;
      this.updateData({
        sourceTitle: source.title || "收录原文",
        sourceText:
          source.text ||
          source.summary ||
          (source.type === "VOICE" ? "此来源未附文字。原声回放尚未接入。" : "此来源未附文字。"),
      });
      if (source.type === "IMAGE") {
        const image = await readCaptureImage(client, id);
        if (
          !this.current(state, generation) ||
          !this.data.sourceOpen ||
          sourceGeneration !== state.sourceGeneration
        ) {
          image?.dispose();
          return;
        }
        state.sourceImageDispose = image?.dispose;
        this.updateData({ sourceImagePath: image?.path ?? "" });
      }
    } catch (error) {
      if (
        this.current(state, generation) &&
        this.data.sourceOpen &&
        sourceGeneration === state.sourceGeneration
      )
        this.updateData({ sourceError: userMessage(error) });
    } finally {
      if (
        this.current(state, generation) &&
        this.data.sourceOpen &&
        sourceGeneration === state.sourceGeneration
      )
        this.updateData({ sourceLoading: false });
    }
  },
  closeSource() {
    this.runtime.sourceGeneration++;
    this.runtime.sourceId = "";
    this.runtime.sourceImageDispose?.();
    this.runtime.sourceImageDispose = undefined;
    this.updateData({
      sourceImagePath: "",
      sourceOpen: false,
      sourceText: "",
      sourceTitle: "",
      sourceError: "",
      sourceLoading: false,
    });
  },
  disposeImages() {
    this.runtime.imageDispose?.();
    this.runtime.imageDispose = undefined;
    this.runtime.sourceImageDispose?.();
    this.runtime.sourceImageDispose = undefined;
  },
  async loadHeroImage(state: ReturnType<typeof runtime>, generation: number, detail: LifeDetail) {
    const sources = [...detail.sources]
      .filter((source) => source.sourceType === "CAPTURE")
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    const ids = detail.imageCaptureId
      ? [detail.imageCaptureId]
      : [...new Set(sources.map((source) => source.sourceId))];
    state.imageDispose?.();
    state.imageDispose = undefined;
    this.updateData({ heroImagePath: "" });
    for (const id of ids) {
      if (!this.current(state, generation)) return;
      try {
        const image = await readCaptureImage(client, id);
        if (!this.current(state, generation)) {
          image?.dispose();
          return;
        }
        if (!image) continue;
        state.imageDispose = image.dispose;
        this.updateData({ heroImagePath: image.path });
        return;
      } catch {
        /* Try another actual source while keeping text details usable. */
      }
    }
  },
  previewHero() {
    if (this.data.heroImagePath) wx.previewImage({ urls: [this.data.heroImagePath] });
  },
  previewSource() {
    if (this.data.sourceImagePath) wx.previewImage({ urls: [this.data.sourceImagePath] });
  },
  openMap() {
    const destination =
      this.data.detail?.verifiedDestination ?? this.data.detail?.selectedDestination;
    if (!destination) {
      void this.choosePlace();
      return;
    }
    const state = this.runtime,
      owner = client.userId;
    wx.openLocation({
      latitude: destination.latitude,
      longitude: destination.longitude,
      name: destination.name || this.data.view?.placeName || "",
      address: destination.address || "",
      scale: 16,
      fail: () => {
        if (this.runtime === state && !state.unloaded && client.userId === owner)
          this.updateData({ error: "无法打开地图，请稍后重试。" });
      },
    });
  },
  cancelMapSelection() {
    this.runtime.pickerEpoch++;
    this.runtime.pickerContext = null;
    this.updateData({ mapSelection: null, mapPickerBusy: false });
  },
  async choosePlace() {
    const state = this.runtime,
      owner = client.userId;
    if (
      !this.current(state) ||
      this.data.busy ||
      this.data.mapPickerBusy ||
      this.data.detail?.status !== "ACTIVE"
    )
      return;
    this.cancelMapSelection();
    const epoch = state.pickerEpoch;
    const context = {
      intentToken: "",
      expiresAt: 0,
      picked: null as LocationMapSelectRequest | null,
    };
    state.pickerContext = context;
    // Native maps can hide/show this page. Only this picker intent, owner and target fence its callbacks.
    const isCurrent = () =>
      this.runtime === state &&
      !state.unloaded &&
      state.pickerEpoch === epoch &&
      state.pickerContext === context &&
      owner === client.userId;
    this.updateData({ mapPickerBusy: true, error: "", locationNotice: "" });
    try {
      const key = await client.newKey();
      if (!isCurrent()) return;
      const intent = await client.request(
        "/v1/locations/picker-intents",
        locationPickerIntentResponseSchema,
        {
          method: "POST",
          key,
          data: locationPickerIntentRequestSchema.parse({ lifeObjectId: state.id }),
        },
      );
      if (!isCurrent()) return;
      if (state.hidden) {
        this.cancelMapSelection();
        return;
      }
      if (intent.lifeObjectId !== state.id) throw new Error("Invalid picker target");
      context.intentToken = intent.intentToken;
      context.expiresAt = Date.parse(intent.expiresAt);
      if (context.expiresAt <= Date.now()) throw new Error("这次地点选择已失效，请重新选择。");
      if (typeof wx.chooseLocation !== "function")
        throw new Error("当前微信暂不支持地图选点，请更新微信后再试。");
      wx.chooseLocation({
        success: (point) => {
          if (!isCurrent() || context.picked) return;
          const parsed = locationMapSelectRequestSchema.safeParse({
            lifeObjectId: state.id,
            intentToken: context.intentToken,
            name: point.name,
            address: point.address,
            location: {
              latitude: point.latitude,
              longitude: point.longitude,
              coordinateSystem: "GCJ02",
            },
          });
          if (!parsed.success || context.expiresAt <= Date.now()) {
            this.cancelMapSelection();
            this.updateData({ error: "选点信息不完整或已失效，请重新选择。" });
            return;
          }
          context.picked = parsed.data;
          if (!state.hidden) this.renderMapSelection();
        },
        fail: (error) => {
          if (!isCurrent() || context.picked) return;
          this.cancelMapSelection();
          if (!state.hidden)
            this.updateData({
              error: /cancel|取消/i.test(error.errMsg)
                ? ""
                : "无法打开微信地图选点，请检查微信权限后重试。",
            });
        },
      });
    } catch (error) {
      if (!isCurrent()) return;
      this.cancelMapSelection();
      if (!state.hidden) this.updateData({ error: userMessage(error) });
    }
  },
  renderMapSelection() {
    const picked = this.runtime.pickerContext?.picked;
    if (picked)
      this.updateData({
        mapPickerBusy: false,
        mapSelection: { name: picked.name, address: picked.address },
      });
  },
  async confirmMapSelection() {
    const state = this.runtime,
      context = state.pickerContext;
    if (!context?.picked || !this.current(state) || this.data.busy) return;
    if (context.expiresAt <= Date.now()) {
      this.cancelMapSelection();
      this.updateData({ error: "这次地点选择已失效，请重新选择。" });
      return;
    }
    // A lost receipt may already have changed the stored point; invalidate the shared old route before retrying.
    routeCache.remove(state.owner ?? "", state.id);
    const result = await this.mutation(
      "map-select",
      context.picked,
      "/v1/locations/map-select",
      locationMapSelectResponseSchema,
      "POST",
    );
    if (!result || state.pickerContext !== context) return;
    if (result.lifeObjectId !== state.id) {
      this.updateData({ error: "地点保存回执与当前记录不一致，请刷新确认。" });
      return;
    }
    this.cancelMapSelection();
    this.updateData({ locationNotice: "已保存你确认的地图地点。门店适用范围与路线仍需核对。" });
    await this.loadDetail();
  },
  editStore() {
    this.updateData({
      storeEditing: true,
      storeQuery: this.data.view?.placeName === "待补充" ? "" : (this.data.view?.placeName ?? ""),
    });
  },
  storeInput(event: WechatMiniprogram.Input) {
    this.updateData({ storeQuery: event.detail.value });
  },
  closeStore() {
    if (!this.data.busy) this.updateData({ storeEditing: false });
  },
  async verifyTicket() {
    const query = this.data.storeQuery.trim();
    await this.mutation(
      "verify",
      ticketVerificationRequestSchema.parse({
        lifeObjectId: this.runtime.id,
        ...(query ? { storeQuery: query } : {}),
      }),
      "/v1/tickets/verify",
      z.unknown(),
      "POST",
    );
  },
  async remind() {
    const remindAt = this.data.view?.remindAt;
    if (!remindAt) {
      this.updateData({ error: "请先在原文中补充明确时间。消息提醒服务尚未接入。" });
      return;
    }
    await this.mutation(
      "reminder",
      reminderSubscriptionRequestSchema.parse({ lifeObjectId: this.runtime.id, remindAt }),
      "/v1/reminders/subscriptions",
      z.unknown(),
      "POST",
    );
  },
});
