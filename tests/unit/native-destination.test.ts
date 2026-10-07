import { describe, expect, it, vi } from "vitest";
import {
  userSelectedDestinationData,
  userSelectedDestinationForObject,
  destinationSelectionQueryForObject,
  destinationQueryForObject,
  isUserSelectedMapSelection,
  verifiedDestinationData,
  verifiedDestinationForObject,
  isVerifiedGeocodedPlace,
  TencentLbsAdapter,
  tencentDestinationFacetKey,
  type DestinationFacet,
  type UserSelectedMapSelection,
  type GeocodedPlace,
} from "@life/integrations";
import { BuildDecisionContextService } from "../../apps/api/dist/context/build-decision-context.service.js";

const object = { title: "想去看看图书馆", kind: "PLACE" };
const facts: DestinationFacet[] = [
  {
    data: { facts: { origin: "USER_STATED", activityKind: "LOCAL_OUTING" } },
    originType: "EXTRACTED",
  },
];
const point = { latitude: 23.1, longitude: 113.3, coordinateSystem: "GCJ02" as const };
const selection: UserSelectedMapSelection = {
  name: "我选定的图书馆",
  address: "我在原生地图确认的地址",
  location: point,
};
const nativeQuery = { address: object.title, label: object.title };
const observedAt = "2026-10-07T06:00:00Z";
const data = userSelectedDestinationData(nativeQuery, selection, observedAt);
const facet: DestinationFacet = {
  facetKey: tencentDestinationFacetKey,
  originType: "USER_STATED",
  data,
};

