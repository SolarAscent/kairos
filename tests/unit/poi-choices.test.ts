import { describe, expect, it, vi } from "vitest";
import {
  TencentLbsAdapter,
  isVerifiedGeocodedPlace,
  verifiedDestinationData,
  verifiedDestinationForObject,
  tencentDestinationFacetKey,
  requiresCityConfirmation,
  type PoiChoice,
  type GeocodedPlace,
  type DestinationFacet,
} from "@life/integrations";

const name = "松山湖中心小学";
const school = (id = "school-1", city = "东莞市", province = "广东省") => ({
  id,
  title: name,
  address: `${province}${city}松山湖沁园路1号`,
  type: 0,
  location: { lat: 23.2, lng: 113.4 },
  ad_info: { city, province, district: "" },
});
const response = (rows: unknown[], count = rows.length, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ status: 0, count, data: rows, ...extra }));
const choice: PoiChoice = {
  id: "school-1",
  title: name,
  address: "广东省东莞市松山湖沁园路1号",
  city: "东莞市",
  province: "广东省",
  location: { latitude: 23.2, longitude: 113.4, coordinateSystem: "GCJ02" },
  match: "EXACT_NAME",
};
const selected = (selection = choice): GeocodedPlace => ({
  location: selection.location,
  city: selection.city,
  region: selection.province,
  verificationMethod: "USER_SELECTED_POI",
  selection,
});
const query = { address: name, label: name };

