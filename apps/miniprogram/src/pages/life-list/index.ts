import "../../lib/zod-runtime";
import { reaction } from "mobx-miniprogram";
import {
  lifeSectionSchema,
  lifeSectionTitles,
  lifeSearchRequestSchema,
  lifeSearchResponseSchema,
  locationStatusSchema,
  locationRefreshAcceptedSchema,
  lifeDeckResponseSchema,
  lifeDeckRequestSchema,
  lifeRatingAcceptedSchema,
  userSettingsResponseSchema,
  type LifeBrowseItem,
  type LifeSection,
  type LifeSearchRequest,
} from "@life/contracts";
import { ImageGallery } from "../../lib/image-gallery";
import { getAppearance } from "../../lib/appearance";
import type { AppServices } from "../../lib/session";
import { userMessage } from "../../lib/errors";
import { getCurrentLocation } from "../../lib/location";
import { kindOptions, displayLifeItem, groupLifeItems, type LifeStack } from "../../lib/life";

const { client, sessionStore } = getApp<{ globalData: AppServices }>().globalData;
const locationAttempts = new Map<string, number>();
const locationAttemptTtl = 15 * 60000;
function locationAttemptKey(owner: string, item: LifeBrowseItem) {
  return `${owner}:${item.id}:${item.objectVersion ?? (item.placeLabel?.trim() || item.title)}`;
}
function createRuntime() {
  return {
    identityDispose: undefined as (() => void) | undefined,
    images: new ImageGallery(client),
    unloaded: false,
    hidden: false,
    owner: client.userId,
    generation: 0,
    deckKind: null as LifeBrowseItem["kind"] | null,
    categoryPage: false,
    shownOnce: false,
    ratingGeneration: 0,
    ratingPending: new Map<string, { signature: string; key: string }>(),
    ratingFlights: new Set<string>(),
    center: null as { latitude: number; longitude: number; acquiredAt: number } | null,
    locationConfigured: undefined as boolean | undefined,
    locationFlight: false,
    locationSubmitted: 0,
    locationPoll: undefined as ReturnType<typeof setTimeout> | undefined,
    locationPollRemaining: 0,
    locationQuery: null as {
      input: LifeSearchRequest;
      generation: number;
      pageIds: string[];
      useDeck: boolean;
    } | null,
  };
}
function createData() {
  return {
    section: "RECENT" as LifeSection,
    searchMode: false,
    title: "最近留下",
    loggedIn: Boolean(client.userId),
    reduceMotion: getAppearance(client).reduceMotion,
    query: "",
    searchDraft: "",
    kindChips: kindOptions.map((option, index) => ({ label: option.label, index })),
    topInset: 92,
    bottomInset: 24,
    timeOptions: ["全部时间", "最近 7 天", "最近 30 天", "最近 90 天"],
    timeIndex: 0,
    kindOptions: kindOptions.map((option) => option.label),
    kindIndex: 0,
    locationOptions: ["全部地点", "已有坐标", "尚无坐标", "附近 1 km", "附近 3 km", "附近 10 km"],
    locationIndex: 0,
    items: [] as ReturnType<typeof displayLifeItem>[],
    nextCursor: null as string | null,
    loaded: false,
    loading: false,
    locating: false,
    error: "",
    groups: [] as LifeStack[],
    stackDragging: false,
    ratingBusy: [] as string[],
    deckView: false,
  };
}
Page({
  data: createData(),
  runtime: null as unknown as ReturnType<typeof createRuntime>,
  updateData(values: Partial<ReturnType<typeof createData>>, loadImages = true) {
    if (!this.runtime.unloaded) {
      if (values.items) {
        values.items = values.items.map((item) => ({
          ...item,
          imagePath: this.runtime.images.path(item.imageCaptureId),
        }));
        values.groups = groupLifeItems(values.items, this.data.groups);
      }
      this.setData(values);
      if (values.items && loadImages) void this.loadItemImages();
    }
  },
  async loadItemImages() {
    const state = this.runtime,
      generation = state.generation,
      owner = client.userId;
    const ids = this.data.items.flatMap((item) =>
      item.imageCaptureId && !item.imagePath && !item.imageFailed ? [item.imageCaptureId] : [],
    );
    const current = () =>
      this.runtime === state &&
      !state.unloaded &&
      !state.hidden &&
      owner === client.userId &&
      generation === state.generation;
    await state.images.load(
      ids,
      (id, path) => {
        if (!current()) return;
        this.updateData(
          {
            items: this.data.items.map((item) =>
              item.imageCaptureId === id ? { ...item, imagePath: path, imageFailed: false } : item,
            ),
          },
          false,
        );
      },
      (id) => {
        if (!current()) return;
        this.updateData(
          {
            items: this.data.items.map((item) =>
              item.imageCaptureId === id ? { ...item, imageFailed: true } : item,
            ),
          },
          false,
        );
      },
    );
  },
  imageLoadError(event: WechatMiniprogram.CustomEvent) {
    const id = event.currentTarget.dataset.imageId;
    if (!id) return;
    this.runtime.images.invalidate(id);
    this.updateData(
      {
        items: this.data.items.map((item) =>
          item.imageCaptureId === id ? { ...item, imagePath: "", imageFailed: true } : item,
        ),
      },
      false,
    );
  },
  retryImage(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.imageId;
    this.updateData({
      items: this.data.items.map((item) =>
        item.imageCaptureId === id ? { ...item, imageFailed: false } : item,
      ),
    });
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
    this.stopLocationPolling();
    state.images.clear();
    state.identityDispose?.();
    state.unloaded = true;
    state.generation++;
    state.ratingGeneration++;
    this.runtime = createRuntime();
    this.runtime.hidden = state.hidden;
    this.runtime.shownOnce = state.shownOnce;
    this.runtime.deckKind = state.deckKind;
    this.runtime.categoryPage = state.categoryPage;
    const { section, searchMode, title, kindIndex, topInset, bottomInset } = this.data;
    this.updateData({
      ...createData(),
      section,
      searchMode,
      title,
      kindIndex,
      topInset,
      bottomInset,
    });
    this.observeIdentity();
    if (!this.runtime.hidden && this.runtime.owner) void this.loadItems(true);
  },
  onLoad(options: Record<string, string | undefined>) {
    this.runtime = createRuntime();
    const parsed = lifeSectionSchema.safeParse(options.section);
    const section = parsed.success ? parsed.data : "RECENT";
    const kindIndex = kindOptions.findIndex((option) => option.value === options.kind);
    const deckKind = kindIndex > 0 ? kindOptions[kindIndex]!.value! : null;
    this.runtime.deckKind = deckKind;
    this.runtime.categoryPage = Boolean(deckKind);
    const info = wx.getWindowInfo();
    this.updateData({
      section,
      searchMode: options.mode === "search",
      query: (options.query ?? "").trim().slice(0, 120),
      searchDraft: (options.query ?? "").trim().slice(0, 120),
      title:
        options.mode === "search"
          ? "搜索"
          : options.mode === "nearby"
            ? "附近已记录地点"
            : deckKind
              ? kindOptions[kindIndex]!.label
              : lifeSectionTitles[section],
      locationIndex: options.mode === "nearby" ? 3 : 0,
      kindIndex: deckKind ? kindIndex : 0,
      deckView: Boolean(deckKind),
      topInset: Math.max(
        wx.getMenuButtonBoundingClientRect().bottom + 16,
        info.statusBarHeight + 44,
      ),
      bottomInset: Math.max(16, info.screenHeight - (info.safeArea?.bottom ?? info.screenHeight)),
    });
    this.observeIdentity();
    void this.loadItems(true, options.mode !== "nearby");
  },
  onShow() {
    const wasHidden = this.runtime.hidden;
    this.runtime.hidden = false;
    this.updateData({ reduceMotion: getAppearance(client).reduceMotion });
    this.updateData({ loggedIn: Boolean(client.userId) });
    if (!this.runtime.shownOnce) {
      this.runtime.shownOnce = true;
      if (!wasHidden) return;
    }
    if (this.runtime.owner !== client.userId) {
      this.syncOwner();
    } else if (wasHidden || this.data.loaded) {
      // Resume interrupted reads and refresh detail edits using the existing coordinates only.
      void this.loadItems(true, true);
    }
  },
  onHide() {
    this.runtime.hidden = true;
    this.runtime.ratingGeneration++;
    this.runtime.generation++;
    this.updateData({ stackDragging: false, ratingBusy: [], loading: false, locating: false });
    this.stopLocationPolling(false);
  },
  onUnload() {
    this.runtime.images.clear();
    this.runtime.identityDispose?.();
    this.runtime.identityDispose = undefined;
    this.stopLocationPolling();
    this.runtime.unloaded = true;
    this.runtime.generation++;
    this.runtime.center = null;
  },
  stopLocationPolling(clearQuery = true) {
    const state = this.runtime;
    if (state.locationPoll) clearTimeout(state.locationPoll);
    state.locationPoll = undefined;
    if (clearQuery) {
      state.locationPollRemaining = 0;
      state.locationQuery = null;
    }
  },
  async queueLocationRefresh(
    items: LifeBrowseItem[],
    input: LifeSearchRequest,
    generation: number,
    useDeck = false,
  ) {
    const state = this.runtime;
    const owner = client.userId;
    if (
      !owner ||
      state.owner !== owner ||
      state.unloaded ||
      state.hidden ||
      state.locationFlight ||
      state.locationSubmitted >= 5
    )
      return;
    const now = Date.now();
    for (const [key, at] of locationAttempts)
      if (now - at >= locationAttemptTtl) locationAttempts.delete(key);
    const candidates = items
      .filter(
        (item) =>
          item.status === "ACTIVE" &&
          !item.hasLocation &&
          (item.placeLabel?.trim() || item.kind === "PLACE") &&
          !locationAttempts.has(locationAttemptKey(owner, item)),
      )
      .slice(0, 5 - state.locationSubmitted);
    if (!candidates.length || state.locationConfigured === false) return;
    state.locationFlight = true;
    const isCurrent = () =>
      !state.unloaded &&
      !state.hidden &&
      state.generation === generation &&
      state.owner === owner &&
      client.userId === owner &&
      this.runtime === state;
    try {
      if (state.locationConfigured == null) {
        const status = await client.request("/v1/locations/status", locationStatusSchema);
        if (!isCurrent()) return;
        state.locationConfigured = status.configured && status.geocoding;
      }
      if (!state.locationConfigured || !isCurrent()) return;
      const key = await client.newKey();
      if (!isCurrent()) return;
      for (const item of candidates)
        locationAttempts.set(locationAttemptKey(owner, item), Date.now());
      while (locationAttempts.size > 500)
        locationAttempts.delete(locationAttempts.keys().next().value!);
      state.locationSubmitted += candidates.length;
      state.locationQuery = { input, generation, pageIds: items.map((item) => item.id), useDeck };
      const result = await client.request("/v1/locations/refresh", locationRefreshAcceptedSchema, {
        method: "POST",
        key,
        data: { objectIds: candidates.map((item) => item.id) },
      });
      if (
        !isCurrent() ||
        !result.items.some((item) => item.status === "QUEUED" || item.status === "PENDING")
      )
        return;
      state.locationPollRemaining = 2;
      this.scheduleLocationPoll(2500);
    } catch {
      // Geocoding is optional. Preserve the user's list without adding an alert.
      if (state.locationConfigured == null) state.locationConfigured = false;
    } finally {
      state.locationFlight = false;
    }
  },
  scheduleLocationPoll(delay: number) {
    const state = this.runtime;
    if (state.unloaded || state.hidden || !state.locationQuery || state.locationPollRemaining <= 0)
      return;
    if (state.locationPoll) clearTimeout(state.locationPoll);
    state.locationPoll = setTimeout(async () => {
      state.locationPoll = undefined;
      state.locationPollRemaining--;
      await this.refreshLocationResults();
      this.scheduleLocationPoll(5000);
    }, delay);
  },
  async refreshLocationResults() {
    const state = this.runtime;
    const query = state.locationQuery;
    if (!query || state.unloaded || state.hidden || state.owner !== client.userId) return;
    try {
      const key = await client.newKey();
      if (
        state.unloaded ||
        state.hidden ||
        state.generation !== query.generation ||
        this.runtime !== state ||
        state.owner !== client.userId
      )
        return;
      const result = await client.request(
        query.useDeck ? "/v1/life/deck" : "/v1/life/search",
        query.useDeck ? lifeDeckResponseSchema : lifeSearchResponseSchema,
        {
          method: "POST",
          key,
          data: query.useDeck
            ? lifeDeckRequestSchema.parse({
                kind: query.input.kind,
                cursor: query.input.cursor,
                limit: query.input.limit,
              })
            : query.input,
        },
      );
      if (
        state.unloaded ||
        state.hidden ||
        state.generation !== query.generation ||
        this.runtime !== state ||
        state.owner !== client.userId
      )
        return;
      const oldIds = new Set(query.pageIds),
        newIds = new Set(result.items.map((item) => item.id));
      const firstIndex = Math.max(
        0,
        this.data.items.findIndex((item) => oldIds.has(item.id)),
      );
      const before = this.data.items.slice(0, firstIndex).filter((item) => !newIds.has(item.id));
      const after = this.data.items
        .slice(firstIndex)
        .filter((item) => !oldIds.has(item.id) && !newIds.has(item.id));
      this.updateData({
        items: [...before, ...result.items.map(displayLifeItem), ...after],
        ...(!before.length && !after.length ? { nextCursor: result.nextCursor } : {}),
      });
      query.pageIds = result.items.map((item) => item.id);
    } catch {
      // A short refresh can fail independently of the main list request.
    }
  },
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: "/pages/home/index?tab=life" });
  },
  noop() {},
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
    const group = this.data.groups.find((item) => item.kind === kind);
    if (!group || !Number.isInteger(current) || current < 0 || current >= group.items.length)
      return;
    this.updateData({
      groups: this.data.groups.map((item) => (item.kind === kind ? { ...item, current } : item)),
    });
    if (this.data.deckView && current >= group.items.length - 2 && this.data.nextCursor)
      void this.loadItems();
  },
  moveStack(event: WechatMiniprogram.TouchEvent) {
    const kind = event.currentTarget.dataset.kind;
    const group = this.data.groups.find((item) => item.kind === kind);
    if (!group) return;
    const current = group.current + Number(event.currentTarget.dataset.step);
    if (current >= group.items.length) {
      if (this.data.nextCursor) void this.loadItems();
      return;
    }
    this.setStackCurrent(kind, current);
  },
  viewLifeItem(event: WechatMiniprogram.TouchEvent) {
    const item = this.data.items.find((item) => item.id === event.currentTarget.dataset.id);
    if (item) wx.navigateTo({ url: `/pages/life-detail/index?id=${item.id}&type=${item.kind}` });
  },
  async rateLifeItem(event: WechatMiniprogram.TouchEvent) {
    const state = this.runtime;
    const owner = client.userId;
    const generation = state.generation;
    const ratingGeneration = state.ratingGeneration;
    const id = event.currentTarget.dataset.id;
    const chosen = event.currentTarget.dataset.rating;
    const item = this.data.items.find((item) => item.id === id);
    if (
      !owner ||
      !item ||
      state.unloaded ||
      state.ratingFlights.has(id) ||
      !["LIKE", "DISLIKE"].includes(chosen)
    )
      return;
    const rating = item.myRating === chosen ? "NONE" : chosen;
    const signature = JSON.stringify({ rating });
    const isCurrent = () =>
      !state.unloaded &&
      !state.hidden &&
      this.runtime === state &&
      generation === state.generation &&
      ratingGeneration === state.ratingGeneration &&
      owner === client.userId;
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
        items: this.data.items.map((item) =>
          item.id === id ? { ...item, myRating: result.rating } : item,
        ),
      });
    } catch (error) {
      if (isCurrent()) this.updateData({ error: userMessage(error) });
    } finally {
      state.ratingFlights.delete(id);
      if (isCurrent()) this.updateData({ ratingBusy: [...state.ratingFlights] });
    }
  },
  async setTime(event: WechatMiniprogram.PickerChange) {
    this.updateData({ timeIndex: Number(event.detail.value) });
    await this.loadItems(true);
  },
  async setKind(event: WechatMiniprogram.PickerChange) {
    this.updateData({ kindIndex: Number(event.detail.value) });
    if (this.runtime.categoryPage) {
      this.runtime.deckKind = kindOptions[this.data.kindIndex]?.value ?? null;
      this.updateData({
        title: this.runtime.deckKind ? kindOptions[this.data.kindIndex]!.label : "生活里留下的",
      });
    }
    await this.loadItems(true);
  },
  async setLocation(event: WechatMiniprogram.PickerChange) {
    if (this.data.locating) return;
    const state = this.runtime;
    const owner = client.userId;
    const isCurrent = () =>
      this.runtime === state &&
      !state.unloaded &&
      !state.hidden &&
      state.owner === owner &&
      client.userId === owner;
    if (!isCurrent() || !owner) return;
    const index = Number(event.detail.value);
    if (index >= 3) {
      this.updateData({ locating: true, error: "" });
      try {
        await this.currentCenter();
      } catch (error) {
        if (isCurrent())
          this.updateData({
            error:
              error instanceof Error && error.message === "定位偏好读取失败"
                ? "暂时无法读取定位偏好，请重试；本次未获取位置。"
                : error instanceof Error && error.message === "Location cancelled"
                  ? "本次未获取位置。可选择全部地点继续查看。"
                  : `${userMessage(error)} 也可以选择全部地点继续查看。`,
          });
        return;
      } finally {
        if (isCurrent()) this.updateData({ locating: false });
      }
    } else this.runtime.center = null;
    if (!isCurrent()) return;
    this.updateData({ locationIndex: index });
    await this.loadItems(true);
  },
  async currentCenter(reuseOnly = false) {
    const state = this.runtime;
    const owner = client.userId;
    if (!owner || state.owner !== owner || state.unloaded || state.hidden)
      throw new Error("Session changed");
    if (state.center && (reuseOnly || Date.now() - state.center.acquiredAt < 5 * 60000))
      return state.center;
    if (reuseOnly) throw new Error("请重新选择附近范围获取位置");
    const isCurrent = () =>
      this.runtime === state &&
      !state.unloaded &&
      !state.hidden &&
      Boolean(owner) &&
      client.userId === owner;
    let settings;
    try {
      settings = await client.request("/v1/settings", userSettingsResponseSchema);
    } catch {
      throw new Error("定位偏好读取失败");
    }
    if (!isCurrent()) throw new Error("Session changed");
    if (!settings.privacy.useLocation) {
      const consent = await wx.showModal({
        title: "本次使用当前位置？",
        content: "你的定位偏好尚未开启。本次仅用当前位置查找附近已记录地点，不会修改偏好。",
        confirmText: "本次允许",
        cancelText: "不用定位",
      });
      if (!isCurrent() || !consent.confirm) throw new Error("Location cancelled");
    }
    if (!isCurrent()) throw new Error("Session changed");
    const point = await getCurrentLocation();
    const center = { latitude: point.latitude, longitude: point.longitude, acquiredAt: Date.now() };
    if (this.runtime === state && !state.unloaded && !state.hidden && client.userId === owner)
      state.center = center;
    return center;
  },
  async loadItems(reset = false, reuseCenter = true) {
    const state = this.runtime;
    const owner = client.userId;
    if (!owner) {
      this.updateData({ items: [], loaded: false, loggedIn: false, loading: false });
      return;
    }
    const isCurrent = () =>
      this.runtime === state &&
      !state.unloaded &&
      !state.hidden &&
      state.owner === owner &&
      client.userId === owner;
    if (state.unloaded || (!reset && (this.data.loading || !this.data.nextCursor))) return;
    const generation = reset ? ++state.generation : state.generation;
    if (reset) {
      this.stopLocationPolling();
      state.images.clear();
    }
    this.updateData({
      loading: true,
      error: "",
      ...(reset ? { items: [], nextCursor: null, loaded: false } : {}),
    });
    try {
      const index = this.data.locationIndex;
      const center = index >= 3 ? await this.currentCenter(reuseCenter) : undefined;
      if (generation !== state.generation || !isCurrent()) return;
      const useDeck =
        Boolean(state.deckKind) &&
        !this.data.searchMode &&
        this.data.timeIndex === 0 &&
        index === 0 &&
        !this.data.query;
      const input = lifeSearchRequestSchema.parse({
        section: this.data.section,
        scope: this.data.searchMode ? "ALL_RECORDED" : "SECTION",
        query: this.data.query || undefined,
        savedWithinDays: ([undefined, 7, 30, 90] as const)[this.data.timeIndex],
        kind: kindOptions[this.data.kindIndex]?.value,
        location: (["ALL", "LOCATED", "UNLOCATED", "NEARBY", "NEARBY", "NEARBY"] as const)[index],
        center: center
          ? {
              latitude: center.latitude,
              longitude: center.longitude,
              coordinateSystem: "GCJ02",
              radiusMeters: ([1000, 3000, 10000] as const)[index - 3]!,
            }
          : undefined,
        cursor: reset || useDeck ? undefined : (this.data.nextCursor ?? undefined),
      } satisfies Partial<LifeSearchRequest>);
      if (useDeck && !reset) input.cursor = this.data.nextCursor ?? undefined;
      const result = await client.request(
        useDeck ? "/v1/life/deck" : "/v1/life/search",
        useDeck ? lifeDeckResponseSchema : lifeSearchResponseSchema,
        {
          method: "POST",
          data: useDeck
            ? lifeDeckRequestSchema.parse({
                kind: input.kind,
                cursor: input.cursor,
                limit: input.limit,
              })
            : input,
          key: await client.newKey(),
        },
      );
      if (generation !== state.generation || !isCurrent()) return;
      const previous = reset ? [] : this.data.items;
      const ids = new Set(previous.map((item) => item.id));
      this.updateData({
        items: [
          ...previous,
          ...result.items.filter((item) => !ids.has(item.id)).map(displayLifeItem),
        ],
        nextCursor: result.nextCursor,
        loaded: true,
        deckView: useDeck,
      });
      void this.queueLocationRefresh(result.items, input, generation, useDeck);
    } catch (error) {
      if (generation === state.generation && isCurrent())
        this.updateData({
          error:
            error instanceof Error && error.message === "定位偏好读取失败"
              ? "暂时无法读取定位偏好，请重试；本次未获取位置。"
              : error instanceof Error && error.message === "Location cancelled"
                ? "本次未获取位置。可选择全部地点继续查看。"
                : userMessage(error),
        });
    } finally {
      if (generation === state.generation && isCurrent()) this.updateData({ loading: false });
    }
  },
  searchInput(event: WechatMiniprogram.Input) {
    this.updateData({ searchDraft: event.detail.value });
  },
  submitSearch() {
    this.updateData({ query: this.data.searchDraft.trim() });
    void this.loadItems(true);
  },
  clearSearch() {
    this.updateData({ query: "", searchDraft: "" });
    void this.loadItems(true);
  },
  selectKind(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index);
    if (!kindOptions[index]) return;
    this.updateData({ kindIndex: index });
    if (this.runtime.categoryPage) {
      this.runtime.deckKind = kindOptions[index]?.value ?? null;
      if (!this.data.searchMode)
        this.updateData({
          title: this.runtime.deckKind ? kindOptions[index]!.label : "生活里留下的",
        });
    }
    void this.loadItems(true);
  },
  login() {
    wx.reLaunch({ url: "/pages/home/index" });
  },
  refresh() {
    this.runtime.locationConfigured = undefined;
    void this.loadItems(true, false);
  },
  loadMore() {
    void this.loadItems();
  },
  retry() {
    void this.loadItems(!this.data.loaded || !this.data.nextCursor, false);
  },
});
