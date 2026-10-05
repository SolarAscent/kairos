import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { v7 as uuidv7 } from "uuid";
import {
  feedbackEvents,
  outboxEvents,
  recommendations,
  lifeObjects,
  contextSnapshots,
} from "@life/db";
import { actionPlanSchema, nowContextSchema, type CreateFeedbackRequest } from "@life/contracts";
import { ActionPlanService } from "../planning/action-plan.service.js";
import { BuildDecisionContextService } from "../context/build-decision-context.service.js";
import { IdempotencyService } from "../common/idempotency.service.js";

@Injectable()
export class FeedbackService {
  constructor(
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(ActionPlanService) private readonly plans: ActionPlanService,
    @Inject(BuildDecisionContextService) private readonly contexts: BuildDecisionContextService,
  ) {}

  async record(
    userId: string,
    sessionId: string,
    input: CreateFeedbackRequest,
    key: string | undefined,
    traceId: string,
  ) {
    const result = await this.idempotency.execute(
      userId,
      "POST /v1/now/sessions/" + sessionId + "/feedback",
      key,
      input,
      async (tx) => {
        if (input.metadata && "serverPlan" in input.metadata)
          throw new BadRequestException({ code: "FEEDBACK_METADATA_RESERVED" });
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ":" + input.clientEventId}, 0))`,
        );
        const [existing] = await tx
          .select()
          .from(feedbackEvents)
          .where(
            and(
              eq(feedbackEvents.userId, userId),
              eq(feedbackEvents.clientEventId, input.clientEventId),
            ),
          )
          .limit(1);
        if (existing) {
          if (
            existing.decisionSessionId !== sessionId ||
            existing.eventType !== input.eventType ||
            existing.reasonCode !== (input.reasonCode ?? null) ||
            !isDeepStrictEqual(
              existing.metadata && "serverPlan" in existing.metadata
                ? Object.fromEntries(
                    Object.entries(existing.metadata).filter(([key]) => key !== "serverPlan"),
                  )
                : existing.metadata,
              input.metadata ??
                (existing.metadata && "serverPlan" in existing.metadata ? {} : null),
            )
          )
            throw new ConflictException({ code: "CLIENT_EVENT_CONFLICT" });
          return {
            feedbackId: existing.id,
            eventType: existing.eventType,
            replayedClientEvent: true,
            progress: await this.plans.progress(tx, userId, existing.recommendationId),
          };
        }
        const [recommendation] = await tx
          .select({
            recommendationId: recommendations.id,
            candidateId: recommendations.actionCandidateId,
            executionPayload: recommendations.executionPayload,
            expiresAt: recommendations.expiresAt,
          })
          .from(recommendations)
          .where(
            and(
              eq(recommendations.userId, userId),
              eq(recommendations.decisionSessionId, sessionId),
            ),
          )
          .limit(1);
        if (!recommendation) throw new NotFoundException({ code: "RECOMMENDATION_NOT_FOUND" });
        // All plan starts for an owner serialize; two simultaneous accepted actions cannot consume the same minutes.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ":action-plan"}, 0))`,
        );
        const progress = await this.plans.progress(tx, userId, recommendation.recommendationId);
        const parsedPlan = actionPlanSchema.safeParse(recommendation.executionPayload.plan);
        let serverPlan: Record<string, unknown> | undefined;
        if (["ACCEPT", "EXECUTE"].includes(input.eventType)) {
          if (progress.state === "COMPLETED" || progress.state === "CANCELLED")
            throw new ConflictException({ code: "ACTION_ALREADY_FINISHED" });
          if (progress.state === "NOT_STARTED") {
            const [target] = await tx
              .select()
              .from(lifeObjects)
              .where(
                and(
                  eq(lifeObjects.id, String(recommendation.executionPayload.targetLifeObjectId)),
                  eq(lifeObjects.userId, userId),
                ),
              )
              .for("share")
              .limit(1);
            if (
              !target ||
              target.status !== "ACTIVE" ||
              target.deletedAt ||
              (recommendation.executionPayload.targetObjectVersion != null &&
                target.objectVersion !== recommendation.executionPayload.targetObjectVersion)
            )
              throw new ConflictException({ code: "ACTION_SOURCE_CHANGED" });
            if (recommendation.expiresAt && recommendation.expiresAt <= new Date())
              throw new GoneException({ code: "RECOMMENDATION_EXPIRED" });
            if (parsedPlan.success) {
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
              const saved = nowContextSchema.safeParse(snapshot?.context);
              const deadline = saved.success ? saved.data.calendar?.availableUntil : undefined;
              const { context } = await this.contexts.build(
                userId,
                deadline
                  ? { calendar: { isBusy: false, eventIds: [], availableUntil: deadline } }
                  : {},
                tx,
              );
              if (
                context.calendar?.isBusy ||
                (context.calendar?.effectiveAvailableMinutes != null &&
                  parsedPlan.data.totalSeconds > context.calendar.effectiveAvailableMinutes * 60)
              )
                throw new ConflictException({ code: "ACTION_TIME_CONFLICT" });
              const at = new Date();
              if (
                parsedPlan.data.validUntil &&
                at.getTime() + parsedPlan.data.totalSeconds * 1000 >
                  new Date(parsedPlan.data.validUntil).getTime()
              )
                throw new ConflictException({ code: "ACTION_TIME_CONFLICT" });
              serverPlan = {
                startAt: at.toISOString(),
                endAt: new Date(at.getTime() + parsedPlan.data.totalSeconds * 1000).toISOString(),
                totalSeconds: parsedPlan.data.totalSeconds,
              };
            }
          }
        } else if (input.eventType === "COMPLETE" && progress.state !== "ACTIVE") {
          throw new ConflictException({ code: "ACTION_NOT_STARTED" });
        }
        const feedbackId = uuidv7();
        await tx.insert(feedbackEvents).values({
          id: feedbackId,
          // Transaction now() can precede waiting for the owner lock; record the actual transition.
          createdAt: new Date(),
          userId,
          recommendationId: recommendation.recommendationId,
          decisionSessionId: sessionId,
          eventType: input.eventType,
          reasonCode: input.reasonCode,
          metadata: serverPlan ? { ...input.metadata, serverPlan } : input.metadata,
          clientEventId: input.clientEventId,
        });
        await tx.insert(outboxEvents).values({
          id: uuidv7(),
          aggregateType: "FEEDBACK",
          aggregateId: feedbackId,
          eventType: "FEEDBACK_RECORDED",
          payload: { feedbackId, userId, candidateId: recommendation.candidateId, traceId },
        });
        return {
          feedbackId,
          eventType: input.eventType,
          replayedClientEvent: false,
          progress: await this.plans.progress(tx, userId, recommendation.recommendationId),
        };
      },
    );
    return { ...result.body, replayed: result.replayed };
  }
}
