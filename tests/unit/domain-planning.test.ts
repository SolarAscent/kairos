import { describe, expect, it } from "vitest";
import {
  planActions,
  planningFacts,
  scoreCandidates,
  nextDecisionQuestion,
  scoringVersion,
  questionPolicyVersion,
  type DecisionCandidate,
  type PlanningContext,
  type PlanningFacts,
} from "@life/domain";

const now = new Date("2026-10-05T10:00:00.000Z");
const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
const origin = { latitude: 23.13, longitude: 113.27, coordinateSystem: "GCJ02" };
const destination = { latitude: 23.14, longitude: 113.28, coordinateSystem: "GCJ02" };
const context: PlanningContext = {
  availableMinutes: 30,
  budgetMinor: 10000,
  location: { ...origin, source: "DEVICE", observedAt: at(-30), expiresAt: at(600) },
};
const fact = (overrides: Partial<PlanningFacts> = {}): PlanningFacts => ({
  origin: "USER_STATED",
  evidence: "用户明确记录",
  activityKind: "HOME",
  duration: { minSeconds: 600, role: "REQUIRED" },
  money: { minMinor: 0, currency: "CNY", role: "COST" },
  ...overrides,
});
const candidate = (overrides: Partial<DecisionCandidate> = {}): DecisionCandidate => ({
  id: "goal",
  title: "整理桌面",
  summary: null,
  kind: "DESIRE",
  importance: 0.7,
  createdAt: now,
  expiresAt: null,
  durationMinSeconds: null,
  costMinMinor: null,
  costMaxMinor: null,
  actionFacts: [fact()],
  ...overrides,
});
const place = (overrides: Partial<DecisionCandidate> = {}): DecisionCandidate =>
  candidate({
    kind: "PLACE",
    title: "附近书店",
    ...destination,
    actionFacts: [
      fact({ activityKind: "LOCAL_OUTING", place: { name: "书店", city: "广州", ...destination } }),
    ],
    route: {
      origin,
      destination,
      durationSeconds: 300,
      returnDurationSeconds: 420,
      distanceMeters: 500,
      mode: "walking",
      provider: "TENCENT",
      verification: "PROVIDER_VERIFIED",
      observedAt: at(-20),
      expiresAt: at(300),
    },
    ...overrides,
  });
const direct = (value: DecisionCandidate, ctx: PlanningContext = context) =>
  planActions(value, ctx, now).find((x) => x.actionKey === value.id + ":DO")!;
const eligible = (value: DecisionCandidate, ctx: PlanningContext = context) =>
  planActions(value, ctx, now).filter((x) => x.filterReason == null);

