import { describe, expect, it } from "vitest";
import {
  destinationQueryForObject,
  verifiedDestinationForObject,
  verifiedDestinationData,
  tencentDestinationFacetKey,
  TencentLbsAdapter,
  isVerifiedGeocodedPlace,
  type GeocodedPlace,
  type DestinationFacet,
} from "@life/integrations";

const object = { title: "广州天河公园", kind: "PLACE" };
const facets: DestinationFacet[] = [
  {
    facetKey: "visit",
    originType: "USER_STATED",
    data: {
      facts: {
        origin: "USER_STATED",
        place: { name: "天河公园", city: "广州市" },
        activityKind: "LOCAL_OUTING",
      },
    },
  },
];
const location = { latitude: 23.13, longitude: 113.36, coordinateSystem: "GCJ02" as const };
describe("destination provenance boundary", () => {
  it("retains explicit district precision without duplicating existing administrative prefixes or street addresses", () => {
    const query = (name: string, region = "天河区") =>
      destinationQueryForObject({ title: name, kind: "PLACE" }, [
        {
          originType: "USER_STATED",
          data: {
            facts: {
              origin: "USER_STATED",
              place: { name, city: "广州市", province: "广东省", region },
            },
          },
        },
      ]);
    for (const name of ["广州图书馆", "广州市广州图书馆", "广东省广州市广州图书馆"])
      expect(query(name)).toEqual({
        address: "广东省广州市天河区广州图书馆",
        city: "广州市",
        label: name,
      });
    for (const name of [
      "广州市天河区广州图书馆",
      "广东省广州市天河区珠江东路4号",
      "广州市珠江东路4号",
    ])
      expect(query(name)?.address).toBe(name);
    expect(query("广州图书馆", "华南")?.address).toBe("广州图书馆");
  });
  it("uses declared destinations and accepts legacy PLACE titles only", () => {
    expect(destinationQueryForObject(object, facets)).toEqual({
      address: "天河公园",
      city: "广州市",
      label: "天河公园",
    });
    expect(destinationQueryForObject(object, [])?.address).toBe(object.title);
    expect(destinationQueryForObject({ ...object, kind: "DESIRE" }, [])).toBeUndefined();
  });
  it("excludes current place facets, originContext, saved HOME and province/city centroids", () => {
    for (const facet of [
      {
        facetKey: "source_current_location",
        originType: "USER_STATED",
        data: { facts: { origin: "USER_STATED", place: { name: "天河公园" } } },
      },
      {
        originType: "USER_STATED",
        data: {
          facts: {
            origin: "USER_STATED",
            originContext: { name: "天河公园", latitude: 23.1, longitude: 113.3 },
          },
        },
      },
      {
        originType: "USER_STATED",
        data: {
          facts: { origin: "USER_STATED", activityKind: "HOME", place: { name: "天河公园" } },
        },
      },
    ])
      expect(destinationQueryForObject(object, [facet])).toBeUndefined();
    expect(destinationQueryForObject({ title: "广州市", kind: "PLACE" }, [])).toBeUndefined();
    expect(destinationQueryForObject({ title: "新疆", kind: "PLACE" }, [])).toBeUndefined();
    for (const title of ["我家", "家里", "我的家", "“广州博物馆”", "'广州博物馆'"])
      expect(destinationQueryForObject({ title, kind: "PLACE" }, [])).toBeUndefined();
    expect(
      destinationQueryForObject({ title: "他说：我现在在广州博物馆", kind: "PLACE" }, []),
    ).toBeUndefined();
    expect(
      destinationQueryForObject({ title: "我家在广州幸福小区", kind: "PLACE" }, []),
    ).toBeUndefined();
  });
  it("shares four-QPS scheduling across adapters in one process and bounds queue waits", async () => {
    const starts: number[] = [];
    const transport = (async () => {
      starts.push(Date.now());
      return new Response(
        JSON.stringify({ status: 0, result: { routes: [{ distance: 500, duration: 2 }] } }),
      );
    }) as typeof fetch;
    const key = `scheduler-${Date.now()}`;
    const a = new TencentLbsAdapter({ key, timeoutMs: 2000, rateIntervalMs: 250 }, transport);
    const b = new TencentLbsAdapter({ key, timeoutMs: 2000, rateIntervalMs: 250 }, transport);
    const results = await Promise.all([
      a.route(location, location),
      b.route(location, location),
      a.route(location, location),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(240);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(240);
    const slow = new TencentLbsAdapter({ key, timeoutMs: 20, rateIntervalMs: 250 }, transport);
    expect(await slow.route(location, location)).toEqual({ ok: false, reason: "TIMEOUT" });
    expect(starts).toHaveLength(3);
  });
  it("classifies provider quota/rate failures without exposing provider messages", async () => {
    for (const [status, reason] of [
      [120, "RATE_LIMITED"],
      [121, "QUOTA_EXCEEDED"],
    ] as const) {
      const adapter = new TencentLbsAdapter(
        { key: "test-key" },
        (async () =>
          new Response(
            JSON.stringify({ status, message: "secret/provider detail" }),
          )) as typeof fetch,
      );
      expect(await adapter.route(location, location)).toEqual({ ok: false, reason });
    }
  });
  it("preserves independent external coordinates only while the destination still matches", () => {
    const destination = destinationQueryForObject(object, facets)!;
    const external: DestinationFacet = {
      facetKey: tencentDestinationFacetKey,
      originType: "EXTERNAL_VERIFIED",
      data: verifiedDestinationData(
        destination,
        {
          location,
          reliability: 10,
          level: 10,
          title: "天河公园",
          city: "广州市",
          region: "广东省",
          district: "天河区",
          verificationMethod: "GEOCODE",
        },
        "2026-10-05T10:00:00Z",
      ),
    };
    expect(verifiedDestinationForObject(object, [...facets, external])).toEqual(location);
    const changed = [
      {
        ...facets[0]!,
        data: { facts: { origin: "USER_STATED", place: { name: "越秀公园", city: "广州市" } } },
      },
      external,
    ];
    expect(verifiedDestinationForObject(object, changed)).toBeUndefined();
    expect(
      verifiedDestinationForObject(object, [...facets, { ...external, originType: "INFERRED" }]),
    ).toBeUndefined();
  });
  it("persists and validates POI method and unique-match evidence without geocoder reliability fiction", () => {
    const query = destinationQueryForObject(object, facets)!;
    const result: GeocodedPlace = {
      location,
      verificationMethod: "POI_SEARCH",
      city: "广州市",
      region: "广东省",
      poi: {
        id: "fixture-poi",
        title: "天河公园",
        address: "广州市天河区中山大道西",
        type: 0,
        city: "广州市",
        province: "广东省",
        district: "天河区",
        query: query.address,
        searchCity: "广州市",
        location,
        resultCount: 1,
        complete: true,
        uniqueMatches: 1,
        match: "EXACT_NAME",
      },
    };
    expect(isVerifiedGeocodedPlace(result, query)).toBe(true);
    const data = verifiedDestinationData(query, result, "2026-10-06T10:00:00Z");
    expect(data.location).toMatchObject({
      verificationMethod: "POI_SEARCH",
      poi: { id: "fixture-poi" },
    });
    expect(data.location).not.toHaveProperty("reliability");
    expect(data.location).not.toHaveProperty("level");
    const external = {
      facetKey: tencentDestinationFacetKey,
      originType: "EXTERNAL_VERIFIED",
      data,
    };
    expect(verifiedDestinationForObject(object, [...facets, external])).toEqual(location);
    for (const poi of [
      { ...result.poi!, city: "深圳市" },
      { ...result.poi!, resultCount: 1111 },
      { ...result.poi!, uniqueMatches: 2 },
      { ...result.poi!, query: "别的地方" },
      { ...result.poi!, location: { ...location, latitude: 22 } },
    ]) {
      expect(
        verifiedDestinationForObject(object, [
          ...facets,
          { ...external, data: { ...data, location: { ...data.location, poi } } },
        ]),
      ).toBeUndefined();
    }
    expect(isVerifiedGeocodedPlace({ ...result, city: 22 as unknown as string }, query)).toBe(
      false,
    );
  });
});
