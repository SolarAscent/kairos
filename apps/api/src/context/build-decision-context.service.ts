import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { and, asc, desc, eq, isNull, or, gt, lte, sql } from "drizzle-orm";
import {
  captures,
  contextSnapshots,
  feedbackEvents,
  lifeObjectFacets,
  lifeObjectProjection,
  lifeObjects,
  recommendations,
  users,
  type Database,
} from "@life/db";
import type { NowContext } from "@life/contracts";
import { normalizeLifeTime } from "@life/domain";
import {
  isGeoPoint,
  TencentLbsAdapter,
  type GeoPoint,
  type LocationProvider,
  type RouteEstimate,
} from "@life/integrations";
import { DATABASE } from "../common/tokens.js";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export const LOCATION_PROVIDER = Symbol("LOCATION_PROVIDER");
export type BuildContextInput = Partial<NowContext>;
export interface DecisionCalendar {
  isBusy: boolean;
  availableUntil?: string;
  busyUntil?: string;
  nextEventAt?: string;
  freeMinutesUntilNextEvent?: number;
  effectiveAvailableMinutes?: number;
  eventIds: string[];
}
export interface DecisionLocation {
  latitude?: number;
  longitude?: number;
  coordinateSystem?: "GCJ02";
  region?: string;
  city?: string;
  source: "USER_INPUT" | "DEVICE" | "SAVED_CURRENT" | "SAVED_HOME";
  observedAt?: string;
  expiresAt?: string;
}
export type DecisionContext = NowContext & {
  serverTime: string;
  timezone: string;
  localDate: string;
  localClock: string;
  calendar: DecisionCalendar;
  location?: DecisionLocation;
};
export interface BusyWindow {
  id: string;
  startAt: string;
  endAt?: string;
}
export interface LocationCandidate {
  id: string;
  title: string;
  kind: string;
  location?: GeoPoint;
  address?: string;
  city?: string;
  activityKind?: string;
}
export interface CandidateLocationEnrichment {
  status: "READY" | "UNAVAILABLE";
  reason?: string;
  destination?: GeoPoint;
  route?: RouteEstimate & {
    returnDurationSeconds: number;
    returnDistanceMeters: number;
    origin: GeoPoint;
    destination: GeoPoint;
  };
}
function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined;
}
function instant(value: unknown): Date | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value))
    return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}
function coarsePlace(value: unknown): Pick<DecisionLocation, "region" | "city"> | null {
  const place = object(value);
  const region = string(place.region) ?? string(place.province),
    city = string(place.city);
  return region || city ? { ...(region ? { region } : {}), ...(city ? { city } : {}) } : null;
}

function eventWindowBoundary(
  data: Record<string, unknown>,
  key: "windowStart" | "windowEnd",
  capturedAt: Date,
  timezone: string,
  originType: string,
): Date | undefined {
  const normalization = object(data.normalization),
    rawTime = object(normalization.rawTime);
  const exactKey = key === "windowStart" ? "eventStart" : "eventEnd";
  const raw = rawTime[key] ?? rawTime[exactKey];
  const warnings = Array.isArray(normalization.warnings) ? normalization.warnings : [];
  if (
    warnings.some(
      (warning) =>
        typeof warning === "string" &&
        /EVIDENCE_NOT_IN_SOURCE|TIME_NOT_GROUNDED|TIME_WINDOW_REVERSED|EVENT_WINDOW_REVERSED|TIME_INVALID|TIMEZONE_INVALID|REFERENCE_TIME_INVALID/.test(
          warning,
        ),
    )
  )
    return undefined;
  const reference = {
    referenceTime: instant(normalization.referenceTime)?.toISOString() ?? capturedAt.toISOString(),
    timezone: typeof normalization.timezone === "string" ? normalization.timezone : timezone,
  };
  if (typeof raw === "string") return instant(normalizeLifeTime(raw, reference).exact);
  const facts = object(data.facts),
    times = object(facts.time);
  // A manual confirmed EVENT with explicit ISO bounds is authoritative. Legacy model windows
  // additionally need an actual day+clock expression in the user's evidence.
  const evidence = typeof facts.evidence === "string" ? facts.evidence : "";
  const hasDay =
    /今天|明天|后天|今晚|明晚|本周|这周|下周|星期|周[一二三四五六日天]|\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}[日号]/.test(
      evidence,
    );
  const clocks = evidence.match(/\d{1,2}:\d{2}|[零〇一二两三四五六七八九十\d]{1,3}点/g) ?? [];
  if (originType !== "USER_STATED" && (!hasDay || clocks.length < (key === "windowEnd" ? 2 : 1)))
    return undefined;
  return typeof times[key] === "string"
    ? instant(normalizeLifeTime(times[key] as string, reference).exact)
    : undefined;
}

