import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
  actionCandidates,
  contextSnapshots,
  decisionSessions,
  lifeObjectProjection,
  lifeObjects,
  recommendations,
  type Database,
} from "@life/db";
import type { CreateNowSessionRequest } from "@life/contracts";
import { scoreCandidates, scoringVersion, interventionThreshold } from "@life/domain";
import { DATABASE } from "../common/tokens.js";
import { IdempotencyService } from "../common/idempotency.service.js";

@Injectable()
export class NowService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  async create(userId: string, input: CreateNowSessionRequest, key: string | undefined) {
    const result = await this.idempotency.execute(
      userId,
      "POST /v1/now/sessions",
      key,
      input,
      async (tx) => {
        const sessionId = uuidv7();
        const context = input.context;
        await tx.insert(decisionSessions).values({
          id: sessionId,
          userId,
          status: "BUILDING",
          scoringVersion,
          questionPolicyVersion: "questions-v0.1",
          contextSummary: context,
          expiresAt: new Date(Date.now() + 2 * 3600000),
        });
        await tx.insert(contextSnapshots).values({
          id: uuidv7(),
          userId,
          decisionSessionId: sessionId,
          context,
          containsPreciseLocation: false,
        });
        const baseConditions = [
          eq(lifeObjects.userId, userId),
          eq(lifeObjects.status, "ACTIVE"),
          isNull(lifeObjects.deletedAt),
        ];
        if (input.excludeObjectIds.length > 0)
          baseConditions.push(notInArray(lifeObjects.id, input.excludeObjectIds));
        const rows = await tx
          .select({
            id: lifeObjects.id,
            title: lifeObjects.title,
            summary: lifeObjects.summary,
            kind: lifeObjects.kind,
            importance: lifeObjects.importanceScore,
            createdAt: lifeObjects.createdAt,
            expiresAt: lifeObjectProjection.expiresAt,
            costMinMinor: lifeObjectProjection.costMinMinor,
            costMaxMinor: lifeObjectProjection.costMaxMinor,
            durationMinSeconds: lifeObjectProjection.durationMinSeconds,
          })
          .from(lifeObjects)
          .innerJoin(lifeObjectProjection, eq(lifeObjectProjection.lifeObjectId, lifeObjects.id))
          .where(and(...baseConditions))
          .orderBy(desc(lifeObjects.createdAt), desc(lifeObjects.id))
          .limit(200);
        const ranked = scoreCandidates(rows, context);
        const idsByLifeObject = new Map<string, string>();
        for (const item of ranked) {
          const candidateId = uuidv7();
          idsByLifeObject.set(item.id, candidateId);
          await tx.insert(actionCandidates).values({
            id: candidateId,
            userId,
            decisionSessionId: sessionId,
            targetLifeObjectId: item.id,
            actionType: item.executionType,
            actionPayload: {
              headline: item.headline,
              body: item.body,
              reasonText: item.reasonText,
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
            generatorVersion: "action-generator-v0.2",
            scoringVersion,
          });
        }
        const best = ranked.find((candidate) => candidate.hardFilterReason == null);
        const candidates = ranked.map(this.toPublicCandidate);
        if (!best || best.totalScore < interventionThreshold) {
          await tx
            .update(decisionSessions)
            .set({ status: "QUIET", interventionScore: best?.totalScore ?? 0 })
            .where(eq(decisionSessions.id, sessionId));
          return {
            sessionId,
            status: "QUIET",
            recommendation: null,
            candidates,
          };
        }
        const recommendationId = uuidv7();
        await tx.insert(recommendations).values({
          id: recommendationId,
          userId,
          decisionSessionId: sessionId,
          actionCandidateId: idsByLifeObject.get(best.id)!,
          headline: best.headline,
          body: best.body,
          reasonText: best.reasonText,
          executionType: best.executionType,
          executionPayload: { targetLifeObjectId: best.id },
          copyVersion: "template-v0.2",
          expiresAt: new Date(Date.now() + 30 * 60000),
        });
        await tx
          .update(decisionSessions)
          .set({ status: "RECOMMENDED", interventionScore: best.totalScore })
          .where(eq(decisionSessions.id, sessionId));
        return {
          sessionId,
          status: "RECOMMENDED",
          recommendation: {
            id: recommendationId,
            targetLifeObjectId: best.id,
            headline: best.headline,
            body: best.body,
            reasonText: best.reasonText,
            executionType: best.executionType,
            score: best.totalScore,
          },
          candidates,
        };
      },
    );
    return { ...result.body, replayed: result.replayed };
  }

  private toPublicCandidate(item: ReturnType<typeof scoreCandidates>[number]) {
    return {
      lifeObjectId: item.id,
      title: item.title,
      totalScore: item.totalScore,
      rank: item.rank,
      filtered: item.hardFilterReason != null,
      filterReason: item.hardFilterReason,
      scores: {
        value: item.valueScore,
        fit: item.fitScore,
        urgency: item.urgencyScore,
        friction: item.frictionScore,
        uncertainty: item.uncertaintyScore,
      },
    };
  }

  async get(userId: string, sessionId: string) {
    const [session] = await this.db
      .select()
      .from(decisionSessions)
      .where(and(eq(decisionSessions.userId, userId), eq(decisionSessions.id, sessionId)))
      .limit(1);
    if (!session) throw new NotFoundException({ code: "DECISION_SESSION_NOT_FOUND" });
    const rows = await this.db
      .select({
        id: recommendations.id,
        headline: recommendations.headline,
        body: recommendations.body,
        reasonText: recommendations.reasonText,
        executionType: recommendations.executionType,
        executionPayload: recommendations.executionPayload,
      })
      .from(recommendations)
      .where(
        and(eq(recommendations.userId, userId), eq(recommendations.decisionSessionId, sessionId)),
      )
      .orderBy(desc(recommendations.surfacedAt))
      .limit(1);
    return { ...session, recommendation: rows[0] ?? null };
  }
}
