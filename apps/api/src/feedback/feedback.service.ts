import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { v7 as uuidv7 } from "uuid";
import { feedbackEvents, outboxEvents, recommendations } from "@life/db";
import type { CreateFeedbackRequest } from "@life/contracts";
import { IdempotencyService } from "../common/idempotency.service.js";

@Injectable()
export class FeedbackService {
  constructor(@Inject(IdempotencyService) private readonly idempotency: IdempotencyService) {}

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
            !isDeepStrictEqual(existing.metadata, input.metadata ?? null)
          )
            throw new ConflictException({ code: "CLIENT_EVENT_CONFLICT" });
          return {
            feedbackId: existing.id,
            eventType: existing.eventType,
            replayedClientEvent: true,
          };
        }
        const [recommendation] = await tx
          .select({
            recommendationId: recommendations.id,
            candidateId: recommendations.actionCandidateId,
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
        const feedbackId = uuidv7();
        await tx.insert(feedbackEvents).values({
          id: feedbackId,
          userId,
          recommendationId: recommendation.recommendationId,
          decisionSessionId: sessionId,
          eventType: input.eventType,
          reasonCode: input.reasonCode,
          metadata: input.metadata,
          clientEventId: input.clientEventId,
        });
        await tx.insert(outboxEvents).values({
          id: uuidv7(),
          aggregateType: "FEEDBACK",
          aggregateId: feedbackId,
          eventType: "FEEDBACK_RECORDED",
          payload: { feedbackId, userId, candidateId: recommendation.candidateId, traceId },
          status: "PENDING",
        });
        return { feedbackId, eventType: input.eventType, replayedClientEvent: false };
      },
    );
    return { ...result.body, replayed: result.replayed };
  }
}