describe("real Tencent POI choice lists", () => {
  it("lists exact same-name POIs across cities without origin/nearest bias", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(response([school(), school("school-2", "厦门市", "福建省")]));
    const result = await new TencentLbsAdapter({ key: "synthetic" }, fetch).searchChoices(name);
    expect(result).toMatchObject({ ok: true, value: [choice, { id: "school-2", city: "厦门市" }] });
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.pathname).toBe("/ws/place/v1/search");
    expect(url.searchParams.get("boundary")).toBe("region(全国,0)");
    expect(url.searchParams.get("page_size")).toBe("20");
    expect(url.searchParams.has("orderby")).toBe(false);
    expect(result.ok && result.value).not.toHaveProperty("uniqueMatches");
  });
  it("keeps an explicit city constraint even when the provider returns another city", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(response([school(), school("school-2", "厦门市", "福建省")]));
    expect(
      await new TencentLbsAdapter({ key: "synthetic" }, fetch).searchChoices(name, "东莞市"),
    ).toEqual({ ok: true, value: [choice] });
    expect(new URL(fetch.mock.calls[0]![0]).searchParams.get("boundary")).toBe("region(东莞市,0)");
  });
  it("does not turn a city word inside an exact venue name into an inferred search city", async () => {
    const rows = [
      { ...school("campus-1", "广州市"), title: "中山大学" },
      { ...school("campus-2", "深圳市"), title: "中山大学" },
    ];
    const fetch = vi.fn().mockResolvedValue(response(rows));
    const result = await new TencentLbsAdapter({ key: "synthetic" }, fetch).searchChoices(
      "中山大学",
    );
    expect(result.ok && result.value.map((item) => item.city)).toEqual(["广州市", "深圳市"]);
    expect(new URL(fetch.mock.calls[0]![0]).searchParams.get("boundary")).toBe("region(全国,0)");
    if (result.ok)
      expect(isVerifiedGeocodedPlace(selected(result.value[0]!), { address: "中山大学" })).toBe(
        true,
      );
  });
  it("does not override a supplied city even when the venue title contains another city word", async () => {
    const row = { ...school("campus-1", "广州市"), title: "中山大学" };
    const fetch = vi.fn().mockResolvedValue(response([row]));
    const result = await new TencentLbsAdapter({ key: "synthetic" }, fetch).searchChoices(
      "中山大学",
      "广州市",
    );
    expect(result.ok && result.value).toHaveLength(1);
    expect(new URL(fetch.mock.calls[0]![0]).searchParams.get("boundary")).toBe("region(广州市,0)");
  });
  it.each([
    "广东省东莞市松山湖中心小学",
    "东莞市松山湖中心小学",
    "东莞松山湖中心小学",
    "广东东莞松山湖中心小学",
    "松山湖 中心小学",
  ])(
    "accepts exact identity after administrative/whitespace normalization: %s",
    async (address) => {
      const adapter = new TencentLbsAdapter({ key: "synthetic" }, async () => response([school()]));
      expect(await adapter.searchChoices(address)).toEqual({ ok: true, value: [choice] });
    },
  );
  it("does not reinterpret an explicit province as a same-name venue in another province", async () => {
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, async () =>
      response([school(), school("school-2", "乌鲁木齐市", "新疆维吾尔自治区")]),
    );
    expect(await adapter.searchChoices(`新疆${name}`)).toMatchObject({
      ok: true,
      value: [{ id: "school-2", city: "乌鲁木齐市" }],
    });
  });
  it("supports an exact full address without changing it into a fuzzy name", async () => {
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, async () => response([school()]));
    expect(await adapter.searchChoices(choice.address)).toEqual({
      ok: true,
      value: [{ ...choice, match: "EXACT_ADDRESS" }],
    });
    expect(await adapter.searchChoices("松山湖小学")).toEqual({ ok: true, value: [] });
  });
  it("allows a partial first page with large total but returns at most six real choices", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => school(`school-${index}`));
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, async () => response(rows, 100));
    const result = await adapter.searchChoices(name);
    expect(result.ok && result.value).toHaveLength(6);
    expect(result.ok && result.value.map((item) => item.id)).toEqual(
      rows.slice(0, 6).map((item) => item.id),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /complete|uniqueMatches|resultCount|reliability|level/,
    );
  });
  it("deduplicates identical ids and rejects conflicts even beyond the first six matches", async () => {
    const fetch = vi.fn().mockResolvedValue(response([school(), school()]));
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, fetch);
    expect(await adapter.searchChoices(name)).toEqual({ ok: true, value: [choice] });
    fetch.mockResolvedValue(
      response([
        ...Array.from({ length: 7 }, (_, index) => school(`school-${index}`)),
        { ...school("school-0"), location: { lat: 24, lng: 114 } },
      ]),
    );
    expect(
      await new TencentLbsAdapter({ key: "synthetic-conflict" }, fetch).searchChoices(name),
    ).toEqual({ ok: false, reason: "INVALID_RESPONSE" });
  });
  it.each([
    { ...school(), type: 3 },
    { ...school(), type: 4 },
    { ...school(), type: 5 },
    { ...school(), title: "松山湖第二小学" },
    { ...school(), location: { lat: 0, lng: 0 } },
    { ...school(), location: { lat: 999, lng: 113 } },
    { ...school(), location: { lat: "23.2", lng: 113.4 } },
    { ...school(), ad_info: { city: "", province: "广东省" } },
    { ...school(), ad_info: { city: "https://private", province: "广东省" } },
    { ...school(), address: "" },
  ])("omits invalid/nonexact candidates individually", async (invalid) => {
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, async () =>
      response([{ ...invalid, id: "invalid" }, school()]),
    );
    expect(await adapter.searchChoices(name)).toEqual({ ok: true, value: [choice] });
  });
  it.each(["学校", "附近学校", "广东省", "广州市", "全国", "书".repeat(33)])(
    "refuses generic/administrative/oversized keywords without querying: %s",
    async (address) => {
      const fetch = vi.fn();
      expect(
        await new TencentLbsAdapter({ key: "synthetic" }, fetch).searchChoices(address),
      ).toEqual({ ok: false, reason: "AMBIGUOUS_ADDRESS" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("never substitutes a city centroid as a venue selection", () => {
    expect(
      isVerifiedGeocodedPlace(selected({ ...choice, title: "东莞市", match: "EXACT_ADDRESS" }), {
        address: choice.address,
      }),
    ).toBe(false);
  });
  it("refuses contradictory supplied city before querying", async () => {
    const fetch = vi.fn();
    expect(
      await new TencentLbsAdapter({ key: "synthetic" }, fetch).searchChoices(
        `东莞市${name}`,
        "厦门市",
      ),
    ).toEqual({ ok: false, reason: "AMBIGUOUS_ADDRESS" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { count: -1, data: [] },
    { count: 1, data: [school(), school("school-2")] },
    { count: "2", data: [] },
    { count: 20, data: Array.from({ length: 21 }, () => school()) },
    { count: 2, data: {} },
  ])("rejects malformed search result envelopes", async (extra) => {
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, async () => response([], 0, extra));
    expect(await adapter.searchChoices(name)).toEqual({ ok: false, reason: "INVALID_RESPONSE" });
  });
});

describe("explicit city confirmation", () => {
  it.each([
    "松山湖中心小学",
    "中山大学",
    "广州图书馆",
    "广东松山湖中心小学",
    "新疆星光书店",
    "天河区星光书店",
  ])("requires choice for a specific venue without declared city: %s", (address) => {
    expect(requiresCityConfirmation(address)).toBe(true);
  });
  it.each([
    "",
    "学校",
    "附近学校",
    "广东",
    "广东省",
    "东莞",
    "广州市",
    "天河区",
    "新疆维吾尔自治区",
    "阿里地区",
    "广东省东莞市松山湖中心小学",
  ])(
    "does not classify a coarse/generic destination or explicit city as an unqualified venue: %s",
    (address) => {
      expect(requiresCityConfirmation(address)).toBe(false);
    },
  );
  it("respects supplied city even when a venue name contains another city word", () => {
    expect(requiresCityConfirmation("中山大学", "广州市")).toBe(false);
  });
});

describe("bounded public POI result cache", () => {
  it("reuses completed public results across adapters with the same credentials/transport", async () => {
    const fetch = vi.fn().mockResolvedValue(response([school()]));
    const first = new TencentLbsAdapter({ key: "synthetic" }, fetch);
    const second = new TencentLbsAdapter({ key: "synthetic" }, fetch);
    expect(await first.searchChoices(name)).toEqual({ ok: true, value: [choice] });
    expect(await second.searchChoices(name)).toEqual({ ok: true, value: [choice] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("deep clones when storing and reading so callers cannot corrupt trusted candidates", async () => {
    const fetch = vi.fn().mockResolvedValue(response([school()]));
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, fetch);
    const original = await adapter.searchChoices(name);
    if (!original.ok) throw new Error("fixture failure");
    original.value[0]!.location.latitude = 0;
    original.value[0]!.city = "厦门市";
    original.value.length = 0;
    const cached = await adapter.searchChoices(name);
    expect(cached).toEqual({ ok: true, value: [choice] });
    if (!cached.ok) throw new Error("fixture failure");
    cached.value[0]!.title = "别的学校";
    cached.value[0]!.location.longitude = 0;
    expect(await adapter.searchChoices(name)).toEqual({ ok: true, value: [choice] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("expires after three minutes without sliding TTL on reads", async () => {
    let clock = 1000000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const fetch = vi.fn().mockResolvedValue(response([school()]));
      const adapter = new TencentLbsAdapter({ key: "synthetic" }, fetch);
      await adapter.searchChoices(name);
      clock += 179999;
      await adapter.searchChoices(name);
      expect(fetch).toHaveBeenCalledTimes(1);
      clock += 1;
      await adapter.searchChoices(name);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
  it.each([
    { label: "quota failure", first: () => new Response(JSON.stringify({ status: 121 })) },
    { label: "empty list", first: () => response([]) },
    { label: "invalid envelope", first: () => response([school()], 0) },
    {
      label: "conflicting id",
      first: () => response([school(), { ...school(), title: "别的学校" }]),
    },
    {
      label: "invalid candidate",
      first: () => response([{ ...school(), location: { lat: 0, lng: 0 } }]),
    },
  ])("does not cache $label", async ({ first }) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(first())
      .mockResolvedValue(response([school()]));
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, fetch);
    await adapter.searchChoices(name);
    expect(await adapter.searchChoices(name)).toEqual({ ok: true, value: [choice] });
    expect(await adapter.searchChoices(name)).toEqual({ ok: true, value: [choice] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("separates query, city and credential digests", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const keyword = url.searchParams.get("keyword")!;
      const city = url.searchParams.get("boundary")!.includes("厦门") ? "厦门市" : "东莞市";
      return response([
        { ...school("school-1", city, city === "厦门市" ? "福建省" : "广东省"), title: keyword },
      ]);
    });
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, fetch as typeof globalThis.fetch);
    await adapter.searchChoices(name);
    await adapter.searchChoices("星光书店");
    await adapter.searchChoices(name, "东莞市");
    await adapter.searchChoices(name, "厦门市");
    await new TencentLbsAdapter(
      { key: "other-key" },
      fetch as typeof globalThis.fetch,
    ).searchChoices(name);
    await new TencentLbsAdapter(
      { key: "synthetic", secret: "other-secret" },
      fetch as typeof globalThis.fetch,
    ).searchChoices(name);
    expect(fetch).toHaveBeenCalledTimes(6);
    await adapter.searchChoices(name);
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it("isolates synthetic transports and checks cancellation/configuration before a cache hit", async () => {
    const firstFetch = vi.fn().mockResolvedValue(response([school()]));
    const secondFetch = vi.fn().mockResolvedValue(response([school()]));
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, firstFetch);
    await adapter.searchChoices(name);
    await new TencentLbsAdapter({ key: "synthetic" }, secondFetch).searchChoices(name);
    expect(secondFetch).toHaveBeenCalledTimes(1);
    const abort = new AbortController();
    abort.abort();
    expect(await adapter.searchChoices(name, undefined, abort.signal)).toEqual({
      ok: false,
      reason: "TIMEOUT",
    });
    expect(await new TencentLbsAdapter({}, firstFetch).searchChoices(name)).toEqual({
      ok: false,
      reason: "NOT_CONFIGURED",
    });
    expect(firstFetch).toHaveBeenCalledTimes(1);
  });
  it("evicts the least recently used public entry when more than 100 queries succeed", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) =>
      response([{ ...school(), title: new URL(String(input)).searchParams.get("keyword")! }]),
    );
    const adapter = new TencentLbsAdapter({ key: "synthetic" }, fetch as typeof globalThis.fetch);
    for (let index = 0; index < 100; index++) await adapter.searchChoices(`星光书店${index}`);
    await adapter.searchChoices("星光书店0");
    await adapter.searchChoices("星光书店100");
    expect(fetch).toHaveBeenCalledTimes(101);
    await adapter.searchChoices("星光书店0");
    expect(fetch).toHaveBeenCalledTimes(101);
    await adapter.searchChoices("星光书店1");
    expect(fetch).toHaveBeenCalledTimes(102);
  });
});

describe("bounded nationwide city cluster branches", () => {
  const clusters = [
    { title: "东莞市", count: 2 },
    { title: "厦门市", count: 1 },
    { title: "深圳市", count: 1 },
    { title: "北京市", count: 1 },
  ];
  it("queries at most three actual cluster cities and uses only returned POI coordinates", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const boundary = new URL(String(input)).searchParams.get("boundary");
      if (boundary === "region(全国,0)") return response([], 5, { cluster: clusters });
      const city = boundary!.slice(7, -3);
      return response([
        school(
          `school-${clusters.findIndex((item) => item.title === city) + 1}`,
          city,
          city === "厦门市" ? "福建省" : "广东省",
        ),
      ]);
    });
    const result = await new TencentLbsAdapter(
      { key: "synthetic" },
      fetch as typeof globalThis.fetch,
    ).searchChoices(name);
    expect(result.ok && result.value.map((item) => item.city)).toEqual([
      "东莞市",
      "厦门市",
      "深圳市",
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain("region(北京市,0)");
  });
  it("never builds choices from a cluster or claims an empty list when branches fail quotas", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) =>
      new URL(String(input)).searchParams.get("boundary") === "region(全国,0)"
        ? response([], 5, { cluster: clusters })
        : new Response(JSON.stringify({ status: 121, message: "private" })),
    );
    expect(
      await new TencentLbsAdapter(
        { key: "synthetic" },
        fetch as typeof globalThis.fetch,
      ).searchChoices(name),
    ).toEqual({ ok: false, reason: "QUOTA_EXCEEDED" });
  });
  it("retains a verified partial candidate list when another city fails", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const boundary = new URL(String(input)).searchParams.get("boundary");
      if (boundary === "region(全国,0)") return response([], 3, { cluster: clusters.slice(0, 2) });
      return boundary === "region(东莞市,0)"
        ? response([school()])
        : new Response(JSON.stringify({ status: 121 }));
    });
    expect(
      await new TencentLbsAdapter(
        { key: "synthetic" },
        fetch as typeof globalThis.fetch,
      ).searchChoices(name),
    ).toEqual({ ok: true, value: [choice] });
  });
  it("does not follow clusters on an explicitly scoped response", async () => {
    const fetch = vi.fn().mockResolvedValue(response([school()], 5, { cluster: clusters }));
    expect(
      await new TencentLbsAdapter({ key: "synthetic" }, fetch).searchChoices(name, "东莞市"),
    ).toEqual({ ok: true, value: [choice] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("ignores invalid city clusters instead of inventing a location", async () => {
    const fetch = vi.fn().mockResolvedValue(
      response([], 3, {
        cluster: [
          { title: "广东省", count: 1 },
          { title: "https://private", count: 1 },
          { title: "东莞市", count: -1 },
        ],
      }),
    );
    expect(await new TencentLbsAdapter({ key: "synthetic" }, fetch).searchChoices(name)).toEqual({
      ok: true,
      value: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds stalled transport and honors cancellation immediately", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const adapter = new TencentLbsAdapter({ key: "synthetic", timeoutMs: 10 }, fetch);
    expect(await adapter.searchChoices(name)).toEqual({ ok: false, reason: "TIMEOUT" });
    const abort = new AbortController();
    const pending = adapter.searchChoices(name, undefined, abort.signal);
    abort.abort();
    expect(await pending).toEqual({ ok: false, reason: "TIMEOUT" });
  });
  it("deduplicates city aliases instead of spending a branch on both city spellings", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) =>
      new URL(String(input)).searchParams.get("boundary") === "region(全国,0)"
        ? response([], 2, {
            cluster: [
              { title: "东莞", count: 1 },
              { title: "东莞市", count: 1 },
            ],
          })
        : response([school()]),
    );
    expect(
      await new TencentLbsAdapter(
        { key: "synthetic" },
        fetch as typeof globalThis.fetch,
      ).searchChoices(name),
    ).toEqual({ ok: true, value: [choice] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects a contradictory POI id across city branch results", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const boundary = new URL(String(input)).searchParams.get("boundary");
      if (boundary === "region(全国,0)") return response([], 2, { cluster: clusters.slice(0, 2) });
      return boundary === "region(东莞市,0)"
        ? response([school()])
        : response([school("school-1", "厦门市", "福建省")]);
    });
    expect(
      await new TencentLbsAdapter(
        { key: "synthetic" },
        fetch as typeof globalThis.fetch,
      ).searchChoices(name),
    ).toEqual({ ok: false, reason: "INVALID_RESPONSE" });
  });
});

describe("user-selected POI provenance and persistence", () => {
  it("requires an explicit original query and does not fabricate uniqueness or reliability", () => {
    expect(isVerifiedGeocodedPlace(selected(), query)).toBe(true);
    expect(isVerifiedGeocodedPlace(selected())).toBe(false);
    const data = verifiedDestinationData(query, selected(), "2026-10-07T06:00:00Z");
    expect(data).toMatchObject({
      verification: "EXTERNAL_VERIFIED",
      location: {
        source: "EXTERNAL_VERIFIED",
        provider: "TENCENT",
        verificationMethod: "USER_SELECTED_POI",
        query: { address: name },
        selection: choice,
      },
    });
    expect(data.location).not.toHaveProperty("poi");
    expect(data.location).not.toHaveProperty("reliability");
    expect(data.location).not.toHaveProperty("level");
  });
  it("can select either real city from an unqualified nationwide name", () => {
    const other = {
      ...choice,
      id: "school-2",
      city: "厦门市",
      province: "福建省",
      address: "福建省厦门市同名学校",
    };
    expect(isVerifiedGeocodedPlace(selected(other), query)).toBe(true);
    expect(isVerifiedGeocodedPlace(selected(other), { ...query, city: "东莞市" })).toBe(false);
    expect(isVerifiedGeocodedPlace(selected(other), { ...query, address: `东莞市${name}` })).toBe(
      false,
    );
  });
  it.each([
    { ...choice, title: "松山湖第二小学" },
    { ...choice, match: "EXACT_ADDRESS" as const },
    { ...choice, location: { ...choice.location, latitude: 999 } },
    { ...choice, location: { ...choice.location, coordinateSystem: "WGS84" as "GCJ02" } },
    { ...choice, city: "https://private" },
    {} as PoiChoice,
  ])("rejects forged or malformed selected provenance safely", (selection) => {
    expect(isVerifiedGeocodedPlace({ ...selected(), selection }, query)).toBe(false);
  });
  it("rejects detached result coordinates and contradictory city/province metadata", () => {
    expect(
      isVerifiedGeocodedPlace(
        { ...selected(), location: { ...choice.location, latitude: 24 } },
        query,
      ),
    ).toBe(false);
    expect(isVerifiedGeocodedPlace({ ...selected(), city: "厦门市" }, query)).toBe(false);
    expect(isVerifiedGeocodedPlace({ ...selected(), region: "福建省" }, query)).toBe(false);
    expect(() =>
      verifiedDestinationData(query, selected({ ...choice, title: "别的学校" }), "now"),
    ).toThrow("INVALID_VERIFIED_DESTINATION");
  });
  it("restores only while original address/city and external source still match", () => {
    const object = { title: name, kind: "PLACE" };
    const data = verifiedDestinationData(query, selected(), "2026-10-07T06:00:00Z");
    const facet: DestinationFacet = {
      facetKey: tencentDestinationFacetKey,
      originType: "EXTERNAL_VERIFIED",
      data,
    };
    expect(verifiedDestinationForObject(object, [facet])).toEqual(choice.location);
    expect(
      verifiedDestinationForObject({ ...object, title: "松山湖第二小学" }, [facet]),
    ).toBeUndefined();
    for (const invalid of [
      { ...facet, originType: "USER_STATED" },
      {
        ...facet,
        data: { ...data, location: { ...data.location, query: { address: "别的学校" } } },
      },
      {
        ...facet,
        data: { ...data, location: { ...data.location, query: { address: name, city: "东莞市" } } },
      },
      {
        ...facet,
        data: {
          ...data,
          location: { ...data.location, selection: { ...choice, match: undefined } },
        },
      },
      { ...facet, data: { ...data, location: { ...data.location, selection: {} } } },
    ])
      expect(verifiedDestinationForObject(object, [invalid])).toBeUndefined();
  });
});
