import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql, inArray, isNull, notInArray, or, gt } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
  actionCandidates,
  clarificationRequests,
  contextSnapshots,
  decisionSessions,
  lifeObjectProjection,
  lifeObjectFacets,
  lifeObjectRelations,
  lifeObjects,
  outboxEvents,
  recommendations,
  type Database,
} from "@life/db";
import {
  nowContextSchema,
  actionPlanSchema,
  structuredLifeFactsSchema,
  nowQuestionSchema,
  routeCheckSchema,
  routeCheckDetailSchema,
  type RouteCheck,
  type AnswerNowQuestionRequest,
  type CreateNowSessionRequest,
  type NowContext,
} from "@life/contracts";
import {
  contextForQuestionAnswer,
  maximumNowQuestions,
  nextDecisionQuestion,
  questionPolicyVersion,
  scoreCandidates,
  scoringVersion,
  interventionThreshold,
  planningFacts,
  type DecisionCandidate,
} from "@life/domain";
import { BuildDecisionContextService } from "../context/build-decision-context.service.js";
import { ActionPlanService } from "../planning/action-plan.service.js";
import { DATABASE } from "../common/tokens.js";
import { IdempotencyService } from "../common/idempotency.service.js";
import { PreferenceReader } from "../feedback/preference-reader.js";
import { TransportPreferenceReader } from "../feedback/transport-preference-reader.js";
import { destinationQueryForObject } from "@life/integrations";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const candidateFields = {
  id: lifeObjects.id,
  title: lifeObjects.title,
  summary: lifeObjects.summary,
  kind: lifeObjects.kind,
  importance: lifeObjects.importanceScore,
  createdAt: lifeObjects.createdAt,
  objectVersion: lifeObjects.objectVersion,
  updatedAt: lifeObjects.updatedAt,
  projectionVersion: lifeObjectProjection.projectionVersion,
  expiresAt: lifeObjectProjection.expiresAt,
  costMinMinor: lifeObjectProjection.costMinMinor,
  costMaxMinor: lifeObjectProjection.costMaxMinor,
  durationMinSeconds: lifeObjectProjection.durationMinSeconds,
  durationMaxSeconds: lifeObjectProjection.durationMaxSeconds,
  nextAt: lifeObjectProjection.nextAt,
  latitude: lifeObjectProjection.latitude,
  longitude: lifeObjectProjection.longitude,
  coordinateSystem: lifeObjectProjection.coordinateSystem,
};

