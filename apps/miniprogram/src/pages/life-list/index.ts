import "../../lib/zod-runtime";
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
  type LifeBrowseItem,
  type LifeSection,
  type LifeSearchRequest,
} from "@life/contracts";
import type { AppServices } from "../../lib/session";
import { userMessage } from "../../lib/errors";
import { getCurrentLocation } from "../../lib/location";
import { kindOptions, displayLifeItem, groupLifeItems, type LifeStack } from "../../lib/life";

const { client } = getApp<{ globalData: AppServices }>().globalData;
const locationAttempts = new Map<string, number>();
const locationAttemptTtl = 15 * 60000;
function locationAttemptKey(owner: string, item: LifeBrowseItem) {
  return `${owner}:${item.id}:${item.objectVersion ?? (item.placeLabel?.trim() || item.title)}`;
}
function createRuntime() {
  return {
    unloaded: false,
    hidden: false,
    owner: client.userId,
    generation: 0,
    deckKind: null as LifeBrowseItem["kind"] | null,
    categoryPage: false,
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
    title: "最近留下",
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
  runtime: createRuntime(),
  updateData(values: Partial<ReturnType<typeof createData>>) {
    if (!this.runtime.unloaded) {
      if (values.items) values.groups = groupLifeItems(values.items, this.data.groups);
      this.setData(values);
    }
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
      title: deckKind ? kindOptions[kindIndex]!.label : lifeSectionTitles[section],
      kindIndex: deckKind ? kindIndex : 0,
      deckView: Boolean(deckKind),
      topInset: Math.max(
        wx.getMenuButtonBoundingClientRect().bottom + 16,
        info.statusBarHeight + 44,
      ),
      bottomInset: Math.max(16, info.screenHeight - (info.safeArea?.bottom ?? info.screenHeight)),
    });
    void this.loadItems(true);
  },
  onShow() {
    this.runtime.hidden = false;
    if (this.runtime.owner !== client.userId) {
      this.stopLocationPolling();
      const { deckKind, categoryPage } = this.runtime;
      this.runtime = createRuntime();
      this.runtime.deckKind = deckKind;
      this.runtime.categoryPage = categoryPage;
      void this.loadItems(true);
    } else if (this.data.loaded && this.runtime.locationQuery) {
      // Reuse the original query; returning to the page never requests GPS.
      void this.refreshLocationResults();
      this.scheduleLocationPoll(2500);
    }
  },
  onHide() {
    this.runtime.hidden = true;
    this.runtime.ratingGeneration++;
    this.updateData({ stackDragging: false, ratingBusy: [] });
    this.stopLocationPolling(false);
  },
  onUnload() {
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
    wx.navigateBack();
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
      this.runtime === state && !state.unloaded && !state.hidden && client.userId === owner;
    const index = Number(event.detail.value);
    if (index >= 3) {
      this.updateData({ locating: true, error: "" });
      try {
        await this.currentCenter();
      } catch (error) {
        if (isCurrent())
          this.updateData({
            error: `${userMessage(error)} 也可以选择全部地点继续查看。`,
          });
        return;
      } finally {
        this.updateData({ locating: false });
      }
    } else this.runtime.center = null;
    if (!isCurrent()) return;
    this.updateData({ locationIndex: index });
    await this.loadItems(true);
  },
  async currentCenter() {
    const state = this.runtime;
    const owner = client.userId;
    if (state.center && Date.now() - state.center.acquiredAt < 5 * 60000) return state.center;
    const point = await getCurrentLocation();
    const center = { latitude: point.latitude, longitude: point.longitude, acquiredAt: Date.now() };
    if (this.runtime === state && !state.unloaded && !state.hidden && client.userId === owner)
      state.center = center;
    return center;
  },
  async loadItems(reset = false) {
    const state = this.runtime;
    if (state.unloaded || (!reset && (this.data.loading || !this.data.nextCursor))) return;
    const generation = reset ? ++state.generation : state.generation;
    if (reset) this.stopLocationPolling();
    this.updateData({
      loading: true,
      error: "",
      ...(reset ? { items: [], nextCursor: null, loaded: false } : {}),
    });
    try {
      const index = this.data.locationIndex;
      const center = index >= 3 ? await this.currentCenter() : undefined;
      if (generation !== state.generation || state.unloaded) return;
      const useDeck = Boolean(state.deckKind) && this.data.timeIndex === 0 && index === 0;
      const input = lifeSearchRequestSchema.parse({
        section: this.data.section,
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
      if (generation !== state.generation || state.unloaded) return;
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
      if (generation === state.generation) this.updateData({ error: userMessage(error) });
    } finally {
      if (generation === state.generation) this.updateData({ loading: false });
    }
  },
  refresh() {
    this.runtime.locationConfigured = undefined;
    void this.loadItems(true);
  },
  loadMore() {
    void this.loadItems();
  },
  retry() {
    void this.loadItems(!this.data.loaded || !this.data.nextCursor);
  },
});