describe("bounded action planning", () => {
  it("uses the remaining visit-duration blocker after a verified route without assigning AVAILABLE time as required duration", () => {
    const goal = place({
      actionFacts: [
        fact({
          activityKind: "LOCAL_OUTING",
          place: { name: "图书馆", ...destination },
          duration: { role: "AVAILABLE", scope: "CURRENT", minSeconds: 7200 },
        }),
      ],
    });
    const actions = planActions(goal, { ...context, availableMinutes: 120 }, now);
    expect(actions.find((item) => item.actionMode === "DO")).toMatchObject({
      filterReason: "DURATION_UNKNOWN",
      requiredSeconds: null,
    });
    const preparation = actions.find((item) => item.actionMode === "PREPARE")!;
    expect(preparation.headline).toContain("这次停留多久");
    expect(preparation.reasonText).toContain("可用时间，不是活动所需时长");
    expect(preparation.body).not.toContain("核对往返交通");
    expect(preparation.filterReason).toBeNull();
  });
  it("explains the proven time limit after verified transport and keeps DO filtered", () => {
    const actions = planActions(place(), { ...context, availableMinutes: 10 }, now);
    expect(actions.find((item) => item.actionMode === "DO")).toMatchObject({
      filterReason: "TIME_LIMIT",
      requiredSeconds: 1320,
    });
    expect(actions.find((item) => item.actionMode === "PREPARE")?.reasonText).toContain(
      "完整行程需要 22 分钟，超过当前可用的 10 分钟",
    );
  });
  it("ranks executable actions with versioned semantics", () => {
    expect(scoringVersion).toBe("now-engine-v0.3");
    expect(questionPolicyVersion).toBe("questions-adaptive-v0.3");
    const actions = scoreCandidates([candidate()], context, now);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      actionKey: "goal:DO",
      actionMode: "DO",
      requiredSeconds: 600,
      hardFilterReason: null,
      rank: 1,
    });
  });
  it.each(["structured", "legacy"])(
    "offers finite preparation rather than a short direct Xinjiang trip (%s)",
    (kind) => {
      const goal = candidate({
        title: "去新疆旅行",
        kind: "DESIRE",
        actionFacts:
          kind === "legacy"
            ? undefined
            : [
                fact({
                  activityKind: "TRAVEL",
                  horizon: "LONG_TERM",
                  duration: { minSeconds: 172800 },
                  place: { province: "新疆" },
                  originContext: { province: "广东" },
                  money: { minMinor: 500000, currency: "CNY" },
                }),
              ],
      });
      const actions = eligible(goal, { ...context, availableMinutes: 20, willingToGoOut: false });
      expect(actions).toHaveLength(3);
      expect(
        actions.every(
          (x) =>
            x.actionMode === "PREPARE" &&
            x.requiredSeconds! <= 1200 &&
            !x.requiresGoOut &&
            x.requiredCostMinMinor === 0,
        ),
      ).toBe(true);
      expect(actions.map((x) => x.actionKey)).toEqual([
        "goal:PREPARE:DATE",
        "goal:PREPARE:BUDGET",
        "goal:PREPARE:ROUTE",
      ]);
      expect(
        actions.every(
          (x) => x.plan.basis === "PLANNING_ESTIMATE" && x.plan.verification === "UNVERIFIED",
        ),
      ).toBe(true);
      expect(actions.find((x) => x.actionKey.endsWith(":ROUTE"))!.body).toContain("未查询到前");
    },
  );
  it("keeps explicit duration and cost constraints on ordinary actions without inventing a preparation workaround", () => {
    const goal = candidate({
      actionFacts: [
        fact({ duration: { minSeconds: 1200 }, money: { minMinor: 2000, currency: "CNY" } }),
      ],
    });
    expect(planActions(goal, { ...context, availableMinutes: 10 }, now)).toHaveLength(1);
    expect(direct(goal, { ...context, availableMinutes: 10 }).filterReason).toBe("TIME_LIMIT");
    expect(direct(goal, { ...context, budgetMinor: 1000 }).filterReason).toBe("BUDGET_LIMIT");
  });
  it("does not use AVAILABLE time or object BUDGET as action costs or current available resources", () => {
    const goal = candidate({
      actionFacts: [
        fact({
          duration: { maxSeconds: 1200, role: "AVAILABLE", scope: "CURRENT" },
          money: { maxMinor: 500000, currency: "CNY", role: "BUDGET", scope: "OBJECT" },
        }),
      ],
    });
    expect(planningFacts(goal)).toMatchObject({ requiredSeconds: null, costMinMinor: null });
    expect(eligible(goal, { ...context, availableMinutes: 5, budgetMinor: 0 })[0]).toMatchObject({
      requiredSeconds: 300,
      requiredCostMinMinor: 0,
      actionMode: "PREPARE",
    });
  });
  it("does not turn inferred durations, costs or dates into hard facts", () => {
    const goal = candidate({
      actionFacts: [
        fact({
          origin: "INFERRED",
          duration: { minSeconds: 12000 },
          money: { minMinor: 50000, currency: "CNY" },
          time: { deadline: at(-1) },
        }),
      ],
    });
    expect(planningFacts(goal)).toMatchObject({
      requiredSeconds: null,
      costMinMinor: null,
      deadline: null,
    });
    expect(eligible(goal)).toHaveLength(1);
    expect(eligible(goal)[0]!.actionMode).toBe("PREPARE");
  });
  it("merges explicitly stated duration and place across separate facets", () => {
    const goal = candidate({
      actionFacts: [
        fact({ duration: null, money: null, activityKind: "TRAVEL", place: { province: "新疆" } }),
        fact({ duration: { minSeconds: 3600 }, place: { city: "乌鲁木齐" } }),
      ],
    });
    expect(planningFacts(goal)).toMatchObject({
      activityKind: "TRAVEL",
      requiredSeconds: 3600,
      place: { province: "新疆", city: "乌鲁木齐" },
    });
  });
  it("retains nullable/minimum-free bounds without inventing currency conversion", () => {
    const facts = planningFacts(
      candidate({
        actionFacts: [
          fact({
            duration: { minSeconds: null, maxSeconds: 900 },
            money: { minMinor: null, maxMinor: 1000, currency: "USD" },
          }),
        ],
      }),
    );
    expect(facts).toMatchObject({ requiredSeconds: 900, costMinMinor: null, costMaxMinor: null });
  });
  it("offers bounded media experience only when the whole duration is unknown", () => {
    const goal = candidate({
      kind: "MEDIA",
      title: "阅读这本书",
      actionFacts: [fact({ duration: null })],
    });
    const actions = eligible(goal, { ...context, availableMinutes: 5 });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      actionKey: "goal:DO:SEGMENT",
      actionMode: "DO",
      requiredSeconds: 300,
      durationBasis: "PLANNING_ESTIMATE",
      executionType: "VIEW_CONTENT",
    });
    expect(actions[0]!.body).toContain("不要求完成整本");
  });
  it("does not replace explicit 20-minute media duration with a 10-minute segment before a meeting", () => {
    const goal = candidate({
      kind: "MEDIA",
      title: "阅读20分钟",
      actionFacts: [fact({ duration: { minSeconds: 1200 } })],
    });
    const ctx = {
      ...context,
      calendar: { isBusy: false, freeMinutesUntilNextEvent: 10, eventIds: [] },
    };
    const actions = planActions(goal, ctx, now);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      actionKey: "goal:DO",
      filterReason: "TIME_LIMIT",
      requiredSeconds: 1200,
    });
  });
  it("executes the real documentary DESIRE shape as a bounded segment instead of preparing a clearer intention", () => {
    const goal = candidate({
      title: "观看纪录片",
      kind: "DESIRE",
      actionFacts: [
        {
          origin: "USER_STATED",
          evidence: "这会儿只有10分钟，不想出门，想看一小段纪录片。",
          activityKind: "REMOTE",
          horizon: "IMMEDIATE",
          duration: { minSeconds: 600, role: "AVAILABLE", scope: "CURRENT" },
        },
      ],
    });
    const actions = eligible(goal, { availableMinutes: 10, willingToGoOut: false });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      actionKey: "goal:DO:SEGMENT",
      requiredSeconds: 600,
      requiresGoOut: false,
      executionType: "VIEW_CONTENT",
    });
    expect(actions[0]!.body).toContain("到时间就停下");
  });
  it.each(["去电影院看电影", "影院看电影", "去图书馆看书", "去公园看视频"])(
    "does not reinterpret %s as a safe indoor media segment",
    (title) => {
      const goal = candidate({ title, kind: "DESIRE", actionFacts: undefined });
      const actions = planActions(goal, { availableMinutes: 10 }, now);
      expect(actions.some((action) => action.actionKey.endsWith(":DO:SEGMENT"))).toBe(false);
      expect(actions.find((action) => action.actionKey.endsWith(":DO"))).toMatchObject({
        requiresGoOut: true,
        filterReason: "ROUTE_UNVERIFIED",
      });
      expect(
        actions
          .filter((action) => action.filterReason == null)
          .every((action) => action.actionMode === "PREPARE"),
      ).toBe(true);
    },
  );
  it("keeps explicit required documentary duration rather than substituting a partial experience", () => {
    const goal = candidate({
      title: "看纪录片20分钟",
      actionFacts: [
        fact({ activityKind: "REMOTE", duration: { minSeconds: 1200, role: "REQUIRED" } }),
      ],
    });
    const actions = planActions(goal, { availableMinutes: 10 }, now);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      actionKey: "goal:DO",
      requiredSeconds: 1200,
      filterReason: "TIME_LIMIT",
    });
  });
  it("does not interpret a negated request to leave home as an outing", () => {
    const goal = candidate({
      title: "不想出门，看一小段纪录片",
      actionFacts: [fact({ activityKind: "HOME", duration: null })],
    });
    expect(eligible(goal, { availableMinutes: 10, willingToGoOut: false })[0]).toMatchObject({
      actionKey: "goal:DO:SEGMENT",
      requiresGoOut: false,
    });
  });
});

