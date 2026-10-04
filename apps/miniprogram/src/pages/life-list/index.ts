import "../../lib/zod-runtime";
import {
  lifeSectionSchema,
  lifeSectionTitles,
  lifeSearchRequestSchema,
  lifeSearchResponseSchema,
  type LifeSection,
  type LifeSearchRequest,
} from "@life/contracts";
import type { AppServices } from "../../lib/session";
import { userMessage } from "../../lib/errors";
import { kindOptions, displayLifeItem } from "../../lib/life";

const { client } = getApp<{ globalData: AppServices }>().globalData;
function createRuntime() {
  return {
    unloaded: false,
    generation: 0,
    center: null as { latitude: number; longitude: number; acquiredAt: number } | null,
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
    locationOptions: [
      "全部地点",
      "已记录地点",
      "未记录地点",
      "附近 1 km",
      "附近 3 km",
      "附近 10 km",
    ],
    locationIndex: 0,
    items: [] as ReturnType<typeof displayLifeItem>[],
    nextCursor: null as string | null,
    loaded: false,
    loading: false,
    locating: false,
    error: "",
  };
}
Page({
  data: createData(),
  runtime: createRuntime(),
  updateData(values: Partial<ReturnType<typeof createData>>) {
    if (!this.runtime.unloaded) this.setData(values);
  },
  onLoad(options: Record<string, string | undefined>) {
    this.runtime = createRuntime();
    const parsed = lifeSectionSchema.safeParse(options.section);
    const section = parsed.success ? parsed.data : "RECENT";
    const info = wx.getWindowInfo();
    this.updateData({
      section,
      title: lifeSectionTitles[section],
      topInset: Math.max(
        wx.getMenuButtonBoundingClientRect().bottom + 16,
        info.statusBarHeight + 44,
      ),
      bottomInset: Math.max(16, info.screenHeight - (info.safeArea?.bottom ?? info.screenHeight)),
    });
    void this.loadItems(true);
  },
  onUnload() {
    this.runtime.unloaded = true;
    this.runtime.generation++;
    this.runtime.center = null;
  },
  goBack() {
    wx.navigateBack();
  },
  async setTime(event: WechatMiniprogram.PickerChange) {
    this.updateData({ timeIndex: Number(event.detail.value) });
    await this.loadItems(true);
  },
  async setKind(event: WechatMiniprogram.PickerChange) {
    this.updateData({ kindIndex: Number(event.detail.value) });
    await this.loadItems(true);
  },
  async setLocation(event: WechatMiniprogram.PickerChange) {
    if (this.data.locating) return;
    const index = Number(event.detail.value);
    if (index >= 3) {
      this.updateData({ locating: true, error: "" });
      try {
        await this.currentCenter();
      } catch {
        this.updateData({
          error: "暂时无法获取位置。可在微信设置中允许定位，或选择全部地点继续查看。",
        });
        return;
      } finally {
        this.updateData({ locating: false });
      }
    } else this.runtime.center = null;
    if (this.runtime.unloaded) return;
    this.updateData({ locationIndex: index });
    await this.loadItems(true);
  },
  async currentCenter() {
    const state = this.runtime;
    if (state.center && Date.now() - state.center.acquiredAt < 5 * 60000) return state.center;
    const point = await new Promise<WechatMiniprogram.GetLocationSuccessCallbackResult>(
      (resolve, reject) => {
        wx.getLocation({ type: "gcj02", success: resolve, fail: reject });
      },
    );
    const center = { latitude: point.latitude, longitude: point.longitude, acquiredAt: Date.now() };
    if (!state.unloaded) state.center = center;
    return center;
  },
  async loadItems(reset = false) {
    const state = this.runtime;
    if (state.unloaded || (!reset && (this.data.loading || !this.data.nextCursor))) return;
    const generation = reset ? ++state.generation : state.generation;
    this.updateData({
      loading: true,
      error: "",
      ...(reset ? { items: [], nextCursor: null, loaded: false } : {}),
    });
    try {
      const index = this.data.locationIndex;
      const center = index >= 3 ? await this.currentCenter() : undefined;
      if (generation !== state.generation || state.unloaded) return;
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
        cursor: reset ? undefined : (this.data.nextCursor ?? undefined),
      } satisfies Partial<LifeSearchRequest>);
      const result = await client.request("/v1/life/search", lifeSearchResponseSchema, {
        method: "POST",
        data: input,
        key: await client.newKey(),
      });
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
      });
    } catch (error) {
      if (generation === state.generation) this.updateData({ error: userMessage(error) });
    } finally {
      if (generation === state.generation) this.updateData({ loading: false });
    }
  },
  refresh() {
    void this.loadItems(true);
  },
  loadMore() {
    void this.loadItems();
  },
  retry() {
    void this.loadItems(!this.data.loaded || !this.data.nextCursor);
  },
});