@Injectable()
export class NowService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(BuildDecisionContextService) private readonly contexts: BuildDecisionContextService,
    @Inject(ActionPlanService) private readonly plans: ActionPlanService,
  ) {}

  async create(userId: string, input: CreateNowSessionRequest, key: string | undefined) {
    const result = await this.idempotency.execute(
      userId,
      "POST /v1/now/sessions",
      key,
      input,
      async (tx) => {
        if (input.focusObjectId) {
          if (input.excludeObjectIds.includes(input.focusObjectId))
            throw new BadRequestException({ code: "FOCUS_OBJECT_EXCLUDED" });
          const [focus] = await tx
            .select({ id: lifeObjects.id })
            .from(lifeObjects)
            .where(
              and(
                eq(lifeObjects.id, input.focusObjectId),
                eq(lifeObjects.userId, userId),
                eq(lifeObjects.status, "ACTIVE"),
                isNull(lifeObjects.deletedAt),
              ),
            )
            .for("share")
            .limit(1);
          if (!focus) throw new NotFoundException({ code: "LIFE_OBJECT_NOT_FOUND" });
        }
        const sessionId = uuidv7();
        const { context } = await this.contexts.build(userId, input.context, tx);
        await tx.insert(decisionSessions).values({
          id: sessionId,
          userId,
          status: "BUILDING",
          scoringVersion,
          questionPolicyVersion,
          contextSummary: this.publicContext(context, input.focusObjectId),
          expiresAt: new Date(Date.now() + 2 * 3600000),
        });
        await this.saveContext(tx, userId, sessionId, context);
        const conditions = [
          eq(lifeObjects.userId, userId),
          eq(lifeObjects.status, "ACTIVE"),
          isNull(lifeObjects.deletedAt),
        ];
        if (input.excludeObjectIds.length)
          conditions.push(notInArray(lifeObjects.id, input.excludeObjectIds));
        if (input.focusObjectId) conditions.push(eq(lifeObjects.id, input.focusObjectId));
        const rows = await tx
          .select(candidateFields)
          .from(lifeObjects)
          .innerJoin(lifeObjectProjection, eq(lifeObjectProjection.lifeObjectId, lifeObjects.id))
          .where(and(...conditions))
          .orderBy(
            sql`CASE WHEN ${lifeObjectProjection.expiresAt} > now() AND ${lifeObjectProjection.expiresAt} <= now()+interval '14 days' THEN 0 WHEN ${lifeObjectProjection.nextAt} > now() AND ${lifeObjectProjection.nextAt} <= now()+interval '14 days' THEN 1 WHEN ${lifeObjects.kind} = 'DESIRE' THEN 2 ELSE 3 END`,
            sql`COALESCE(${lifeObjectProjection.expiresAt},${lifeObjectProjection.nextAt}) ASC NULLS LAST`,
            desc(lifeObjects.createdAt),
            desc(lifeObjects.id),
          )
          .limit(200);
        // Preserve urgent/recent recall and add older wishes the owner explicitly liked.
        const liked = await tx.execute(sql`WITH latest AS (
          SELECT DISTINCT ON (value->>'lifeObjectId') value->>'lifeObjectId' AS object_id,
            value->>'rating' AS rating,occurred_at,id
          FROM preference_signals WHERE user_id=${userId}::uuid AND dimension='life_object'
            AND source_type='LIFE_RATING'
          ORDER BY value->>'lifeObjectId',occurred_at DESC,id DESC
        ) SELECT o.id FROM latest JOIN life_objects o ON o.id::text=latest.object_id
          WHERE o.user_id=${userId}::uuid AND o.status='ACTIVE' AND o.deleted_at IS NULL
            AND latest.rating='LIKE'
          ORDER BY latest.occurred_at DESC,latest.id DESC LIMIT 50`);
        const existingIds = new Set(rows.map((row) => row.id));
        const likedIds = liked.rows
          .map((row) => String(row.id))
          .filter((id) => !existingIds.has(id));
        if (likedIds.length) {
          rows.push(
            ...(await tx
              .select(candidateFields)
              .from(lifeObjects)
              .innerJoin(
                lifeObjectProjection,
                eq(lifeObjectProjection.lifeObjectId, lifeObjects.id),
              )
              .where(and(...conditions, inArray(lifeObjects.id, likedIds)))),
          );
        }
        await this.resolve(tx, userId, sessionId, context, rows, [], true, input.focusObjectId);
        await this.enqueueLegacyFacts(tx, userId, rows);
        return this.read(tx, userId, sessionId, false);
      },
    );
    // Idempotency responses outlive GPS retention: assemble precise detail only after caching.
    const body = await this.db.transaction((tx) => this.read(tx, userId, result.body.sessionId));
    return { ...body, replayed: result.replayed };
  }

  async answer(
    userId: string,
    sessionId: string,
    input: AnswerNowQuestionRequest,
    key: string | undefined,
  ) {
    const result = await this.idempotency.execute(
      userId,
      `POST /v1/now/sessions/${sessionId}/answers`,
      key,
      input,
      async (tx) => {
        // Different request keys still serialize on the session: at most one next question.
        const [session] = await tx
          .select()
          .from(decisionSessions)
          .where(and(eq(decisionSessions.id, sessionId), eq(decisionSessions.userId, userId)))
          .for("update")
          .limit(1);
        if (!session) throw new NotFoundException({ code: "DECISION_SESSION_NOT_FOUND" });
        if (session.expiresAt <= new Date())
          throw new GoneException({ code: "DECISION_SESSION_EXPIRED" });
        const [question] = await tx
          .select()
          .from(clarificationRequests)
          .where(
            and(
              eq(clarificationRequests.id, input.questionId),
              eq(clarificationRequests.userId, userId),
              eq(clarificationRequests.decisionSessionId, sessionId),
              eq(clarificationRequests.scopeType, "DECISION"),
            ),
          )
          .limit(1);
        if (!question) throw new NotFoundException({ code: "NOW_QUESTION_NOT_FOUND" });
        if (question.status === "ANSWERED") {
          const answer = question.answer as { optionId?: string } | null;
          if (answer?.optionId !== input.optionId)
            throw new ConflictException({ code: "NOW_ANSWER_CONFLICT" });
          return this.read(tx, userId, sessionId, false);
        }
        if (session.status !== "NEEDS_ANSWER" || question.status !== "PENDING")
          throw new ConflictException({ code: "NOW_QUESTION_NOT_PENDING" });
        const options = nowQuestionSchema.shape.options.parse(question.options.items);
        const patch = contextForQuestionAnswer(question.questionKey, input.optionId);
        if (!options.some((option) => option.id === input.optionId) || !patch)
          throw new BadRequestException({ code: "NOW_OPTION_INVALID" });
        const [snapshot] = await tx
          .select()
          .from(contextSnapshots)
          .where(
            and(
              eq(contextSnapshots.userId, userId),
              eq(contextSnapshots.decisionSessionId, sessionId),
            ),
          )
          .orderBy(desc(contextSnapshots.createdAt), desc(contextSnapshots.id))
          .limit(1);
        const previous = nowContextSchema.parse(snapshot?.context ?? session.contextSummary);
        const focusObjectId =
          typeof session.contextSummary.focusObjectId === "string"
            ? session.contextSummary.focusObjectId
            : undefined;
        const restoredLocation =
          previous.location &&
          (!previous.location.expiresAt || new Date(previous.location.expiresAt) > new Date())
            ? { ...previous.location, source: "USER_INPUT" as const }
            : undefined;
        const retained =
          patch.availableMinutes != null
            ? {
                ...previous,
                calendar: previous.calendar
                  ? { ...previous.calendar, availableUntil: undefined }
                  : undefined,
              }
            : previous;
        const { context } = await this.contexts.build(
          userId,
          {
            ...retained,
            ...patch,
            ...(restoredLocation ? { location: restoredLocation } : {}),
          },
          tx,
        );
        await tx
          .update(clarificationRequests)
          .set({ status: "ANSWERED", answer: { optionId: input.optionId }, answeredAt: new Date() })
          .where(eq(clarificationRequests.id, question.id));
        await tx
          .update(decisionSessions)
          .set({ contextSummary: this.publicContext(context, focusObjectId) })
          .where(eq(decisionSessions.id, sessionId));
        await this.saveContext(tx, userId, sessionId, context);
        const asked = await tx
          .select({ key: clarificationRequests.questionKey })
          .from(clarificationRequests)
          .where(
            and(
              eq(clarificationRequests.userId, userId),
              eq(clarificationRequests.decisionSessionId, sessionId),
              eq(clarificationRequests.scopeType, "DECISION"),
            ),
          );
        const savedCandidates = await tx
          .select({ objectId: actionCandidates.targetLifeObjectId })
          .from(actionCandidates)
          .where(
            and(
              eq(actionCandidates.userId, userId),
              eq(actionCandidates.decisionSessionId, sessionId),
            ),
          );
        const objectIds = savedCandidates
          .map((item) => item.objectId)
          .filter((id): id is string => id != null);
        // A follow-up stays within the original session's candidate pool and exclusions.
        const rows = objectIds.length
          ? await tx
              .select(candidateFields)
              .from(lifeObjects)
              .innerJoin(
                lifeObjectProjection,
                eq(lifeObjectProjection.lifeObjectId, lifeObjects.id),
              )
              .where(
                and(
                  eq(lifeObjects.userId, userId),
                  eq(lifeObjects.status, "ACTIVE"),
                  isNull(lifeObjects.deletedAt),
                  inArray(lifeObjects.id, objectIds),
                  ...(focusObjectId ? [eq(lifeObjects.id, focusObjectId)] : []),
                ),
              )
          : [];
        await this.resolve(
          tx,
          userId,
          sessionId,
          context,
          rows,
          asked.map((item) => item.key),
          input.optionId !== "SKIP",
          focusObjectId,
        );
        return this.read(tx, userId, sessionId, false);
      },
    );
    const body = await this.db.transaction((tx) => this.read(tx, userId, sessionId));
    return { ...body, replayed: result.replayed };
  }

  private async saveContext(
    tx: DbTransaction,
    userId: string,
    sessionId: string,
    context: NowContext,
  ) {
    await tx.insert(contextSnapshots).values({
      id: uuidv7(),
      userId,
      decisionSessionId: sessionId,
      context,
      contextSchemaVersion: 2,
      containsPreciseLocation: context.location?.latitude != null,
      purgeAt: new Date(Date.now() + 2 * 3600000),
    });
  }

  private async resolve(
    tx: DbTransaction,
    userId: string,
    sessionId: string,
    context: NowContext,
    rows: DecisionCandidate[],
    askedKeys: string[],
    allowQuestions = true,
    focusObjectId?: string,
  ) {
    const decisionTime = new Date();
    const preferences = await new PreferenceReader(tx).read(userId, rows, decisionTime);
    const transportPreference = await new TransportPreferenceReader(tx).read(userId, decisionTime);
    rows = rows.map((row) => ({ ...row, ...preferences.get(row.id) }));
    const enrichedRows = await this.withFacts(
      tx,
      userId,
      rows,
      context,
      focusObjectId,
      transportPreference.preferScenicBus,
    );
    rows = enrichedRows;
    const routeChecks = new Map(enrichedRows.map((row) => [row.id, row.routeCheck]));
    const ranked = scoreCandidates(rows, context, decisionTime);
    const verifiedRouteDetails: Record<string, unknown> = {};
    for (const row of enrichedRows) {
      const direct = ranked.find((item) => item.id === row.id && item.actionKey === `${row.id}:DO`);
      const route = row.route;
      if (row.routeCheck?.status !== "READY" || !route || !direct) continue;
      const limits = [
        context.availableMinutes,
        context.calendar?.effectiveAvailableMinutes,
        context.calendar?.freeMinutesUntilNextEvent,
      ].filter((value): value is number => value != null && Number.isFinite(value) && value >= 0);
      const detail = routeCheckDetailSchema.safeParse({
        origin: route.origin,
        destination: route.destination,
        destinationLabel: row.destinationLabel ?? row.title,
        outwardSeconds: route.durationSeconds,
        returnSeconds: route.returnDurationSeconds,
        outwardMeters: route.distanceMeters,
        returnMeters: route.returnDistanceMeters,
        departureBlocker: direct.hardFilterReason,
        requiredSeconds: direct.requiredSeconds,
        availableSeconds: limits.length ? Math.min(...limits) * 60 : null,
        mode: route.mode,
        transitKind: route.transitKind,
        transitMixed: row.routeTransitMixed,
        selectionReason: route.selectionReason,
        observedAt: new Date(route.observedAt).toISOString(),
        expiresAt: new Date(route.expiresAt).toISOString(),
        returnTimingVerified: route.returnTimingVerified,
        comparisonComplete: row.routeComparisonComplete,
        transportCostMinor: route.costMinor ?? (route.mode === "walking" ? 0 : null),
      });
      if (detail.success)
        verifiedRouteDetails[row.id] = {
          detail: detail.data,
          objectVersion: row.objectVersion,
          observedAt: new Date(route.observedAt).toISOString(),
          expiresAt: new Date(route.expiresAt).toISOString(),
        };
    }
    // The snapshot is the sole GPS store and already has a two-hour purge policy.
    // Permanent actions and recommendations retain only the route check status.
    const [snapshot] = await tx
      .select({ id: contextSnapshots.id })
      .from(contextSnapshots)
      .where(
        and(eq(contextSnapshots.userId, userId), eq(contextSnapshots.decisionSessionId, sessionId)),
      )
      .orderBy(desc(contextSnapshots.createdAt), desc(contextSnapshots.id))
      .limit(1);
    if (snapshot)
      await tx
        .update(contextSnapshots)
        .set({ context: { ...context, verifiedRouteDetails } })
        .where(and(eq(contextSnapshots.id, snapshot.id), eq(contextSnapshots.userId, userId)));
    const existing = await tx
      .select({
        id: actionCandidates.id,
        objectId: actionCandidates.targetLifeObjectId,
        payload: actionCandidates.actionPayload,
      })
      .from(actionCandidates)
      .where(
        and(eq(actionCandidates.userId, userId), eq(actionCandidates.decisionSessionId, sessionId)),
      );
    const ids = new Map(
      existing.map((item) => [String(item.payload.actionKey ?? item.objectId), item.id]),
    );
    const currentIds = new Set(rows.map((item) => item.id));
    const currentActionKeys = new Set(ranked.map((item) => item.actionKey));
    for (const item of existing) {
      if (
        item.objectId == null ||
        !currentIds.has(item.objectId) ||
        (item.payload.actionKey != null && !currentActionKeys.has(String(item.payload.actionKey)))
      )
        await tx
          .update(actionCandidates)
          .set({ hardFilterStatus: "FILTERED", hardFilterReason: "SOURCE_UNAVAILABLE", rank: null })
          .where(eq(actionCandidates.id, item.id));
    }
    for (const item of ranked) {
      const values = {
        actionType: item.executionType,
        actionPayload: {
          headline: item.headline,
          body: item.body,
          reasonText: item.reasonText,
          actionKey: item.actionKey,
          actionMode: item.actionMode,
          requiredSeconds: item.requiredSeconds,
          plan: this.plans.propose(item, context.timezone),
          routeCheck: routeChecks.get(item.id) ?? null,
        },
        valueScore: item.valueScore,
        fitScore: item.fitScore,
        frictionScore: item.frictionScore,
        urgencyScore: item.urgencyScore,
        uncertaintyScore: item.uncertaintyScore,
        totalScore: item.totalScore,
        hardFilterStatus: item.hardFilterReason ? "FILTERED" : "ELIGIBLE",
        hardFilterReason: item.hardFilterReason,
        rank: item.rank,
        generatorVersion: "action-generator-v0.3",
        scoringVersion,
      };
      const savedId = ids.get(item.actionKey);
      if (savedId)
        await tx.update(actionCandidates).set(values).where(eq(actionCandidates.id, savedId));
      else {
        const id = uuidv7();
        ids.set(item.actionKey, id);
        await tx.insert(actionCandidates).values({
          id,
          userId,
          decisionSessionId: sessionId,
          targetLifeObjectId: item.id,
          ...values,
        });
      }
    }
    const best = ranked.find((item) => item.hardFilterReason == null);
    const question = allowQuestions
      ? nextDecisionQuestion(rows, context, askedKeys, decisionTime)
      : null;
    if (question) {
      await tx.insert(clarificationRequests).values({
        id: uuidv7(),
        userId,
        decisionSessionId: sessionId,
        scopeType: "DECISION",
        questionKey: question.key,
        questionText: question.text,
        options: {
          items: [
            ...question.options.map(({ id, label }) => ({ id, label })),
            { id: "SKIP", label: "先给我一个建议" },
          ],
        },
        informationGain: question.informationGain,
        sequence: askedKeys.length + 1,
        status: "PENDING",
      });
      await tx
        .update(decisionSessions)
        .set({ status: "NEEDS_ANSWER", interventionScore: best?.totalScore ?? 0 })
        .where(eq(decisionSessions.id, sessionId));
      return;
    }
    if (!best || best.totalScore < interventionThreshold) {
      await tx
        .update(decisionSessions)
        .set({ status: "QUIET", interventionScore: best?.totalScore ?? 0 })
        .where(eq(decisionSessions.id, sessionId));
      return;
    }
    await tx.insert(recommendations).values({
      id: uuidv7(),
      userId,
      decisionSessionId: sessionId,
      actionCandidateId: ids.get(best.actionKey)!,
      headline: best.headline,
      body: best.body,
      reasonText: best.reasonText,
      executionType: best.executionType,
      executionPayload: {
        targetLifeObjectId: best.id,
        targetObjectVersion: best.objectVersion,
        actionKey: best.actionKey,
        plan: this.plans.propose(best, context.timezone),
      },
      copyVersion: "template-v0.3",
      expiresAt: new Date(
        Math.min(
          Date.now() + 30 * 60000,
          context.calendar?.availableUntil
            ? new Date(context.calendar.availableUntil).getTime()
            : Infinity,
          best.actionMode === "DO" && best.route
            ? new Date(best.route.expiresAt).getTime()
            : Infinity,
        ),
      ),
    });
    await tx
      .update(decisionSessions)
      .set({ status: "RECOMMENDED", interventionScore: best.totalScore })
      .where(eq(decisionSessions.id, sessionId));
  }

  private async read(
    tx: DbTransaction,
    userId: string,
    sessionId: string,
    includeRouteDetails = true,
  ) {
    const [session] = await tx
      .select()
      .from(decisionSessions)
      .where(and(eq(decisionSessions.userId, userId), eq(decisionSessions.id, sessionId)))
      .limit(1);
    if (!session) throw new NotFoundException({ code: "DECISION_SESSION_NOT_FOUND" });
    const candidates = await tx
      .select({
        lifeObjectId: actionCandidates.targetLifeObjectId,
        payload: actionCandidates.actionPayload,
        title: lifeObjects.title,
        objectVersion: lifeObjects.objectVersion,
        totalScore: actionCandidates.totalScore,
        rank: actionCandidates.rank,
        filterReason: actionCandidates.hardFilterReason,
        hardFilterStatus: actionCandidates.hardFilterStatus,
        value: actionCandidates.valueScore,
        fit: actionCandidates.fitScore,
        urgency: actionCandidates.urgencyScore,
        friction: actionCandidates.frictionScore,
        uncertainty: actionCandidates.uncertaintyScore,
      })
      .from(actionCandidates)
      .leftJoin(
        lifeObjects,
        and(
          eq(lifeObjects.id, actionCandidates.targetLifeObjectId),
          eq(lifeObjects.userId, userId),
          isNull(lifeObjects.deletedAt),
        ),
      )
      .where(
        and(eq(actionCandidates.userId, userId), eq(actionCandidates.decisionSessionId, sessionId)),
      );
    const [question] = await tx
      .select()
      .from(clarificationRequests)
      .where(
        and(
          eq(clarificationRequests.userId, userId),
          eq(clarificationRequests.decisionSessionId, sessionId),
          eq(clarificationRequests.scopeType, "DECISION"),
          eq(clarificationRequests.status, "PENDING"),
        ),
      )
      .orderBy(desc(clarificationRequests.sequence))
      .limit(1);
    const [recommendation] = await tx
      .select()
      .from(recommendations)
      .innerJoin(
        lifeObjects,
        and(
          eq(
            lifeObjects.id,
            sql`(${recommendations.executionPayload}->>'targetLifeObjectId')::uuid`,
          ),
          eq(lifeObjects.userId, userId),
          isNull(lifeObjects.deletedAt),
        ),
      )
      .where(
        and(eq(recommendations.userId, userId), eq(recommendations.decisionSessionId, sessionId)),
      )
      .orderBy(desc(recommendations.surfacedAt))
      .limit(1);
    const visibleRecommendation =
      session.status === "CLOSED" ? undefined : recommendation?.recommendations;
    const sourceUnavailable =
      session.status === "CLOSED" || (session.status === "RECOMMENDED" && !visibleRecommendation);
    const parsedPlan = visibleRecommendation
      ? actionPlanSchema.safeParse(visibleRecommendation.executionPayload.plan)
      : null;
    const progress = visibleRecommendation
      ? await this.plans.progress(tx, userId, visibleRecommendation.id)
      : undefined;
    const plan = parsedPlan?.success
      ? progress?.startedAt
        ? this.plans.retime(
            parsedPlan.data,
            progress.startedAt,
            nowContextSchema.parse(session.contextSummary).timezone,
          )
        : parsedPlan.data
      : null;
    const targetId =
      session.contextSummary.focusObjectId ??
      visibleRecommendation?.executionPayload.targetLifeObjectId;
    const [snapshot] =
      includeRouteDetails && !sourceUnavailable
        ? await tx
            .select()
            .from(contextSnapshots)
            .where(
              and(
                eq(contextSnapshots.userId, userId),
                eq(contextSnapshots.decisionSessionId, sessionId),
                gt(contextSnapshots.purgeAt, new Date()),
              ),
            )
            .orderBy(desc(contextSnapshots.createdAt), desc(contextSnapshots.id))
            .limit(1)
        : [];
    const publicRouteCheck = (item: (typeof candidates)[number] | undefined): RouteCheck | null => {
      const parsed = routeCheckSchema.safeParse(item?.payload.routeCheck);
      if (!parsed.success) return null;
      // Drop any legacy embedded detail, even if no valid snapshot is available.
      const base: RouteCheck = { status: parsed.data.status, reason: parsed.data.reason };
      if (
        base.status !== "READY" ||
        !snapshot ||
        !item ||
        !item.lifeObjectId ||
        item.lifeObjectId !== targetId ||
        !item.title ||
        sourceUnavailable
      )
        return base;
      const records = snapshot.context.verifiedRouteDetails as
        | Record<
            string,
            {
              detail?: unknown;
              objectVersion?: number;
              observedAt?: string;
              expiresAt?: string;
            }
          >
        | undefined;
      const record = records?.[item.lifeObjectId];
      const detail = routeCheckDetailSchema.safeParse(record?.detail);
      const context = nowContextSchema.safeParse(snapshot.context);
      const now = Date.now();
      if (
        !detail.success ||
        !context.success ||
        record?.objectVersion !== item.objectVersion ||
        !record.observedAt ||
        !record.expiresAt ||
        !(Date.parse(record.observedAt) <= now + 30000 && Date.parse(record.expiresAt) > now) ||
        snapshot.createdAt.getTime() + 2 * 3600000 <= now
      )
        return base;
      const location = context.data.location;
      if (
        !location ||
        location.source === "SAVED_HOME" ||
        location.coordinateSystem !== "GCJ02" ||
        location.latitude !== detail.data.origin.latitude ||
        location.longitude !== detail.data.origin.longitude ||
        (location.expiresAt && !(Date.parse(location.expiresAt) > now)) ||
        (location.observedAt &&
          !(
            Date.parse(location.observedAt) <= now + 30000 &&
            Date.parse(location.observedAt) + 2 * 3600000 > now
          ))
      )
        return base;
      const availableUntil = context.data.calendar?.availableUntil;
      const remainingSeconds = availableUntil
        ? Math.max(0, Math.floor((Date.parse(availableUntil) - now) / 1000))
        : null;
      return {
        ...base,
        detail: {
          ...detail.data,
          availableSeconds:
            remainingSeconds == null
              ? detail.data.availableSeconds
              : Math.min(remainingSeconds, detail.data.availableSeconds ?? Infinity),
        },
      };
    };
    return {
      sessionId,
      focusObjectId:
        typeof session.contextSummary.focusObjectId === "string"
          ? session.contextSummary.focusObjectId
          : null,
      routeCheck: (() => {
        if (sourceUnavailable) return null;
        const target = candidates.find((item) => item.lifeObjectId === targetId);
        return publicRouteCheck(target);
      })(),
      status: sourceUnavailable ? "QUIET" : session.status,
      quietReason: sourceUnavailable
        ? "这条心愿已删除，可以看看新的建议。"
        : session.status === "QUIET" &&
            nowContextSchema.parse(session.contextSummary).calendar?.isBusy
          ? "这会儿已有安排，先完成正在做的事。"
          : null,
      question:
        session.status === "NEEDS_ANSWER" && question
          ? nowQuestionSchema.parse({
              id: question.id,
              key: question.questionKey,
              text: question.questionText,
              options: question.options.items,
              sequence: question.sequence,
              maxQuestions: maximumNowQuestions,
            })
          : null,
      recommendation: visibleRecommendation
        ? {
            id: visibleRecommendation.id,
            targetLifeObjectId: (
              visibleRecommendation.executionPayload as { targetLifeObjectId: string }
            ).targetLifeObjectId,
            headline: visibleRecommendation.headline,
            body: visibleRecommendation.body,
            reasonText: visibleRecommendation.reasonText,
            executionType: visibleRecommendation.executionType,
            plan,
            progress,
            score: session.interventionScore ?? 0,
          }
        : null,
      candidates: candidates
        .filter((item) => item.lifeObjectId != null && item.title != null)
        .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
        .map((item) => ({
          lifeObjectId: item.lifeObjectId!,
          title: item.title ?? "已移除的记录",
          actionKey: item.payload.actionKey,
          actionMode: item.payload.actionMode,
          actionTitle: item.payload.headline,
          requiredSeconds: item.payload.requiredSeconds,
          routeCheck: publicRouteCheck(item),
          totalScore: item.totalScore,
          rank: item.rank,
          filtered: item.hardFilterStatus === "FILTERED",
          filterReason: item.filterReason,
          scores: {
            value: item.value,
            fit: item.fit,
            urgency: item.urgency,
            friction: item.friction,
            uncertainty: item.uncertainty,
          },
        })),
    };
  }

  private publicContext(
    context: NowContext,
    focusObjectId?: string,
  ): NowContext & { focusObjectId?: string } {
    const location = context.location;
    return {
      ...nowContextSchema.parse({
        ...context,
        location:
          location && (location.region || location.city)
            ? {
                region: location.region,
                city: location.city,
                source: location.source,
                observedAt: location.observedAt,
                expiresAt: location.expiresAt,
              }
            : undefined,
      }),
      ...(focusObjectId ? { focusObjectId } : {}),
    };
  }

  private async enqueueLegacyFacts(
    tx: DbTransaction,
    userId: string,
    rows: (DecisionCandidate & { projectionVersion?: string; updatedAt?: Date })[],
  ) {
    // Keep paid reconstruction off the decision path and bound it to five old objects.
    for (const row of rows
      .filter((item) => /^projection-v0\.[123]$/.test(item.projectionVersion ?? ""))
      .slice(0, 5)) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`facts:${userId}:${row.id}`},0))`,
      );
      const [existing] = await tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.eventType, "LIFE_FACTS_REBUILD"),
            eq(outboxEvents.aggregateId, row.id),
            sql`${outboxEvents.payload}->>'userId' = ${userId}`,
            sql`${outboxEvents.payload}->>'objectVersion' = ${String(row.objectVersion ?? 1)}`,
            sql`${outboxEvents.payload}->>'factsVersion' = 'life-facts-v0.4'`,
            sql`${outboxEvents.payload}->>'sourceUpdatedAt' = ${row.updatedAt?.toISOString() ?? "unknown"}`,
          ),
        )
        .limit(1);
      if (!existing)
        await tx.insert(outboxEvents).values({
          id: uuidv7(),
          aggregateType: "LIFE_OBJECT",
          aggregateId: row.id,
          eventType: "LIFE_FACTS_REBUILD",
          payload: {
            lifeObjectId: row.id,
            userId,
            objectVersion: row.objectVersion ?? 1,
            factsVersion: "life-facts-v0.4",
            sourceUpdatedAt: row.updatedAt?.toISOString() ?? "unknown",
            traceId: uuidv7(),
          },
        });
    }
  }

  private async withFacts(
    tx: DbTransaction,
    userId: string,
    rows: DecisionCandidate[],
    context: NowContext,
    focusObjectId?: string,
    preferScenicBus = false,
  ): Promise<
    Array<
      DecisionCandidate & {
        routeCheck?: RouteCheck | null;
        destinationLabel?: string;
        routeComparisonComplete?: boolean;
        routeTransitMixed?: boolean;
      }
    >
  > {
    if (!rows.length) return rows;
    const ids = rows.map((item) => item.id);
    const links = await tx
      .select()
      .from(lifeObjectRelations)
      .where(
        and(
          eq(lifeObjectRelations.userId, userId),
          isNull(lifeObjectRelations.deletedAt),
          inArray(lifeObjectRelations.fromObjectId, ids),
          inArray(lifeObjectRelations.relationType, ["TARGETS", "LOCATED_AT", "VALID_AT"]),
        ),
      )
      .limit(500);
    const allIds = [...new Set([...ids, ...links.map((link) => link.toObjectId)])];
    const facets = await tx
      .select({
        objectId: lifeObjectFacets.lifeObjectId,
        data: lifeObjectFacets.data,
        confidence: lifeObjectFacets.confidence,
        facetType: lifeObjectFacets.facetType,
        facetKey: lifeObjectFacets.facetKey,
        originType: lifeObjectFacets.originType,
      })
      .from(lifeObjectFacets)
      .innerJoin(lifeObjects, eq(lifeObjects.id, lifeObjectFacets.lifeObjectId))
      .where(
        and(
          eq(lifeObjectFacets.userId, userId),
          eq(lifeObjects.userId, userId),
          isNull(lifeObjectFacets.deletedAt),
          isNull(lifeObjects.deletedAt),
          inArray(lifeObjectFacets.lifeObjectId, allIds),
          or(eq(lifeObjects.status, "ACTIVE"), eq(lifeObjects.status, "RESOLVED")),
        ),
      )
      .limit(5000);
    const enriched = rows.map((item) => {
      const attached = new Set([
        item.id,
        ...links.filter((link) => link.fromObjectId === item.id).map((link) => link.toObjectId),
      ]);
      const actionFacts = facets
        .filter((facet) => attached.has(facet.objectId) && facet.confidence >= 0.7)
        .flatMap((facet) => {
          const parsed = structuredLifeFactsSchema.safeParse(facet.data.facts);
          return parsed.success ? [parsed.data] : [];
        });
      const destinationQuery = destinationQueryForObject(
        item,
        facets.filter((facet) => attached.has(facet.objectId)),
      );
      return { ...item, actionFacts, destinationQuery };
    });
    // Indoor/media actions do not consume the geographic lookup budget.
    const localRanking = scoreCandidates(enriched, context);
    const geographicIds = new Set(
      localRanking.filter((item) => item.requiresGoOut).map((item) => item.id),
    );
    const orderedIds = [
      ...new Set(localRanking.filter((item) => geographicIds.has(item.id)).map((item) => item.id)),
    ];
    if (focusObjectId && geographicIds.has(focusObjectId)) {
      orderedIds.splice(orderedIds.indexOf(focusObjectId), 1);
      orderedIds.unshift(focusObjectId);
    }
    const topIds = orderedIds.slice(0, 5);
    const external = await this.contexts.enrichCandidates(
      context,
      topIds
        .map((id) => enriched.find((item) => item.id === id)!)
        .map((item) => {
          return {
            id: item.id,
            title: item.title,
            kind: item.kind,
            ...(item.latitude != null && item.longitude != null && item.coordinateSystem === "GCJ02"
              ? {
                  location: {
                    latitude: item.latitude,
                    longitude: item.longitude,
                    coordinateSystem: "GCJ02" as const,
                  },
                }
              : {}),
            address: item.destinationQuery?.address,
            city: item.destinationQuery?.city,
            requiresRoute: true,
            activitySeconds: planningFacts(item).requiredSeconds,
            activityCostMinor: planningFacts(item).costMinMinor,
          };
        }),
      { compareModesForId: focusObjectId, preferScenicBus },
    );
    return enriched.map((item) => {
      const result = external[item.id],
        route = result?.route,
        destination = result?.destination;
      return {
        ...item,
        destinationLabel: item.destinationQuery?.label ?? item.title,
        routeComparisonComplete: route?.comparisonComplete,
        routeTransitMixed: route?.transitMixed,
        routeCheck: result
          ? ({ status: result.status, reason: result.reason ?? null } as RouteCheck)
          : geographicIds.has(item.id)
            ? ({ status: "NOT_CHECKED", reason: "LOOKUP_LIMIT" } as RouteCheck)
            : item.id === focusObjectId
              ? ({ status: "NOT_CHECKED", reason: "NOT_GEOGRAPHIC" } as RouteCheck)
              : null,
        ...(destination
          ? {
              latitude: destination.latitude,
              longitude: destination.longitude,
              coordinateSystem: destination.coordinateSystem,
            }
          : {}),
        ...(route ? { route: { ...route, verification: "PROVIDER_VERIFIED" as const } } : {}),
      };
    });
  }

  async get(userId: string, sessionId: string) {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select({ id: decisionSessions.id })
        .from(decisionSessions)
        .where(and(eq(decisionSessions.userId, userId), eq(decisionSessions.id, sessionId)))
        .for("share")
        .limit(1);
      if (!session) throw new NotFoundException({ code: "DECISION_SESSION_NOT_FOUND" });
      return { ...(await this.read(tx, userId, sessionId)), replayed: false };
    });
  }
}
