import { describe, expect, it } from "vitest";
import {
  parsedFacetSchema,
  type ParsedLifeObject,
  type StructuredLifeFacts,
} from "@life/contracts";
import { buildLifeProjection, normalizeLifeFacets, normalizeLifeTime } from "@life/domain";
const context = { referenceTime: "2026-10-05T01:00:00.000Z", timezone: "Asia/Shanghai" };
const facet = (
  facts: StructuredLifeFacts,
  confidence = 0.9,
): ParsedLifeObject["facets"][number] => ({
  type: "EVENT",
  key: "event",
  data: { intent: "EXPERIENCE", description: null, verification: "UNVERIFIED", facts },
  confidence,
  source: "EXTRACTED",
});
const object = (facets: ParsedLifeObject["facets"]) => ({
  title: "阅读与活动安排",
  summary: null,
  kind: "EVENT" as const,
  importance: 0.5,
  facets,
});

describe("source-bounded life facts and calendar normalization", () => {
  it("keeps legacy descriptive facets valid and rejects inverted or fabricated verified facts", () => {
    expect(
      parsedFacetSchema.safeParse({
        type: "DESIRE",
        key: "desire",
        data: { intent: "START", description: null, verification: "UNVERIFIED" },
        confidence: 0.7,
        source: "EXTRACTED",
      }).success,
    ).toBe(true);
    expect(
      parsedFacetSchema.safeParse(
        facet({
          origin: "USER_STATED",
          evidence: "读书20分钟",
          duration: { minSeconds: 1200, maxSeconds: 600 },
        }),
      ).success,
    ).toBe(false);
    expect(
      parsedFacetSchema.safeParse(
        facet({
          origin: "USER_STATED",
          evidence: "路线",
          route: { verification: "PROVIDER_VERIFIED" },
        } as never),
      ).success,
    ).toBe(false);
  });
  it("resolves next-week afternoon as a window, without inventing an exact event clock", () => {
    const result = normalizeLifeTime("下周六下午", context);
    expect(result).toMatchObject({
      exact: null,
      start: "2026-10-17T04:00:00.000Z",
      end: "2026-10-17T09:59:59.999Z",
    });
    const [normalized] = normalizeLifeFacets(
      [
        facet({
          origin: "USER_STATED",
          evidence: "下周六下午参加活动",
          time: { eventStart: "下周六下午" },
        }),
      ],
      context,
    );
    expect(normalized!.data.facts!.time).toEqual({
      eventStart: null,
      windowStart: result.start,
      windowEnd: result.end,
    });
    expect(normalized!.data.normalization!.rawTime).toEqual({ eventStart: "下周六下午" });
  });
  it("anchors relative times to capture time across local midnight, not worker wall clock", () => {
    expect(
      normalizeLifeTime("明天下午3点半", { ...context, referenceTime: "2026-10-05T16:10:00Z" })
        .exact,
    ).toBe("2026-10-07T07:30:00.000Z");
    expect(normalizeLifeTime("明天下午三点半", context).exact).toBe("2026-10-06T07:30:00.000Z");
    expect(normalizeLifeTime("2026年10月8日15:00", context).exact).toBe("2026-10-08T07:00:00.000Z");
    expect(normalizeLifeTime("2026-10-08T15:00:00+08:00", context).exact).toBe(
      "2026-10-08T07:00:00.000Z",
    );
  });
  it("preserves unknown dates, invalid days and DST gaps without fabricating times", () => {
    for (const text of ["有朝一日", "以后", "下午", "2026-02-30", "2026-02-30T10:00:00+08:00"])
      expect(normalizeLifeTime(text, context).start).toBeNull();
    expect(
      normalizeLifeTime("2026-03-08T02:30", {
        referenceTime: context.referenceTime,
        timezone: "America/New_York",
      }).exact,
    ).toBeNull();
    expect(normalizeLifeTime("明天", { ...context, timezone: "Not/AZone" }).warnings).toContain(
      "TIMEZONE_INVALID",
    );
  });
  it("projects only USER_STATED duration/cost and keeps available time or budget separate", () => {
    const stated = facet(
      {
        origin: "USER_STATED",
        evidence: "需要20分钟，门票50元",
        duration: { minSeconds: 1200, maxSeconds: 1200, role: "REQUIRED" },
        money: { minMinor: 5000, maxMinor: 5000, currency: "CNY", role: "COST" },
      },
      0.5,
    );
    const inferred = facet(
      {
        origin: "INFERRED",
        evidence: "推断",
        duration: { minSeconds: 3600 },
        money: { minMinor: 10000, currency: "CNY" },
        place: { province: "新疆" },
      },
      1,
    );
    const projected = buildLifeProjection(object([inferred, stated]), context);
    expect(projected).toMatchObject({
      durationMinSeconds: 1200,
      costMinMinor: 5000,
      latitude: null,
      longitude: null,
    });
    expect(projected.actionFacts?.place).toBeUndefined();
    expect(projected.actionFacts?.origin).toBe("USER_STATED");
    const available = buildLifeProjection(
      object([
        facet({
          origin: "USER_STATED",
          evidence: "有20分钟，预算50元",
          duration: { maxSeconds: 1200, role: "AVAILABLE" },
          money: { maxMinor: 5000, currency: "CNY", role: "BUDGET" },
        }),
      ]),
      context,
    );
    expect(available).toMatchObject({
      durationMinSeconds: null,
      durationMaxSeconds: null,
      costMinMinor: null,
      costMaxMinor: null,
    });
    expect(available.actionFacts?.money?.maxMinor).toBe(5000);
  });
  it("keeps regional travel destination and current origin distinct, with no guessed coordinates", () => {
    const projected = buildLifeProjection(
      object([
        facet({
          origin: "USER_STATED",
          evidence: "我在广东，有朝一日去新疆旅行",
          activityKind: "TRAVEL",
          horizon: "LONG_TERM",
          place: { province: "新疆", latitude: 43.8, longitude: 87.6, coordinateSystem: "GCJ02" },
          originContext: { province: "广东" },
        }),
      ]),
      context,
    );
    expect(projected.actionFacts).toMatchObject({
      activityKind: "TRAVEL",
      horizon: "LONG_TERM",
      place: { province: "新疆" },
      originContext: { province: "广东" },
    });
    expect(projected.latitude).toBeNull();
    expect(projected.nextAt).toBeNull();
    const coordinates = buildLifeProjection(
      object([
        facet({
          origin: "USER_STATED",
          evidence: "GCJ02位置23.12,113.23",
          place: { latitude: 23.12, longitude: 113.23, coordinateSystem: "GCJ02" },
        }),
      ]),
      context,
    );
    expect(coordinates).toMatchObject({
      latitude: 23.12,
      longitude: 113.23,
      coordinateSystem: "GCJ02",
    });
  });
  it("grounds numeric bounds in cited units and keeps OBJECT budgets separate from CURRENT resources", () => {
    const facts: StructuredLifeFacts = {
      origin: "USER_STATED",
      evidence: "旅行预算三千元；需要半小时到一小时",
      money: { maxMinor: 300000, currency: "CNY", role: "BUDGET", scope: "OBJECT" },
      duration: { minSeconds: 1800, maxSeconds: 3600, role: "REQUIRED", scope: "OBJECT" },
    };
    const projected = buildLifeProjection(object([facet(facts)]), context);
    expect(projected.actionFacts?.money).toMatchObject({ maxMinor: 300000, scope: "OBJECT" });
    expect(projected.durationMinSeconds).toBe(1800);
    expect(projected.durationMaxSeconds).toBe(3600);
    const fabricated = buildLifeProjection(
      object([
        facet({
          ...facts,
          evidence: "去旅行",
          duration: { minSeconds: 1200 },
          money: { maxMinor: 9999, currency: "CNY" },
        }),
      ]),
      context,
    );
    expect(fabricated.actionFacts?.duration).toBeUndefined();
    expect(fabricated.actionFacts?.money).toBeUndefined();
    expect(fabricated.facets[0]!.data.normalization!.warnings).toEqual(
      expect.arrayContaining(["DURATION_NOT_GROUNDED", "MONEY_NOT_GROUNDED"]),
    );
  });
  it("downgrades fabricated USER_STATED evidence when trusted original text disagrees", () => {
    const projected = buildLifeProjection(
      object([
        facet({
          origin: "USER_STATED",
          evidence: "去新疆只要20分钟",
          duration: { minSeconds: 1200, role: "REQUIRED" },
        }),
      ]),
      { ...context, sourceText: "我在广东，想将来去新疆旅行" },
    );
    expect(projected.actionFacts?.origin).toBe("INFERRED");
    expect(projected.durationMinSeconds).toBeNull();
    expect(projected.facets[0]!.data.normalization!.warnings).toContain("EVIDENCE_NOT_IN_SOURCE");
  });
  it("canonicalizes exact EVENT windows and recomputes model-supplied dates from original relative evidence", () => {
    const evidence = "明天下午3点到4点有线上会议";
    const source = facet({
      origin: "USER_STATED",
      evidence,
      time: { windowStart: "2030-01-01T15:00:00+08:00", windowEnd: "2030-01-01T16:00:00+08:00" },
    });
    const result = buildLifeProjection(object([source]), { ...context, sourceText: evidence });
    expect(result.facets[0]!.data.facts!.time).toMatchObject({
      eventStart: "2026-10-06T07:00:00.000Z",
      eventEnd: "2026-10-06T08:00:00.000Z",
    });
    expect(result.facets[0]!.data.normalization!.rawTime).toEqual({
      windowStart: "明天下午3点",
      windowEnd: "明天下午4点",
    });
    const fuzzyEvidence = "明天下午有会议";
    const fuzzy = buildLifeProjection(
      object([
        facet({
          origin: "USER_STATED",
          evidence: fuzzyEvidence,
          time: {
            windowStart: "2030-01-01T15:00:00+08:00",
            windowEnd: "2030-01-01T16:00:00+08:00",
          },
        }),
      ]),
      { ...context, sourceText: fuzzyEvidence },
    );
    expect(fuzzy.facets[0]!.data.facts!.time!.eventStart).toBeUndefined();
    expect(fuzzy.facets[0]!.data.facts!.time!.windowStart).toBe("2026-10-06T04:00:00.000Z");
  });
  it("fills explicit current resource/location omissions without turning trip budget into cash or replacing required duration", () => {
    const sourceText = "我现在在广东，只有20分钟，想去新疆旅行，旅行预算3000元。";
    const stated = facet({
      origin: "USER_STATED",
      evidence: "旅行预算3000元",
      money: { maxMinor: 300000, currency: "CNY", role: "BUDGET", scope: "CURRENT" },
      activityKind: "TRAVEL",
      place: { province: "新疆" },
    });
    const required = facet({
      origin: "USER_STATED",
      evidence: "需要15分钟，门票50元",
      duration: { minSeconds: 900, role: "REQUIRED" },
      money: { minMinor: 5000, currency: "CNY", role: "COST" },
    });
    required.key = "required";
    const ctx = { ...context, sourceText: sourceText + "需要15分钟，门票50元。" };
    const projected = buildLifeProjection(object([stated, required]), ctx);
    expect(
      projected.facets.find((f) => f.key === "source_current_duration")?.data.facts?.duration,
    ).toMatchObject({ minSeconds: 1200, maxSeconds: 1200, scope: "CURRENT", role: "AVAILABLE" });
    expect(
      projected.facets.find((f) => f.key === "source_current_location")?.data.facts?.originContext,
    ).toEqual({ province: "广东", region: "广东" });
    expect(projected.facets[0]!.data.facts!.money!.scope).toBe("OBJECT");
    const contradiction = normalizeLifeFacets(
      [
        facet({
          origin: "USER_STATED",
          evidence: "我现在在广东",
          originContext: { province: "新疆", city: "广东" },
        }),
      ],
      { ...context, sourceText },
    );
    expect(contradiction[0]!.data.facts?.originContext).toBeUndefined();
    expect(projected).toMatchObject({
      durationMinSeconds: 900,
      costMinMinor: 5000,
      latitude: null,
      longitude: null,
    });
    expect(normalizeLifeFacets(projected.facets, ctx)).toHaveLength(projected.facets.length);
  });
  it.each([
    "旅行20分钟",
    "旅行预算3000元",
    "去年我在广东",
    "上周我在广东",
    "2025年，我在广东",
    "明天我在新疆",
    "去年，我在广东，只有20分钟",
    "明天，我在新疆，预算3000元",
    "朋友现在在广东，只有20分钟",
    "如果我现在在广东，只有20分钟",
    "我现在不在广东，在新疆",
    "我现在只有20分钟的旅行视频",
    "我现在想看20分钟纪录片",
    "我现在有20分钟会议",
    "我现在在河南路",
    "他说：我现在在广东",
    "我现在只有20分钟后才有空",
    "我现在预算不是3000元",
  ])(
    "rejects non-current, third-party, conditional or object resource labels: %s",
    (sourceText) => {
      const facts = {
        origin: "USER_STATED" as const,
        evidence: sourceText,
        duration: { minSeconds: 1200, role: "AVAILABLE" as const, scope: "CURRENT" as const },
        money: {
          minMinor: 300000,
          currency: "CNY",
          role: "BUDGET" as const,
          scope: "CURRENT" as const,
        },
        originContext: {
          province: sourceText.includes("新疆")
            ? "新疆"
            : sourceText.includes("河南")
              ? "河南"
              : "广东",
        },
      };
      const result = normalizeLifeFacets([facet(facts)], { ...context, sourceText });
      expect(result.some((f) => f.data.facts?.duration?.scope === "CURRENT")).toBe(false);
      expect(result.some((f) => f.data.facts?.money?.scope === "CURRENT")).toBe(false);
      expect(result.some((f) => f.data.facts?.originContext)).toBe(false);
    },
  );
  it("recognizes Chinese current quantities and lets explicit now override an earlier future clause", () => {
    const result = normalizeLifeFacets([], {
      ...context,
      sourceText: "明天旅行，现在只有二十分钟。我现在只能花二十元。我现在在广西壮族自治区。",
    });
    expect(
      result.find((f) => f.key === "source_current_duration")?.data.facts?.duration?.maxSeconds,
    ).toBe(1200);
    expect(result.find((f) => f.key === "source_current_budget")?.data.facts?.money?.maxMinor).toBe(
      2000,
    );
    expect(
      result.find((f) => f.key === "source_current_location")?.data.facts?.originContext?.province,
    ).toBe("广西");
  });
  it("rebuilds stable projections from stored normalized facets and preserves original time evidence", () => {
    const source = object([
      facet({
        origin: "USER_STATED",
        evidence: "明天下午3点开会，4点结束",
        time: { eventStart: "明天下午3点", eventEnd: "明天下午4点" },
      }),
    ]);
    const first = buildLifeProjection(source, context);
    const second = buildLifeProjection({ ...source, facets: first.facets }, context);
    expect(second.nextAt).toEqual(first.nextAt);
    expect(second.expiresAt).toEqual(first.expiresAt);
    expect(second.facets[0]!.data.normalization!.rawTime).toEqual(
      source.facets[0]!.data.facts!.time,
    );
  });
});