describe("temporal eligibility and calendar conflicts", () => {
  it.each(["deadline", "eventEnd", "windowEnd"] as const)(
    "never prepares an already expired %s",
    (field) => {
      const goal = candidate({
        title: "远期旅行",
        actionFacts: [fact({ activityKind: "TRAVEL", time: { [field]: at(-1) } })],
      });
      const actions = planActions(goal, context, now);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.filterReason).toBe("EXPIRED");
    },
  );
  it("respects explicit source expiry independently of future event facts", () => {
    expect(
      eligible(
        candidate({ expiresAt: now, actionFacts: [fact({ time: { eventStart: at(3600) } })] }),
      ),
    ).toHaveLength(0);
  });
  it("prepares a future event instead of executing it now", () => {
    const goal = candidate({
      kind: "EVENT",
      title: "明晚线上讲座",
      actionFacts: [
        fact({ activityKind: "REMOTE", time: { eventStart: at(86400), eventEnd: at(90000) } }),
      ],
    });
    expect(direct(goal).filterReason).toBe("NOT_STARTED");
    expect(eligible(goal)[0]).toMatchObject({ actionMode: "PREPARE", requiredSeconds: 180 });
    expect(eligible(goal)[0]!.body).toContain("核对开始和结束时间");
  });
  it("treats a broad availability window as a window, not a fabricated appointment", () => {
    const goal = candidate({
      actionFacts: [fact({ time: { windowStart: at(3600), windowEnd: at(7200) } })],
    });
    expect(direct(goal).plan).toMatchObject({ windowStartAt: at(3600), windowEndAt: at(7200) });
    expect(direct(goal).plan.scheduledStartAt).toBeUndefined();
    expect(direct(goal).filterReason).toBe("NOT_STARTED");
  });
  it("uses all time constraints, including the earliest deadline and latest start", () => {
    expect(
      direct(
        candidate({
          actionFacts: [
            fact({ time: { eventStart: at(-1200), windowStart: at(600), eventEnd: at(7200) } }),
          ],
        }),
      ).filterReason,
    ).toBe("NOT_STARTED");
    expect(
      direct(
        candidate({ actionFacts: [fact({ time: { deadline: at(300), eventEnd: at(7200) } })] }),
      ).filterReason,
    ).toBe("TIME_WINDOW_LIMIT");
  });
  it("will not prepare beyond the earliest event/deadline", () => {
    const goal = candidate({
      actionFacts: [
        fact({ horizon: "LONG_TERM", time: { eventStart: at(120), deadline: at(1000) } }),
      ],
    });
    expect(eligible(goal)).toHaveLength(0);
    expect(
      planActions(goal, context, now)
        .filter((x) => x.actionMode === "PREPARE")
        .every((x) => x.filterReason === "TIME_WINDOW_LIMIT"),
    ).toBe(true);
  });
  it.each(["busy", "zero"])("keeps the whole recommendation quiet with %s current time", (mode) => {
    const ctx: PlanningContext =
      mode === "busy"
        ? { ...context, calendar: { isBusy: true, eventIds: ["meeting"] } }
        : { ...context, availableMinutes: 0 };
    const goal = candidate({
      title: "去新疆旅行",
      actionFacts: [fact({ activityKind: "TRAVEL" })],
    });
    expect(eligible(goal, ctx)).toHaveLength(0);
  });
  it("filters actions that overlap confirmed busy windows but permits a small step before them", () => {
    const ctx: PlanningContext = {
      ...context,
      busyWindows: [{ startAt: at(500), endAt: at(2000), source: "ACCEPTED_PLAN" }],
    };
    expect(direct(candidate(), ctx).filterReason).toBe("EVENT_CONFLICT");
    const goal = candidate({ actionFacts: [fact({ activityKind: "TRAVEL" })] });
    expect(eligible(goal, ctx).map((x) => x.actionKey)).toEqual([
      "goal:PREPARE:DATE",
      "goal:PREPARE:BUDGET",
    ]);
  });
});