describe("explicit native-map destination intent", () => {
  it("binds native selection to a wish title without promoting that fallback to a geocoding query", () => {
    expect(destinationQueryForObject(object, facts)).toBeUndefined();
    expect(destinationSelectionQueryForObject(object, facts)).toEqual(nativeQuery);
    expect(destinationQueryForObject(object, [...facts, facet])).toBeUndefined();
    expect(userSelectedDestinationForObject(object, [...facts, facet])).toEqual({
      location: point,
      name: selection.name,
      address: selection.address,
      source: "USER_SELECTED_MAP",
      scope: "USER_CONFIRMED_INTENT",
    });
    expect(verifiedDestinationForObject(object, [...facts, facet])).toBeUndefined();
  });
  it("stores user origin and selected map intent without claiming external verification", () => {
    expect(data.verification).toBe("USER_CONFIRMED");
    expect(data.location.source).toBe("USER_SELECTED_MAP");
    expect(data.location.provider).toBe("WECHAT_NATIVE");
    expect(data.location.selection).toEqual(selection);
    expect(data.location).not.toHaveProperty("reliability");
    expect(data.location).not.toHaveProperty("verificationMethod");
  });
  it("allows a differently named point because an explicit selection confirms the user's intent", () => {
    const different = { ...selection, name: "另一所学校", address: "用户选定地址" };
    const other = {
      ...facet,
      data: userSelectedDestinationData(nativeQuery, different, observedAt),
    };
    expect(userSelectedDestinationForObject(object, [...facts, other])?.name).toBe(different.name);
  });
  it.each([
    { name: "", address: "地址", location: point },
    { name: "名".repeat(241), address: "地址", location: point },
    { name: "名称", address: "", location: point },
    { name: "名称", address: "址".repeat(513), location: point },
    { name: "名称\u0000", address: "地址", location: point },
    { name: "名称", address: "地址", location: { ...point, latitude: 0, longitude: 0 } },
    { name: "名称", address: "地址", location: { ...point, latitude: 999 } },
    { name: "名称", address: "地址", location: { ...point, latitude: 17 } },
    { name: "名称", address: "地址", location: { ...point, longitude: 140 } },
    { name: "名称", address: "地址", location: { ...point, latitude: Number.NaN } },
    { name: "名称", address: "地址", location: { ...point, coordinateSystem: "WGS84" } },
    {},
  ])("rejects malformed/unsupported native selections", (invalid) => {
    expect(isUserSelectedMapSelection(invalid)).toBe(false);
    expect(() =>
      userSelectedDestinationData(nativeQuery, invalid as UserSelectedMapSelection, observedAt),
    ).toThrow("INVALID_USER_SELECTED_DESTINATION");
  });
  it.each([
    { ...facet, originType: "EXTERNAL_VERIFIED" },
    { ...facet, facetKey: "untrusted-map" },
    { ...facet, data: { ...data, verification: "EXTERNAL_VERIFIED" } },
    { ...facet, data: { ...data, location: { ...data.location, source: "EXTERNAL_VERIFIED" } } },
    { ...facet, data: { ...data, location: { ...data.location, provider: "TENCENT" } } },
    { ...facet, data: { ...data, location: { ...data.location, query: { address: "别的心愿" } } } },
    {
      ...facet,
      data: {
        ...data,
        location: { ...data.location, query: { address: object.title, city: "东莞市" } },
      },
    },
    { ...facet, data: { ...data, location: { ...data.location, latitude: 24 } } },
    {
      ...facet,
      data: {
        ...data,
        location: {
          ...data.location,
          selection: { ...selection, location: { ...point, longitude: 114 } },
        },
      },
    },
    { ...facet, data: { ...data, location: { ...data.location, observedAt: "invalid" } } },
    { ...facet, data: { ...data, location: { ...data.location, selection: {} } } },
  ])("rejects forged query/source/provider/coordinate evidence safely", (invalid) => {
    expect(userSelectedDestinationForObject(object, [...facts, invalid])).toBeUndefined();
  });
  it("invalidates a selection when its original wish changes and returns detached coordinates", () => {
    expect(
      userSelectedDestinationForObject({ ...object, title: "另一条心愿" }, [...facts, facet]),
    ).toBeUndefined();
    const result = userSelectedDestinationForObject(object, [...facts, facet])!;
    (result.location as { latitude: number }).latitude = 24;
    expect(userSelectedDestinationForObject(object, [...facts, facet])?.location).toEqual(point);
    expect(data.location.latitude).toBe(point.latitude);
  });
  it("retains query city binding and rejects empty/overlong fallback titles", () => {
    const declared = [
      { data: { facts: { origin: "USER_STATED", place: { name: "图书馆", city: "广州市" } } } },
    ];
    expect(destinationSelectionQueryForObject(object, declared)).toEqual({
      address: "图书馆",
      label: "图书馆",
      city: "广州市",
    });
    expect(destinationSelectionQueryForObject({ ...object, title: " " }, facts)).toBeUndefined();
    expect(
      destinationSelectionQueryForObject({ ...object, title: "心".repeat(241) }, facts),
    ).toBeUndefined();
  });
  it("accepts legacy user-selected POI as intent but excludes automatic geocoder/unique-POI evidence", () => {
    const school = { title: "松山湖中心小学", kind: "PLACE" };
    const query = { address: school.title, label: school.title };
    const place: GeocodedPlace = {
      location: point,
      city: "东莞市",
      region: "广东省",
      verificationMethod: "USER_SELECTED_POI",
      selection: {
        id: "school",
        title: school.title,
        address: "腾讯提供的候选地址",
        city: "东莞市",
        province: "广东省",
        location: point,
        match: "EXACT_NAME",
      },
    };
    const previous: DestinationFacet = {
      facetKey: tencentDestinationFacetKey,
      originType: "EXTERNAL_VERIFIED",
      data: verifiedDestinationData(query, place, observedAt),
    };
    expect(userSelectedDestinationForObject(school, [previous])).toMatchObject({
      source: "USER_SELECTED_POI",
      scope: "USER_CONFIRMED_INTENT",
    });
    for (const method of ["GEOCODE", "POI_SEARCH"])
      expect(
        userSelectedDestinationForObject(school, [
          {
            ...previous,
            data: {
              ...previous.data,
              location: { ...(previous.data.location as object), verificationMethod: method },
            },
          },
        ]),
      ).toBeUndefined();
  });
});

