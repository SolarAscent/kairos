import type { NowContext } from "@life/contracts";

export interface PlanningPlace {
  name?: string | null;
  region?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  coordinateSystem?: string | null;
}
export interface PlanningFacts {
  origin: "USER_STATED" | "INFERRED";
  evidence: string;
  duration?: {
    minSeconds?: number | null;
    maxSeconds?: number | null;
    role?: "REQUIRED" | "AVAILABLE";
    scope?: "CURRENT" | "OBJECT";
  } | null;
  money?: {
    minMinor?: number | null;
    maxMinor?: number | null;
    currency: string;
    role?: "COST" | "BUDGET";
    scope?: "CURRENT" | "OBJECT";
  } | null;
  time?: {
    windowStart?: string | null;
    windowEnd?: string | null;
    deadline?: string | null;
    eventStart?: string | null;
    eventEnd?: string | null;
  } | null;
  place?: PlanningPlace | null;
  originContext?: PlanningPlace | null;
  activityKind?: "TRAVEL" | "LOCAL_OUTING" | "HOME" | "REMOTE" | "OTHER" | null;
  horizon?: "IMMEDIATE" | "SCHEDULED" | "LONG_TERM" | "UNKNOWN" | null;
}
export interface VerifiedRoute {
  durationSeconds: number;
  returnDurationSeconds?: number | null;
  distanceMeters?: number | null;
  returnDistanceMeters?: number | null;
  mode: string;
  provider: string;
  observedAt: string | Date;
  expiresAt: string | Date;
  verification: "PROVIDER_VERIFIED";
  origin?: PlanningPlace;
  destination?: PlanningPlace;
}
export interface VerifiedAvailability {
  status: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
  source: "PROVIDER_VERIFIED" | "USER_CONFIRMED";
  observedAt: string | Date;
  expiresAt: string | Date;
  needsBooking?: boolean;
  bookingConfirmed?: boolean;
}
export interface PlanningContext extends NowContext {
  busyWindows?: Array<{
    startAt: string;
    endAt: string;
    lifeObjectId?: string;
    source: "USER_STATED" | "ACCEPTED_PLAN";
  }>;
}
export interface PlanningCandidate {
  id: string;
  title: string;
  summary: string | null;
  kind: string;
  objectVersion?: number;
  importance: number | null;
  createdAt: Date;
  expiresAt: Date | null;
  costMinMinor: number | null;
  costMaxMinor: number | null;
  durationMinSeconds: number | null;
  durationMaxSeconds?: number | null;
  nextAt?: Date | null;
  latitude?: number | null;
  longitude?: number | null;
  coordinateSystem?: string | null;
  actionFacts?: PlanningFacts[];
  route?: VerifiedRoute | null;
  availability?: VerifiedAvailability | null;
}
export type DurationBasis = "USER_STATED" | "VERIFIED_ROUTE" | "PLANNING_ESTIMATE" | "UNKNOWN";
export interface ActionPlan {
  validUntil?: string;
  mode: "DO" | "PREPARE";
  activitySeconds: number | null;
  travelSeconds: number;
  returnSeconds: number;
  totalSeconds: number | null;
  basis: DurationBasis;
  steps: string[];
  requiresGoOut: boolean;
  targetRegion: string | null;
  verification: "PROVIDER_VERIFIED" | "USER_STATED" | "UNVERIFIED";
  scheduledStartAt?: string;
  scheduledEndAt?: string;
  windowStartAt?: string;
  windowEndAt?: string;
}
export interface PlannedAction {
  actionKey: string;
  actionMode: "DO" | "PREPARE";
  requiredSeconds: number | null;
  durationBasis: DurationBasis;
  requiredCostMinMinor: number | null;
  requiredCostMaxMinor: number | null;
  requiresGoOut: boolean;
  headline: string;
  body: string;
  reasonText: string;
  executionType: "START_TIMER" | "VIEW_CONTENT";
  plan: ActionPlan;
  filterReason: string | null;
  directness: number;
}

const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const timestamp = (value: string | Date | null | undefined): number | null => {
  if (value == null) return null;
  // A vague local phrase must have been normalised before it is a hard fact.
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};
const iso = (value: number | null): string | undefined =>
  value == null ? undefined : new Date(value).toISOString();