/** Intervals overlap, rather than adding independently. A current conflict leaves zero free minutes. */
export function deriveCalendar(
  windows: BusyWindow[],
  now: Date,
  availableMinutes?: number,
): DecisionCalendar {
  const normalized = windows
    .map((window) => ({ ...window, start: instant(window.startAt), end: instant(window.endAt) }))
    .filter(
      (window) =>
        window.start &&
        (!window.end || window.end > window.start) &&
        (!window.end || window.end > now),
    );
  const active = normalized.filter(
    (window) => window.start! <= now && window.end != null && window.end > now,
  );
  let busyEnd = active.length
    ? Math.max(...active.map((window) => window.end!.getTime()))
    : undefined;
  if (busyEnd != null) {
    // Include immediately adjoining/overlapping known events in the current occupied span.
    let previous: number;
    do {
      previous = busyEnd;
      for (const window of normalized) {
        if (window.end && window.start!.getTime() <= busyEnd && window.end.getTime() > busyEnd)
          busyEnd = window.end.getTime();
      }
    } while (previous !== busyEnd);
  }
  const next = normalized
    .filter((window) => window.start! > now)
    .sort((a, b) => a.start!.getTime() - b.start!.getTime())[0];
  const freeMinutes =
    busyEnd != null
      ? 0
      : next
        ? Math.max(0, (next.start!.getTime() - now.getTime()) / 60000)
        : undefined;
  const effective =
    availableMinutes == null
      ? freeMinutes
      : freeMinutes == null
        ? availableMinutes
        : Math.min(availableMinutes, freeMinutes);
  return {
    isBusy: busyEnd != null,
    ...(busyEnd != null ? { busyUntil: new Date(busyEnd).toISOString() } : {}),
    ...(next ? { nextEventAt: next.start!.toISOString() } : {}),
    ...(freeMinutes != null ? { freeMinutesUntilNextEvent: freeMinutes } : {}),
    ...(effective != null ? { effectiveAvailableMinutes: effective } : {}),
    eventIds: [...new Set(normalized.map((window) => window.id))].slice(0, 200),
  };
}