describe("destination selection gate", () => {
  const context = { location: { ...point, source: "DEVICE" as const } };
  const estimate = {
    mode: "walking" as const,
    durationSeconds: 600,
    distanceMeters: 1000,
    costMinor: 0,
    provider: "TENCENT" as const,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  };
  function provider() {
    return {
      configured: true,
      geocode: vi.fn(),
      searchChoices: vi.fn(),
      cityForLocation: vi.fn(),
      route: vi.fn().mockResolvedValue({ ok: true, value: estimate }),
    };
  }
  it("blocks unselected outdoor targets before any provider lookup", async () => {
    const p = provider();
    const result = await new BuildDecisionContextService(undefined as never, p).enrichCandidates(
      context,
      [
        {
          id: "target",
          title: "图书馆",
          kind: "PLACE",
          address: "图书馆",
          requiresUserSelection: true,
        },
      ],
    );
    expect(result.target).toEqual({ status: "UNAVAILABLE", reason: "DESTINATION_UNRESOLVED" });
    expect(p.geocode).not.toHaveBeenCalled();
    expect(p.route).not.toHaveBeenCalled();
    expect(p.searchChoices).not.toHaveBeenCalled();
  });
  it("can calculate a complete round trip to a caller-supplied trusted selected point", async () => {
    const p = provider();
    const result = await new BuildDecisionContextService(undefined as never, p).enrichCandidates(
      context,
      [
        {
          id: "target",
          title: "图书馆",
          kind: "PLACE",
          location: { ...point, latitude: 23.2 },
          requiresUserSelection: true,
        },
      ],
    );
    expect(result.target?.status).toBe("READY");
    expect(p.route).toHaveBeenCalledTimes(2);
    expect(p.geocode).not.toHaveBeenCalled();
  });
  it("never falls back to a high-score geocoder after an empty focused choice list", async () => {
    const p = provider();
    p.searchChoices.mockResolvedValue({ ok: true, value: [] });
    const result = await new BuildDecisionContextService(undefined as never, p).enrichCandidates(
      context,
      [{ id: "target", title: "不存在小学", kind: "PLACE", address: "不存在小学" }],
      { compareModesForId: "target" },
    );
    expect(result.target).toEqual({ status: "UNAVAILABLE", reason: "DESTINATION_UNRESOLVED" });
    expect(p.geocode).not.toHaveBeenCalled();
    expect(p.cityForLocation).not.toHaveBeenCalled();
    expect(p.route).not.toHaveBeenCalled();
  });
});

describe("geocoder evidence floor", () => {
  const query = { address: "广东省东莞市松山湖中心小学", city: "东莞市" };
  const complete: GeocodedPlace = {
    location: point,
    city: "东莞市",
    region: "广东省",
    title: "东莞松山湖中心小学",
    reliability: 9,
    level: 10,
    verificationMethod: "GEOCODE",
  };
  it("needs matching provider identity in addition to confidence scores", () => {
    expect(isVerifiedGeocodedPlace(complete, query)).toBe(true);
    expect(isVerifiedGeocodedPlace({ ...complete, title: undefined }, query)).toBe(false);
    expect(isVerifiedGeocodedPlace({ ...complete, title: "另一所小学" }, query)).toBe(false);
    expect(isVerifiedGeocodedPlace(complete)).toBe(false);
  });
  it.each([
    { ...complete, city: "厦门市" },
    { ...complete, region: "湖南省" },
    { ...complete, city: undefined },
    { ...complete, location: { ...point, latitude: 0, longitude: 0 } },
  ])(
    "rejects administrative contradictions, missing required city or impossible domestic point",
    (value) => {
      expect(isVerifiedGeocodedPlace(value, query)).toBe(false);
    },
  );
  it("rejects explicit district mismatch or missing district", () => {
    const district = { address: "广东省东莞市东城区松山湖中心小学", city: "东莞市" };
    expect(isVerifiedGeocodedPlace(complete, district)).toBe(false);
    expect(isVerifiedGeocodedPlace({ ...complete, district: "南城区" }, district)).toBe(false);
    expect(isVerifiedGeocodedPlace({ ...complete, district: "东城区" }, district)).toBe(true);
    expect(
      isVerifiedGeocodedPlace(
        { ...complete, title: "东城区松山湖中心小学", district: "南城区" },
        { address: "东城区松山湖中心小学", city: "东莞市" },
      ),
    ).toBe(false);
    expect(
      isVerifiedGeocodedPlace(
        { ...complete, region: "福建省", title: "广东松山湖中心小学" },
        { address: "广东松山湖中心小学" },
      ),
    ).toBe(false);
  });
  it("does not store an old bare high-confidence point as sufficient evidence", () => {
    const data = verifiedDestinationData(
      { address: "松山湖中心小学", label: "松山湖中心小学" },
      { location: point, reliability: 10, level: 10 },
      observedAt,
    );
    expect(
      verifiedDestinationForObject({ title: "松山湖中心小学", kind: "PLACE" }, [
        { facetKey: tencentDestinationFacetKey, originType: "EXTERNAL_VERIFIED", data },
      ]),
    ).toBeUndefined();
  });
  it("routes incomplete/conflicting geocoder evidence to scoped exact POI search", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 0,
            result: {
              location: { lat: 23.1, lng: 113.3 },
              title: "另一所小学",
              reliability: 10,
              level: 10,
              address_components: { city: "东莞市", province: "湖南省" },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 0, count: 0, data: [] })));
    expect(
      await new TencentLbsAdapter({ key: "synthetic" }, fetch).geocode(query.address, query.city),
    ).toEqual({ ok: false, reason: "AMBIGUOUS_ADDRESS" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