function mergePlace(values: Array<PlanningPlace | null | undefined>): PlanningPlace | null {
  const result: PlanningPlace = {};
  for (const value of values)
    if (value)
      for (const [key, item] of Object.entries(value))
        if (item != null && item !== "" && !(key in result)) Object.assign(result, { [key]: item });
  return Object.keys(result).length ? result : null;
}
export function planningFacts(candidate: PlanningCandidate) {
  const stated = (candidate.actionFacts ?? []).filter((fact) => fact.origin === "USER_STATED");
  const inferred = (candidate.actionFacts ?? []).filter((fact) => fact.origin === "INFERRED");
  const strongest = [...stated, ...inferred];
  const durationFacts = stated
    .map((fact) => fact.duration)
    .filter((value) => value && value.role !== "AVAILABLE");
  const costFacts = stated
    .map((fact) => fact.money)
    .filter((value) => value && value.role !== "BUDGET" && value.currency.toUpperCase() === "CNY");
  // Conflicting user statements remain conservative: enough time/money for all
  // stated bounds, rather than silently choosing the shortest or cheapest one.
  const durations = durationFacts.flatMap((value) =>
    value ? [value.minSeconds, value.maxSeconds].filter(finiteNonnegative) : [],
  );
  const costs = costFacts.flatMap((value) =>
    value ? [value.minMinor].filter(finiteNonnegative) : [],
  );
  const maxCosts = costFacts.flatMap((value) =>
    value ? [value.maxMinor].filter(finiteNonnegative) : [],
  );
  const legacy = !candidate.actionFacts?.length;
  const requiredSeconds = durations.length
    ? Math.max(...durations)
    : legacy && finiteNonnegative(candidate.durationMinSeconds)
      ? Math.max(candidate.durationMinSeconds, candidate.durationMaxSeconds ?? 0)
      : null;
  const costMinMinor = costs.length
    ? Math.max(...costs)
    : legacy && finiteNonnegative(candidate.costMinMinor)
      ? candidate.costMinMinor
      : null;
  const costMaxMinor = maxCosts.length
    ? Math.max(...maxCosts)
    : legacy && finiteNonnegative(candidate.costMaxMinor)
      ? candidate.costMaxMinor
      : null;
  const times = stated.map((fact) => fact.time).filter(Boolean);
  const earliest = (field: "windowEnd" | "deadline" | "eventEnd") => {
    const values = times
      .map((time) => timestamp(time?.[field]))
      .filter((value): value is number => value != null);
    return values.length ? Math.min(...values) : null;
  };
  const latest = (field: "windowStart" | "eventStart") => {
    const values = times
      .map((time) => timestamp(time?.[field]))
      .filter((value): value is number => value != null);
    return values.length ? Math.max(...values) : null;
  };
  const place = mergePlace(stated.map((fact) => fact.place));
  const origin = mergePlace(stated.map((fact) => fact.originContext));
  // Legacy free text can conservatively identify an unsafe whole-goal class.
  // This never supplies a price, route, date, coordinates or execution duration.
  const travelHint = /旅行|旅游|出国|跨省|自驾游|度假|长途|\b(?:travel|trip|vacation)\b/iu.test(
    candidate.title,
  );
  const longHint = /长期|以后|将来|梦想|学会|掌握|考证|买房|创业/iu.test(candidate.title);
  const explicitKind = strongest.find(
    (fact) => fact.activityKind && fact.activityKind !== "OTHER",
  )?.activityKind;
  const statedIndoor = stated.some(
    (fact) => fact.activityKind === "HOME" || fact.activityKind === "REMOTE",
  );
  const outingText = candidate.title.replace(/(?:不(?:想|愿意|会|要)?|不要|无需|不用)出门/gu, "");
  const outingHint =
    /出门|(?:去|到|前往).{0,16}(?:影院|电影院|剧院|店|馆|公园)/u.test(outingText) ||
    (!statedIndoor && /电影院|影院|剧院|图书馆|博物馆|咖啡馆|公园/u.test(outingText));
  const activityKind =
    explicitKind ?? (travelHint ? "TRAVEL" : candidate.kind === "PLACE" ? "LOCAL_OUTING" : "OTHER");
  const horizon =
    strongest.find((fact) => fact.horizon && fact.horizon !== "UNKNOWN")?.horizon ??
    (longHint ? "LONG_TERM" : "UNKNOWN");
  return {
    requiredSeconds,
    costMinMinor,
    costMaxMinor,
    place,
    origin,
    activityKind,
    outingHint,
    horizon,
    windowStart: latest("windowStart"),
    windowEnd: earliest("windowEnd"),
    deadline: earliest("deadline"),
    eventStart: latest("eventStart"),
    eventEnd: earliest("eventEnd"),
  };
}
function knownDifferentRegion(
  a: PlanningPlace | null | undefined,
  b: PlanningPlace | null | undefined,
) {
  if (!a || !b) return false;
  const normalize = (value: string) => value.trim().replace(/(?:省|市|自治区|特别行政区)$/u, "");
  for (const key of ["country", "province", "city", "region"] as const) {
    if (a[key] && b[key] && normalize(a[key]!) !== normalize(b[key]!)) return true;
  }
  return false;
}
function sameCoordinates(a: PlanningPlace | null | undefined, b: PlanningPlace | null | undefined) {
  const valid = (place: PlanningPlace | null | undefined) =>
    place?.latitude != null &&
    place.longitude != null &&
    Number.isFinite(place.latitude) &&
    Number.isFinite(place.longitude) &&
    Math.abs(place.latitude) <= 90 &&
    Math.abs(place.longitude) <= 180;
  return (
    valid(a) &&
    valid(b) &&
    a!.latitude != null &&
    a!.longitude != null &&
    b!.latitude != null &&
    b!.longitude != null &&
    a!.coordinateSystem === "GCJ02" &&
    b!.coordinateSystem === "GCJ02" &&
    Math.abs(a!.latitude! - b!.latitude!) < 0.000001 &&
    Math.abs(a!.longitude! - b!.longitude!) < 0.000001
  );
}
function routeIsCurrent(candidate: PlanningCandidate, context: PlanningContext, now: number) {
  const route = candidate.route;
  const observed = timestamp(route?.observedAt),
    expiry = timestamp(route?.expiresAt);
  const destination = {
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    coordinateSystem: candidate.coordinateSystem,
  };
  const currentExpiry = timestamp(context.location?.expiresAt);
  return (
    context.location?.source !== "SAVED_HOME" &&
    (currentExpiry == null || currentExpiry > now) &&
    route?.verification === "PROVIDER_VERIFIED" &&
    finiteNonnegative(route.durationSeconds) &&
    finiteNonnegative(route.returnDurationSeconds) &&
    observed != null &&
    expiry != null &&
    observed <= now + 30000 &&
    expiry > now &&
    sameCoordinates(route.origin, context.location) &&
    sameCoordinates(route.destination, destination)
  );
}
function overlapsBusy(action: PlannedAction, context: PlanningContext, now: number) {
  if (action.requiredSeconds == null) return false;
  const end = now + action.requiredSeconds * 1000;
  return (context.busyWindows ?? []).some((window) => {
    if (!["USER_STATED", "ACCEPTED_PLAN"].includes(window.source)) return false;
    const start = timestamp(window.startAt),
      stop = timestamp(window.endAt);
    return start != null && stop != null && stop > start && now < stop && end > start;
  });
}
function currentAvailability(candidate: PlanningCandidate, now: number) {
  const value = candidate.availability;
  const observed = timestamp(value?.observedAt),
    expiry = timestamp(value?.expiresAt);
  return value &&
    ["PROVIDER_VERIFIED", "USER_CONFIRMED"].includes(value.source) &&
    observed != null &&
    expiry != null &&
    observed <= now + 30000 &&
    expiry > now
    ? value
    : null;
}
function filterAction(
  action: PlannedAction,
  candidate: PlanningCandidate,
  context: PlanningContext,
  now: number,
  facts: ReturnType<typeof planningFacts>,
) {
  const expired = [
    timestamp(candidate.expiresAt),
    facts.deadline,
    facts.eventEnd,
    facts.windowEnd,
  ].some((end) => end != null && end <= now);
  if (expired) return "EXPIRED";
  if (context.calendar?.isBusy) return "EVENT_CONFLICT";
  const available = availableMinutes(context);
  if (
    action.requiredSeconds != null &&
    available != null &&
    action.requiredSeconds > available * 60
  )
    return "TIME_LIMIT";
  if (
    action.requiredCostMinMinor != null &&
    context.budgetMinor != null &&
    action.requiredCostMinMinor > context.budgetMinor
  )
    return "BUDGET_LIMIT";
  if (context.willingToGoOut === false && action.requiresGoOut) return "NOT_GOING_OUT";
  if (overlapsBusy(action, context, now)) return "EVENT_CONFLICT";
  if (action.actionMode === "PREPARE") {
    const due = [facts.deadline, facts.eventStart, facts.windowEnd]
      .filter((value): value is number => value != null && value > now)
      .sort((a, b) => a - b)[0];
    if (
      due != null &&
      due > now &&
      action.requiredSeconds != null &&
      now + action.requiredSeconds * 1000 > due
    )
      return "TIME_WINDOW_LIMIT";
    return null;
  }
  if (facts.horizon === "LONG_TERM") return "LONG_TERM_GOAL";
  const startBounds = [facts.eventStart, facts.windowStart, timestamp(candidate.nextAt)].filter(
    (value): value is number => value != null,
  );
  const starts = startBounds.length ? Math.max(...startBounds) : null;
  if (starts != null && starts > now) return "NOT_STARTED";
  const endBounds = [facts.eventEnd, facts.windowEnd, facts.deadline].filter(
    (value): value is number => value != null,
  );
  const end = endBounds.length ? Math.min(...endBounds) : null;
  if (end != null && action.requiredSeconds != null && now + action.requiredSeconds * 1000 > end)
    return "TIME_WINDOW_LIMIT";
  if (action.requiresGoOut) {
    const availability = currentAvailability(candidate, now);
    if (availability?.status === "UNAVAILABLE") return "UNAVAILABLE";
    if (availability?.needsBooking && !availability.bookingConfirmed) return "BOOKING_UNCONFIRMED";
    if (candidate.kind === "EVENT" && availability?.status !== "AVAILABLE")
      return "ADMISSION_UNCONFIRMED";
    if (!routeIsCurrent(candidate, context, now))
      return knownDifferentRegion(context.location ?? facts.origin, facts.place)
        ? "REGION_REQUIRES_TRAVEL"
        : "ROUTE_UNVERIFIED";
  }
  if (action.requiredSeconds == null) return "DURATION_UNKNOWN";
  if (action.requiredCostMinMinor == null && context.budgetMinor != null) return "COST_UNKNOWN";
  return null;
}