@Injectable()
export class BuildDecisionContextService {
  private readonly locations: LocationProvider;
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Optional() @Inject(LOCATION_PROVIDER) provider?: LocationProvider,
  ) {
    this.locations = provider ?? TencentLbsAdapter.fromEnvironment();
  }

  async build(
    userId: string,
    input: BuildContextInput = {},
    reader: Database | DbTransaction = this.db,
    now = new Date(),
  ) {
    const [user] = await reader
      .select({ timezone: users.timezone })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.status, "ACTIVE"), isNull(users.deletedAt)))
      .limit(1);
    if (!user) throw new NotFoundException({ code: "CONTEXT_USER_NOT_FOUND" });
    await this.purgeExpiredSnapshots(userId, reader, now);
    let timezone = user.timezone;
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
    } catch {
      timezone = "Asia/Shanghai";
    }
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)!.value;
    const context: Omit<DecisionContext, "calendar"> = {
      ...(input.availableMinutes != null ? { availableMinutes: input.availableMinutes } : {}),
      ...(input.budgetMinor != null ? { budgetMinor: input.budgetMinor } : {}),
      ...(input.willingToGoOut != null ? { willingToGoOut: input.willingToGoOut } : {}),
      ...(input.mood != null ? { mood: input.mood } : {}),
      serverTime: now.toISOString(),
      localTime: now.toISOString(),
      timezone,
      localDate: `${part("year")}-${part("month")}-${part("day")}`,
      localClock: `${part("hour")}:${part("minute")}`,
    };
    let availableUntil = instant(input.calendar?.availableUntil);
    if (!availableUntil && input.availableMinutes != null)
      availableUntil = new Date(now.getTime() + input.availableMinutes * 60000);
    const hasExplicitAvailable = input.availableMinutes != null || availableUntil != null;
    let latestAvailableCapture: number | undefined;
    if (input.location) {
      const coarse = coarsePlace(input.location);
      const point = isGeoPoint(input.location) ? input.location : undefined;
      const source = input.location.source;
      const allowed = source === "USER_INPUT" || source === "DEVICE";
      const expiration = instant(input.location.expiresAt);
      const observed = instant(input.location.observedAt) ?? now;
      const fresh = observed <= now && now.getTime() - observed.getTime() < 2 * 3600000;
      const coherentExpiry = !expiration || expiration > observed;
      if (
        allowed &&
        fresh &&
        coherentExpiry &&
        (!expiration || expiration > now) &&
        (coarse || point)
      ) {
        context.location = {
          ...(coarse ?? {}),
          ...(point
            ? {
                latitude: point.latitude,
                longitude: point.longitude,
                coordinateSystem: "GCJ02" as const,
              }
            : {}),
          source,
          observedAt: observed.toISOString(),
          expiresAt: new Date(
            Math.min(expiration?.getTime() ?? Infinity, observed.getTime() + 2 * 3600000),
          ).toISOString(),
        };
      }
    }
    const facetFields = {
      data: lifeObjectFacets.data,
      objectId: lifeObjects.id,
      kind: lifeObjects.kind,
      facetType: lifeObjectFacets.facetType,
      originType: lifeObjectFacets.originType,
      createdAt: captures.createdAt,
      facetCreatedAt: lifeObjectFacets.createdAt,
      durationMinSeconds: lifeObjectProjection.durationMinSeconds,
    };
    const baseConditions = [
      eq(lifeObjectFacets.userId, userId),
      eq(lifeObjects.status, "ACTIVE"),
      isNull(lifeObjects.deletedAt),
      isNull(lifeObjectFacets.deletedAt),
      or(isNull(lifeObjectFacets.validFrom), lte(lifeObjectFacets.validFrom, now)),
      or(isNull(lifeObjectFacets.validUntil), gt(lifeObjectFacets.validUntil, now)),
    ];
    const facetQuery = () =>
      reader
        .select(facetFields)
        .from(lifeObjectFacets)
        .innerJoin(
          lifeObjects,
          and(eq(lifeObjects.id, lifeObjectFacets.lifeObjectId), eq(lifeObjects.userId, userId)),
        )
        .leftJoin(
          captures,
          and(
            eq(captures.id, lifeObjectFacets.originId),
            eq(captures.userId, userId),
            isNull(captures.deletedAt),
          ),
        )
        .leftJoin(
          lifeObjectProjection,
          and(
            eq(lifeObjectProjection.lifeObjectId, lifeObjects.id),
            eq(lifeObjectProjection.userId, userId),
          ),
        );
    const recent = await facetQuery()
      .where(and(...baseConditions))
      .orderBy(desc(lifeObjectFacets.createdAt), desc(lifeObjectFacets.id))
      .limit(500);
    // Scheduled facts have their own bound. A flood of recent notes cannot hide the nearest event.
    // The worker normalizes fact timestamps to ISO UTC; comparison stays textual to avoid unsafe casts.
    const eventStart = sql<string>`${lifeObjectFacets.data} #>> '{facts,time,eventStart}'`;
    const eventEnd = sql<string>`${lifeObjectFacets.data} #>> '{facts,time,eventEnd}'`;
    const windowStart = sql<string>`${lifeObjectFacets.data} #>> '{facts,time,windowStart}'`;
    const windowEnd = sql<string>`${lifeObjectFacets.data} #>> '{facts,time,windowEnd}'`;
    const scheduled = await facetQuery()
      .where(
        and(
          ...baseConditions,
          sql`${lifeObjectFacets.data} #>> '{facts,origin}' = 'USER_STATED'`,
          or(
            eq(lifeObjectFacets.facetType, "EVENT"),
            eq(lifeObjects.kind, "EVENT"),
            sql`${lifeObjectFacets.data} #>> '{facts,horizon}' = 'SCHEDULED'`,
          ),
          or(
            gt(eventStart, now.toISOString()),
            gt(eventEnd, now.toISOString()),
            gt(windowStart, now.toISOString()),
            gt(windowEnd, now.toISOString()),
            gt(lifeObjectProjection.nextAt, now),
            gt(lifeObjectProjection.expiresAt, now),
          ),
        ),
      )
      .orderBy(
        asc(
          sql`coalesce(${eventStart}, ${windowStart}, to_char(${lifeObjectProjection.nextAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
        ),
        asc(lifeObjectFacets.id),
      )
      .limit(200);
    const rows = [...recent, ...scheduled];
    const windows: BusyWindow[] = [];
    let home: DecisionLocation | undefined;
    for (const row of rows) {
      const facts = object(row.data.facts);
      if (facts.origin !== "USER_STATED" || row.originType === "INFERRED") continue;
      const capturedAt = row.createdAt ?? row.facetCreatedAt;
      const age = now.getTime() - capturedAt.getTime();
      const duration = object(facts.duration),
        money = object(facts.money);
      if (age >= 0 && age < 2 * 3600000) {
        const availableSeconds = duration.maxSeconds ?? duration.minSeconds;
        const budgetMinor = money.maxMinor ?? money.minMinor;
        if (
          !hasExplicitAvailable &&
          duration.role === "AVAILABLE" &&
          duration.scope === "CURRENT" &&
          typeof availableSeconds === "number" &&
          Number.isFinite(availableSeconds) &&
          availableSeconds >= 0
        ) {
          const boundedSeconds = Math.min(86400, availableSeconds);
          const deadline = new Date(capturedAt.getTime() + boundedSeconds * 1000);
          // A newer user declaration replaces an older capture; repeated facets of the same
          // declaration use the tightest deadline, without subtracting elapsed time twice.
          if (latestAvailableCapture == null || capturedAt.getTime() > latestAvailableCapture) {
            latestAvailableCapture = capturedAt.getTime();
            availableUntil = deadline;
            context.availableMinutes = Math.floor(boundedSeconds / 60);
          } else if (
            capturedAt.getTime() === latestAvailableCapture &&
            availableUntil &&
            deadline < availableUntil
          ) {
            availableUntil = deadline;
            context.availableMinutes = Math.floor(boundedSeconds / 60);
          }
        }
        if (
          context.budgetMinor == null &&
          money.role === "BUDGET" &&
          money.scope === "CURRENT" &&
          money.currency === "CNY" &&
          typeof budgetMinor === "number" &&
          Number.isFinite(budgetMinor) &&
          budgetMinor >= 0
        )
          context.budgetMinor = Math.min(100000000, Math.floor(budgetMinor));
      }
      if (!context.location && age >= 0 && age < 24 * 3600000) {
        const coarse = coarsePlace(facts.originContext);
        if (coarse)
          context.location = {
            ...coarse,
            source: "SAVED_CURRENT",
            observedAt: capturedAt.toISOString(),
            expiresAt: new Date(capturedAt.getTime() + 24 * 3600000).toISOString(),
          };
      }
      if (!home && facts.activityKind === "HOME") {
        const coarse = coarsePlace(facts.place);
        if (coarse)
          home = { ...coarse, source: "SAVED_HOME", observedAt: capturedAt.toISOString() };
      }
      const times = object(facts.time);
      const eventFacet = row.kind === "EVENT" || row.facetType === "EVENT";
      const start =
        instant(times.eventStart) ??
        (eventFacet
          ? eventWindowBoundary(row.data, "windowStart", capturedAt, timezone, row.originType)
          : undefined);
      const end =
        instant(times.eventEnd) ??
        (eventFacet
          ? eventWindowBoundary(row.data, "windowEnd", capturedAt, timezone, row.originType)
          : undefined);
      if (start && (eventFacet || facts.horizon === "SCHEDULED")) {
        const knownDuration =
          duration.role === "REQUIRED" && typeof duration.minSeconds === "number"
            ? duration.minSeconds
            : row.durationMinSeconds;
        const derivedEnd =
          end ??
          (knownDuration != null && Number.isFinite(knownDuration) && knownDuration > 0
            ? new Date(start.getTime() + knownDuration * 1000)
            : undefined);
        windows.push({
          id: row.objectId,
          startAt: start.toISOString(),
          ...(derivedEnd ? { endAt: derivedEnd.toISOString() } : {}),
        });
      }
    }
    // A home address is a saved place, never evidence that the user is physically home now.
    if (!context.location && home) context.location = home;
    windows.push(...(await this.acceptedPlans(reader, userId, now)));
    const remainingMinutes = availableUntil
      ? Math.max(0, (availableUntil.getTime() - now.getTime()) / 60000)
      : context.availableMinutes;
    const calendar = deriveCalendar(windows, now, remainingMinutes);
    if (availableUntil) calendar.availableUntil = availableUntil.toISOString();
    const result: DecisionContext = { ...context, calendar };
    const containsPreciseLocation = isGeoPoint(result.location);
    return {
      context: result,
      snapshot: { containsPreciseLocation, purgeAt: new Date(now.getTime() + 2 * 3600000) },
    };
  }

  async purgeExpiredSnapshots(
    userId: string,
    reader: Database | DbTransaction = this.db,
    now = new Date(),
  ) {
    // Retention is owner-scoped and does not copy coordinates into logs or permanent tables.
    await reader
      .delete(contextSnapshots)
      .where(
        and(
          eq(contextSnapshots.userId, userId),
          or(
            lte(contextSnapshots.purgeAt, now),
            and(
              eq(contextSnapshots.containsPreciseLocation, true),
              lte(contextSnapshots.createdAt, new Date(now.getTime() - 24 * 3600000)),
            ),
          ),
        ),
      );
  }

  private async acceptedPlans(
    reader: Database | DbTransaction,
    userId: string,
    now: Date,
  ): Promise<BusyWindow[]> {
    const rows = await reader
      .select({
        id: recommendations.id,
        payload: recommendations.executionPayload,
        type: feedbackEvents.eventType,
        at: feedbackEvents.createdAt,
        metadata: feedbackEvents.metadata,
      })
      .from(feedbackEvents)
      .innerJoin(
        recommendations,
        and(
          eq(recommendations.id, feedbackEvents.recommendationId),
          eq(recommendations.userId, userId),
        ),
      )
      .where(
        and(
          eq(feedbackEvents.userId, userId),
          gt(feedbackEvents.createdAt, new Date(now.getTime() - 24 * 3600000)),
        ),
      )
      .orderBy(desc(feedbackEvents.createdAt), desc(feedbackEvents.id))
      .limit(500);
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = groups.get(row.id) ?? [];
      list.push(row);
      groups.set(row.id, list);
    }
    const windows: BusyWindow[] = [];
    const terminal = new Set(["COMPLETE", "REJECT", "SKIP", "DISMISS"]);
    for (const [id, events] of groups) {
      const states = events.filter(
        (event) => terminal.has(event.type) || event.type === "ACCEPT" || event.type === "EXECUTE",
      );
      const latest = states[0];
      if (!latest || terminal.has(latest.type)) continue;
      const recentActive = states.slice(
        0,
        states.findIndex((event) => terminal.has(event.type)) < 0
          ? states.length
          : states.findIndex((event) => terminal.has(event.type)),
      );
      // ACCEPT and EXECUTE both start an action. Repeated signals while active cannot
      // move its server-authored start or restart its occupied interval.
      const anchor = recentActive.at(-1)!;
      const server = object(object(anchor.metadata).serverPlan);
      const plan = object(anchor.payload.plan);
      const total =
        typeof plan.totalSeconds === "number" &&
        Number.isFinite(plan.totalSeconds) &&
        plan.totalSeconds > 0 &&
        plan.totalSeconds <= 86400
          ? plan.totalSeconds
          : undefined;
      const start = instant(server.startAt) ?? anchor.at;
      const end =
        instant(server.endAt) ?? (total ? new Date(start.getTime() + total * 1000) : undefined);
      if (end && end > start && end > now)
        windows.push({ id, startAt: start.toISOString(), endAt: end.toISOString() });
    }
    return windows;
  }

  async enrichCandidates(
    context: NowContext,
    candidates: LocationCandidate[],
  ): Promise<Record<string, CandidateLocationEnrichment>> {
    const targets = candidates
      .filter(
        (candidate) =>
          candidate.kind === "PLACE" ||
          candidate.activityKind === "LOCAL_OUTING" ||
          candidate.activityKind === "TRAVEL",
      )
      .slice(0, 5);
    const results: Record<string, CandidateLocationEnrichment> = {};
    const origin: GeoPoint | undefined = isGeoPoint(context.location)
      ? {
          latitude: context.location.latitude,
          longitude: context.location.longitude,
          coordinateSystem: "GCJ02",
        }
      : undefined;
    const validUntil = instant(context.location?.expiresAt);
    const observed = instant(context.location?.observedAt);
    const observedInvalid =
      observed != null &&
      (observed.getTime() > Date.now() || Date.now() - observed.getTime() >= 2 * 3600000);
    for (const target of targets)
      results[target.id] = {
        status: "UNAVAILABLE",
        reason: this.locations.configured ? "ORIGIN_NOT_PRECISE" : "NOT_CONFIGURED",
      };
    if (
      !this.locations.configured ||
      !origin ||
      observedInvalid ||
      (validUntil && validUntil <= new Date()) ||
      context.location?.source === "SAVED_HOME"
    )
      return results;
    const abort = new AbortController();
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve();
      }, 2000);
    });
    const task = async () => {
      while (!abort.signal.aborted && cursor < targets.length) {
        const target = targets[cursor++]!;
        results[target.id] = { status: "UNAVAILABLE", reason: "TIMEOUT" };
        let destination = isGeoPoint(target.location) ? target.location : undefined;
        if (!destination) {
          if (!target.address || !target.city) {
            results[target.id] = { status: "UNAVAILABLE", reason: "DESTINATION_UNRESOLVED" };
            continue;
          }
          const found = await this.locations.geocode(target.address, target.city, abort.signal);
          if (!found.ok) {
            if (!abort.signal.aborted)
              results[target.id] = { status: "UNAVAILABLE", reason: found.reason };
            continue;
          }
          destination = found.value.location;
        }
        if (abort.signal.aborted) break;
        const outward = await this.locations.route(origin, destination, abort.signal);
        if (!outward.ok) {
          if (!abort.signal.aborted)
            results[target.id] = { status: "UNAVAILABLE", reason: outward.reason };
          continue;
        }
        const back = await this.locations.route(destination, origin, abort.signal);
        if (!back.ok) {
          if (!abort.signal.aborted)
            results[target.id] = { status: "UNAVAILABLE", reason: back.reason };
          continue;
        }
        if (!abort.signal.aborted)
          results[target.id] = {
            status: "READY",
            destination,
            route: {
              ...outward.value,
              returnDurationSeconds: back.value.durationSeconds,
              returnDistanceMeters: back.value.distanceMeters,
              origin,
              destination,
              expiresAt: new Date(
                Math.min(
                  Date.parse(outward.value.expiresAt),
                  Date.parse(back.value.expiresAt),
                  validUntil?.getTime() ?? Infinity,
                ),
              ).toISOString(),
            },
          };
      }
    };
    try {
      await Promise.race([Promise.all([task(), task()]), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
    }
    for (const target of targets)
      if (results[target.id]?.reason === "ORIGIN_NOT_PRECISE")
        results[target.id] = { status: "UNAVAILABLE", reason: "TIMEOUT" };
    return results;
  }
}