describe("route and availability evidence", () => {
  it("counts distinct outbound and return routes in the actual action duration", () => {
    const actions = eligible(place());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      actionMode: "DO",
      requiredSeconds: 1320,
      durationBasis: "VERIFIED_ROUTE",
      plan: { travelSeconds: 300, returnSeconds: 420, activitySeconds: 600, totalSeconds: 1320 },
    });
    expect(actions[0]!.body).toContain("营业与入场条件尚未核实");
    expect(direct(place(), { ...context, availableMinutes: 20 }).filterReason).toBe("TIME_LIMIT");
  });
  it.each([
    "missing",
    "expired",
    "future",
    "return missing",
    "origin changed",
    "destination changed",
    "saved home",
    "current expired",
  ])("does not claim route verification when %s", (mode) => {
    const goal = place();
    let ctx = { ...context };
    if (mode === "missing") goal.route = null;
    if (mode === "expired") goal.route!.expiresAt = at(-1);
    if (mode === "future") goal.route!.observedAt = at(60);
    if (mode === "return missing") goal.route!.returnDurationSeconds = null;
    if (mode === "origin changed")
      ctx = { ...ctx, location: { ...context.location!, latitude: 23.2 } };
    if (mode === "destination changed") goal.latitude = 23.3;
    if (mode === "saved home")
      ctx = { ...ctx, location: { ...context.location!, source: "SAVED_HOME" } };
    if (mode === "current expired")
      ctx = { ...ctx, location: { ...context.location!, expiresAt: at(-1) } };
    expect(direct(goal, ctx).filterReason).toBe("ROUTE_UNVERIFIED");
    expect(eligible(goal, ctx).every((x) => x.actionMode === "PREPARE")).toBe(true);
  });
  it("does not turn different-region intent into a verified local outing", () => {
    const goal = candidate({
      actionFacts: [
        fact({
          activityKind: "TRAVEL",
          place: { province: "新疆" },
          originContext: { province: "广东" },
        }),
      ],
    });
    expect(direct(goal, { ...context, location: undefined }).filterReason).toBe(
      "REGION_REQUIRES_TRAVEL",
    );
    expect(
      eligible(goal, { ...context, location: undefined }).every((x) => x.actionMode === "PREPARE"),
    ).toBe(true);
  });
  it("respects current trusted unavailability without treating a stale observation as current", () => {
    const goal = place({
      availability: {
        status: "UNAVAILABLE",
        source: "PROVIDER_VERIFIED",
        observedAt: at(-20),
        expiresAt: at(300),
      },
    });
    expect(direct(goal).filterReason).toBe("UNAVAILABLE");
    expect(eligible(goal)[0]!.actionMode).toBe("PREPARE");
    goal.availability!.expiresAt = at(-1);
    expect(direct(goal).filterReason).toBeNull();
    expect(direct(goal).body).toContain("营业与入场条件尚未核实");
  });
  it("requires booking and venue-event participation evidence independently of a route", () => {
    const goal = place({
      availability: {
        status: "AVAILABLE",
        source: "USER_CONFIRMED",
        observedAt: at(-20),
        expiresAt: at(300),
        needsBooking: true,
        bookingConfirmed: false,
      },
    });
    expect(direct(goal).filterReason).toBe("BOOKING_UNCONFIRMED");
    goal.availability!.bookingConfirmed = true;
    expect(direct(goal).filterReason).toBeNull();
    const event = place({ kind: "EVENT", availability: null });
    expect(direct(event).filterReason).toBe("ADMISSION_UNCONFIRMED");
    expect(eligible(event)[0]!.body).toContain("开放或活动时间");
  });
  it("permits a cheaper indoor preparation without ignoring direct cost or go-out restrictions", () => {
    const goal = place({
      actionFacts: [
        fact({ activityKind: "LOCAL_OUTING", money: { minMinor: 20000, currency: "CNY" } }),
      ],
    });
    expect(direct(goal).filterReason).toBe("BUDGET_LIMIT");
    expect(eligible(goal).every((x) => x.requiredCostMinMinor === 0 && !x.requiresGoOut)).toBe(
      true,
    );
    expect(direct(place(), { ...context, willingToGoOut: false }).filterReason).toBe(
      "NOT_GOING_OUT",
    );
  });
  it("does not ask to choose between several preparations or a single source's modes", () => {
    const travel = candidate({
      title: "去新疆旅行",
      actionFacts: [fact({ activityKind: "TRAVEL", horizon: "LONG_TERM" })],
    });
    expect(nextDecisionQuestion([travel], {}, [], now)).toBeNull();
    expect(
      nextDecisionQuestion(
        [place()],
        { ...context, availableMinutes: undefined, budgetMinor: undefined },
        [],
        now,
      ),
    ).toBeNull();
    expect(nextDecisionQuestion([travel, { ...travel, id: "other" }], {}, [], now)).toBeNull();
  });
});