export function availableMinutes(context: PlanningContext) {
  const limits = [
    context.availableMinutes,
    context.calendar?.effectiveAvailableMinutes,
    context.calendar?.freeMinutesUntilNextEvent,
  ].filter((value): value is number => value != null && finiteNonnegative(value));
  return limits.length ? Math.min(...limits) : null;
}
/** Generate bounded actions with their own costs and duration, not renamed goals. */
export function planActions(
  candidate: PlanningCandidate,
  context: PlanningContext,
  now = new Date(context.serverTime ?? Date.now()),
): PlannedAction[] {
  const at = now.getTime();
  const facts = planningFacts(candidate);
  const requiresGoOut =
    facts.activityKind === "TRAVEL" ||
    facts.activityKind === "LOCAL_OUTING" ||
    facts.outingHint ||
    candidate.kind === "PLACE" ||
    (candidate.kind === "EVENT" &&
      facts.place != null &&
      !["HOME", "REMOTE"].includes(facts.activityKind));
  const verifiedRoute = routeIsCurrent(candidate, context, at);
  const availability = currentAvailability(candidate, at);
  const travelSeconds = requiresGoOut && verifiedRoute ? candidate.route!.durationSeconds : 0;
  const returnSeconds =
    requiresGoOut && verifiedRoute ? candidate.route!.returnDurationSeconds! : 0;
  const totalSeconds =
    facts.requiredSeconds == null ? null : facts.requiredSeconds + travelSeconds + returnSeconds;
  const targetRegion = facts.place?.province ?? facts.place?.region ?? facts.place?.city ?? null;
  const basis: DurationBasis =
    requiresGoOut && verifiedRoute
      ? "VERIFIED_ROUTE"
      : facts.requiredSeconds != null
        ? "USER_STATED"
        : "UNKNOWN";
  const directPlan: ActionPlan = {
    ...(() => {
      const ends = [
        facts.windowEnd,
        facts.deadline,
        facts.eventEnd,
        timestamp(candidate.expiresAt),
      ].filter((at): at is number => at != null);
      return ends.length ? { validUntil: new Date(Math.min(...ends)).toISOString() } : {};
    })(),
    mode: "DO",
    activitySeconds: facts.requiredSeconds,
    travelSeconds,
    returnSeconds,
    totalSeconds,
    basis,
    steps: [candidate.title],
    requiresGoOut,
    targetRegion,
    verification:
      requiresGoOut && verifiedRoute
        ? "PROVIDER_VERIFIED"
        : facts.requiredSeconds != null
          ? "USER_STATED"
          : "UNVERIFIED",
    ...(iso(facts.eventStart) ? { scheduledStartAt: iso(facts.eventStart) } : {}),
    ...(iso(facts.eventEnd) ? { scheduledEndAt: iso(facts.eventEnd) } : {}),
    ...(iso(facts.windowStart) ? { windowStartAt: iso(facts.windowStart) } : {}),
    ...(iso(facts.windowEnd) ? { windowEndAt: iso(facts.windowEnd) } : {}),
  };
  const direct: PlannedAction = {
    actionKey: candidate.id + ":DO",
    actionMode: "DO",
    requiredSeconds: totalSeconds,
    durationBasis: basis,
    requiredCostMinMinor: facts.costMinMinor,
    requiredCostMaxMinor: facts.costMaxMinor,
    requiresGoOut,
    headline: requiresGoOut ? `按已核验行程去「${candidate.title}」` : `完成「${candidate.title}」`,
    body:
      totalSeconds == null
        ? "实际所需时长还没有确认。"
        : `给这次行动留出 ${Math.ceil(totalSeconds / 60)} 分钟${requiresGoOut ? "，包括去程、活动和返程" : ""}。${requiresGoOut && availability?.status !== "AVAILABLE" ? "路线核验仅涵盖交通，营业与入场条件尚未核实，出发前请确认。" : ""}`,
    reasonText: requiresGoOut
      ? "这项行动来自你的记录；交通核验不代表营业、预约或入场条件已经核实。"
      : "这项行动来自你的记录；按已知的时间和费用条件安排。",
    executionType: "START_TIMER",
    plan: directPlan,
    filterReason: null,
    directness: 1,
  };
  direct.filterReason = filterAction(direct, candidate, context, at, facts);
  const actions: PlannedAction[] = [direct];
  const mediaHint =
    candidate.kind === "MEDIA" ||
    /阅读|读书|看书|听音乐|听歌|听播客|纪录片|影视|电影|电视剧|视频|\b(?:reading|podcast|documentary|movie|video)\b/iu.test(
      candidate.title,
    );
  if (
    mediaHint &&
    facts.requiredSeconds == null &&
    !requiresGoOut &&
    facts.horizon !== "LONG_TERM" &&
    direct.filterReason !== "EXPIRED"
  ) {
    const seconds = Math.max(
      60,
      Math.floor(
        Math.min(
          600,
          (availableMinutes(context) ?? 10) * 60 - (context.calendar?.availableUntil ? 15 : 0),
        ),
      ),
    );
    const step = `打开手边已有的内容，只体验一小段，到时间就停下；这次不要求完成整本、整集或整门课。`;
    const segment: PlannedAction = {
      ...direct,
      actionKey: candidate.id + ":DO:SEGMENT",
      requiredSeconds: seconds,
      durationBasis: "PLANNING_ESTIMATE",
      headline: `用 ${Math.ceil(seconds / 60)} 分钟体验「${candidate.title}」的一小段`,
      body: step,
      reasonText: "这是一个有边界的体验时段，时长为规划估计，不代表原内容的完整时长。",
      executionType: "VIEW_CONTENT",
      directness: 0.95,
      plan: {
        ...directPlan,
        activitySeconds: seconds,
        totalSeconds: seconds,
        basis: "PLANNING_ESTIMATE",
        steps: [step],
        verification: "UNVERIFIED",
      },
      filterReason: null,
    };
    segment.filterReason = filterAction(segment, candidate, context, at, facts);
    actions.push(segment);
    if (direct.filterReason === "DURATION_UNKNOWN") return actions;
  }
  const future = [facts.eventStart, facts.windowStart, timestamp(candidate.nextAt)].some(
    (value) => value != null && value > at,
  );
  const complex =
    facts.activityKind === "TRAVEL" ||
    requiresGoOut ||
    facts.horizon === "LONG_TERM" ||
    future ||
    facts.requiredSeconds == null;
  if (!complex || direct.filterReason == null || direct.filterReason === "EXPIRED") return actions;
  // Ordinary already-known short activities cannot evade their proven duration
  // or cost by becoming an arbitrary 'prepare' version.
  const destination = facts.place?.name ?? targetRegion ?? candidate.title;
  const proposals: Array<{ key: string; seconds: number; headline: string; steps: string[] }> = [];
  const available = availableMinutes(context);
  const knownRouteBlockers: Record<string, { reason: string; headline: string; step: string }> = {
    DURATION_UNKNOWN: {
      reason: `去程和返程已核验，但还不知道你这次在「${destination}」要停留多久${available != null ? `；当前空闲 ${available} 分钟是可用时间，不是活动所需时长` : ""}，因此暂时无法判断完整行程是否放得下。`,
      headline: `确定「${destination}」这次停留多久`,
      step: "写下这次想做的具体内容和计划停留时长，再与已核验的往返耗时一起比较；出发前确认开放与入场条件。",
    },
    TIME_LIMIT: {
      reason: `去程和返程已核验，但完整行程需要 ${Math.ceil(direct.requiredSeconds! / 60)} 分钟${available != null ? `，超过当前可用的 ${available} 分钟` : ""}。`,
      headline: `给「${destination}」找一段足够的空闲时间`,
      step: "查看接下来的安排，记下一段能容纳去程、活动和返程的时间；这次先不出发。",
    },
    COST_UNKNOWN: {
      reason: "去程和返程已核验，但活动费用尚未确认，暂时无法与当前预算比较。",
      headline: `确认「${destination}」的活动费用`,
      step: "查清门票、参加费用及其他必要支出；未查到的金额先留空。",
    },
    BUDGET_LIMIT: {
      reason: "去程和返程已核验，但已知的活动费用超过当前预算。",
      headline: `核对「${destination}」的费用与预算`,
      step: "记录必要费用和可用预算，看看是否存在已确认的免费或低价时段；先不购买。",
    },
    NOT_GOING_OUT: {
      reason: "去程和返程已核验，但你目前选择了不出门。",
      headline: `为下次去「${destination}」记一项准备`,
      step: "记下一次愿意出门时想做的事情；这次在原地准备。",
    },
    EVENT_CONFLICT: {
      reason: "去程和返程已核验，但完整行程与现有安排冲突。",
      headline: `为「${destination}」核对空闲安排`,
      step: "查看已有安排，记下一段没有冲突的候选时间。",
    },
    NOT_STARTED: {
      reason: "去程和返程已核验，但活动或可参加的时间窗口还没有开始。",
      headline: `记下「${destination}」的开始时间`,
      step: "确认开始与结束时间，记下一项需要提前准备的事情。",
    },
    TIME_WINDOW_LIMIT: {
      reason: "去程和返程已核验，但完整行程无法在活动结束或截止前完成。",
      headline: `核对「${destination}」下一次可参加的时间`,
      step: "查清下一次开放或活动时间，看看是否能留足往返与参加时间。",
    },
    BOOKING_UNCONFIRMED: {
      reason: "去程和返程已核验，但所需预约尚未确认。",
      headline: `确认「${destination}」的预约`,
      step: "查清预约方式与可用时段，确认预约成功后再安排出发。",
    },
    ADMISSION_UNCONFIRMED: {
      reason: "去程和返程已核验，但活动的入场条件尚未确认。",
      headline: `确认「${destination}」的入场条件`,
      step: "核对开放或活动时间、入场资格与参加方式。",
    },
    UNAVAILABLE: {
      reason: "去程和返程已核验，但当前已确认无法参加这项活动。",
      headline: `核对「${destination}」下次可参加的安排`,
      step: "查清下一次开放或可参加的时间；这次先不出发。",
    },
    LONG_TERM_GOAL: {
      reason: "去程和返程已核验，但这条记录仍是长期目标，当前应先做准备。",
      headline: `写下去「${destination}」的第一个小目标`,
      step: "写下这次想完成的具体内容和一个能检查是否完成的小结果。",
    },
  };
  const departureBlocker =
    verifiedRoute && requiresGoOut && direct.filterReason
      ? knownRouteBlockers[direct.filterReason]
      : undefined;
  if (departureBlocker) {
    proposals.push({
      key: "CONDITION",
      seconds: 300,
      headline: departureBlocker.headline,
      steps: [departureBlocker.step],
    });
  } else if (facts.activityKind === "TRAVEL") {
    proposals.push({
      key: "DATE",
      seconds: 300,
      headline: `为「${destination}」列两个可行日期`,
      steps: ["看一眼自己的空闲安排，写下两个备选出发日期；先不预订。"],
    });
    proposals.push({
      key: "BUDGET",
      seconds: 300,
      headline: `给「${destination}」列一张预算清单`,
      steps: ["写下交通、住宿和日常花费三项，再记下这次最多愿意花多少钱；金额没有查到就先留空。"],
    });
    proposals.push({
      key: "ROUTE",
      seconds: 600,
      headline: `查一条去「${destination}」的往返方案`,
      steps: ["分别查去程和返程，记下各自耗时及费用；未查询到前不把它当成可出发的路线。"],
    });
  } else if (requiresGoOut) {
    proposals.push({
      key: "ROUTE",
      seconds: 300,
      headline: `核对「${destination}」的位置与参加条件`,
      steps: ["确认地点、开放或活动时间，再核对往返交通；没有查清前先不出发。"],
    });
    if (future)
      proposals.push({
        key: "DATE",
        seconds: 180,
        headline: `记下「${candidate.title}」的时间和准备事项`,
        steps: ["核对开始、结束时间和参加方式，记下一个需要提前准备的东西。"],
      });
  } else if (future) {
    proposals.push({
      key: "DATE",
      seconds: 180,
      headline: `为「${candidate.title}」核对日程`,
      steps: ["核对开始和结束时间，看看是否与已有安排冲突，写下参加前的一项准备。"],
    });
  } else if (facts.horizon === "LONG_TERM") {
    proposals.push({
      key: "CLARIFY",
      seconds: 300,
      headline: `写下「${candidate.title}」的第一个小目标`,
      steps: ["写下一个能检查是否完成的小结果，再记下目前还缺什么；这次只完成这张清单。"],
    });
    proposals.push({
      key: "MATERIALS",
      seconds: 300,
      headline: `列出「${candidate.title}」需要的准备`,
      steps: ["列出开始所需的资料或工具，圈出一个已经有的；这次不购买、不承诺完成整个目标。"],
    });
  } else {
    proposals.push({
      key: "CLARIFY",
      seconds: 300,
      headline: `把「${candidate.title}」写成一件具体小事`,
      steps: ["写清想做的具体内容，再查或估计一次完整行动需要的时间与花费；未知的条件先留空。"],
    });
  }
  for (const proposal of proposals.slice(0, 3)) {
    const seconds =
      availableMinutes(context) == null
        ? proposal.seconds
        : Math.max(
            60,
            Math.floor(
              Math.min(
                proposal.seconds,
                availableMinutes(context)! * 60 - (context.calendar?.availableUntil ? 15 : 0),
              ),
            ),
          );
    const headline = `用 ${Math.ceil(seconds / 60)} 分钟，${proposal.headline}`;
    const plan: ActionPlan = {
      ...(() => {
        const ends = [
          timestamp(directPlan.validUntil),
          facts.eventStart != null && facts.eventStart > at ? facts.eventStart : null,
        ].filter((end): end is number => end != null);
        return ends.length ? { validUntil: new Date(Math.min(...ends)).toISOString() } : {};
      })(),
      mode: "PREPARE",
      activitySeconds: seconds,
      travelSeconds: 0,
      returnSeconds: 0,
      totalSeconds: seconds,
      basis: "PLANNING_ESTIMATE",
      steps: proposal.steps,
      requiresGoOut: false,
      targetRegion,
      verification: "UNVERIFIED",
    };
    const prepare: PlannedAction = {
      actionKey: candidate.id + ":PREPARE:" + proposal.key,
      actionMode: "PREPARE",
      requiredSeconds: seconds,
      durationBasis: "PLANNING_ESTIMATE",
      requiredCostMinMinor: 0,
      requiredCostMaxMinor: 0,
      requiresGoOut: false,
      headline,
      body: proposal.steps.join("\n"),
      reasonText: departureBlocker
        ? `${departureBlocker.reason}现在先完成这项准备；准备时段是规划估计。`
        : `现在做的是一个独立准备步骤，不是完成「${candidate.title}」。准备时段是规划估计；出发条件仍需确认。`,
      executionType: "START_TIMER",
      plan,
      filterReason: null,
      directness: 0.88,
    };
    prepare.filterReason = filterAction(prepare, candidate, context, at, facts);
    actions.push(prepare);
  }
  return actions;
}
