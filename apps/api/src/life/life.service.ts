import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  lifeSectionSchema,
  lifeSectionTitles,
  uuidSchema,
  type LifeSearchRequest,
  type PatchLifeObjectRequest,
  parsedFacetSchema,
  facetTypeSchema,
  structuredLifeFactsSchema,
  type LifeRating,
  type LifeDeckRequest,
} from "@life/contracts";
import {
  lifeObjectFacets,
  lifeObjectProjection,
  lifeObjectSources,
  lifeObjects,
  outboxEvents,
  users,
  auditEvents,
  actionCandidates,
  feedbackEvents,
  recommendations,
  preferenceSignals,
  type Database,
} from "@life/db";
import { v7 as uuidv7 } from "uuid";
import { buildLifeProjection } from "@life/domain";
import { verifiedDestinationForObject } from "@life/integrations";
import { IdempotencyService } from "../common/idempotency.service.js";
import { DATABASE } from "../common/tokens.js";
import { PreferenceReader } from "../feedback/preference-reader.js";
import { LifeDeckReader } from "./life-deck-reader.js";

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: uuidSchema });
const listFields = {
  id: lifeObjects.id,
  title: lifeObjects.title,
  summary: lifeObjects.summary,
  kind: lifeObjects.kind,
  status: lifeObjects.status,
  importance: lifeObjects.importanceScore,
  createdAt: lifeObjects.createdAt,
  searchText: lifeObjectProjection.searchText,
  displayKind: lifeObjectProjection.displayKind,
};
const hasLocation = sql<boolean>`(${lifeObjectProjection.latitude} between -90 and 90 and ${lifeObjectProjection.longitude} between -180 and 180 and ${lifeObjectProjection.coordinateSystem} = 'GCJ02') is true`;

@Injectable()
export class LifeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  async list(userId: string) {
    return this.db
      .select(listFields)
      .from(lifeObjects)
      .leftJoin(lifeObjectProjection, eq(lifeObjectProjection.lifeObjectId, lifeObjects.id))
      .where(
        and(
          eq(lifeObjects.userId, userId),
          eq(lifeObjects.status, "ACTIVE"),
          isNull(lifeObjects.deletedAt),
        ),
      )
      .orderBy(desc(lifeObjects.updatedAt))
      .limit(100);
  }

  async sections(userId: string) {
    const groups = await Promise.all(
      lifeSectionSchema.options.map(async (section) => ({
        section,
        title: lifeSectionTitles[section],
        items: (await this.search(userId, { section, location: "ALL", limit: 3 })).items,
      })),
    );
    return groups.filter((group) => group.items.length > 0);
  }

  async deck(userId: string, input: LifeDeckRequest) {
    return new LifeDeckReader(this.db).deck(userId, input);
  }

  async stacks(userId: string) {
    return new LifeDeckReader(this.db).stacks(userId);
  }

  async rate(userId: string, id: string, rating: LifeRating, key: string | undefined) {
    const result = await this.idempotency.execute(
      userId,
      `POST /v1/life/${id}/rating`,
      key,
      { rating },
      async (tx) => {
        const [object] = await tx
          .select()
          .from(lifeObjects)
          .where(
            and(
              eq(lifeObjects.id, id),
              eq(lifeObjects.userId, userId),
              isNull(lifeObjects.deletedAt),
            ),
          )
          .for("update")
          .limit(1);
        if (!object || !["ACTIVE", "RESOLVED"].includes(object.status))
          throw new NotFoundException({ code: "LIFE_OBJECT_NOT_FOUND" });
        const existing = await new PreferenceReader(tx).read(userId, [{ id, kind: object.kind }]);
        if ((existing.get(id)?.myRating ?? "NONE") !== rating) {
          await tx.insert(preferenceSignals).values({
            id: uuidv7(),
            userId,
            dimension: "life_object",
            value: { lifeObjectId: id, kind: object.kind, rating },
            polarity: rating === "DISLIKE" ? -1 : 1,
            strength: rating === "NONE" ? 0 : 1,
            confidence: 1,
            sourceType: "LIFE_RATING",
            sourceId: uuidv7(),
            occurredAt: new Date(),
          });
        }
        return { id, rating, updated: true as const };
      },
    );
    return { ...result.body, replayed: result.replayed };
  }

  async delete(userId: string, id: string, key: string | undefined, traceId: string) {
    const result = await this.idempotency.execute(
      userId,
      `DELETE /v1/life/${id}`,
      key,
      {},
      async (tx) => {
        // Feedback starts take this owner lock before sharing the object row; preserve that order.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ":action-plan"},0))`,
        );
        const [object] = await tx
          .select()
          .from(lifeObjects)
          .where(and(eq(lifeObjects.id, id), eq(lifeObjects.userId, userId)))
          .for("update")
          .limit(1);
        if (!object) throw new NotFoundException({ code: "LIFE_OBJECT_NOT_FOUND" });
        if (!object.deletedAt) {
          const now = new Date();
          await tx
            .update(lifeObjects)
            .set({
              status: "DELETED",
              deletedAt: now,
              updatedAt: now,
              objectVersion: object.objectVersion + 1,
            })
            .where(eq(lifeObjects.id, id));
          // Cancellation changes action progress without claiming this category is disliked.
          await tx.execute(sql`INSERT INTO feedback_events
          (id,user_id,recommendation_id,decision_session_id,event_type,reason_code,metadata,client_event_id,created_at)
          SELECT gen_random_uuid(),${userId}::uuid,r.id,r.decision_session_id,'DISMISS','OBJECT_DELETED',
            '{"reason":"OBJECT_DELETED"}'::jsonb,gen_random_uuid(),
            greatest(${now.toISOString()}::timestamptz,coalesce((SELECT max(f.created_at)+interval '1 microsecond'
              FROM feedback_events f WHERE f.user_id=r.user_id AND f.recommendation_id=r.id),${now.toISOString()}::timestamptz))
          FROM recommendations r JOIN action_candidates c ON c.id=r.action_candidate_id AND c.user_id=r.user_id
          WHERE r.user_id=${userId}::uuid AND c.target_life_object_id=${id}::uuid
            AND EXISTS(SELECT 1 FROM feedback_events f WHERE f.recommendation_id=r.id AND f.user_id=r.user_id
              AND f.event_type IN ('ACCEPT','EXECUTE'))
            AND NOT EXISTS(SELECT 1 FROM feedback_events f WHERE f.recommendation_id=r.id AND f.user_id=r.user_id
              AND f.event_type IN ('COMPLETE','REJECT','DISMISS','SKIP'))`);
          await tx.execute(sql`UPDATE decision_sessions s SET status='CLOSED',closed_at=${now.toISOString()}::timestamptz
          WHERE s.user_id=${userId}::uuid AND s.status<>'CLOSED'
            AND EXISTS(SELECT 1 FROM recommendations r JOIN action_candidates c
              ON c.id=r.action_candidate_id AND c.user_id=r.user_id
              WHERE r.user_id=s.user_id AND r.decision_session_id=s.id
                AND c.target_life_object_id=${id}::uuid)`);
          await tx
            .update(actionCandidates)
            .set({
              hardFilterStatus: "FILTERED",
              hardFilterReason: "SOURCE_UNAVAILABLE",
              rank: null,
            })
            .where(
              and(eq(actionCandidates.userId, userId), eq(actionCandidates.targetLifeObjectId, id)),
            );
          await tx.execute(sql`UPDATE clarification_requests q SET status='CANCELLED'
          WHERE q.user_id=${userId}::uuid AND q.status='PENDING'
            AND EXISTS(SELECT 1 FROM decision_sessions s WHERE s.id=q.decision_session_id
              AND s.user_id=q.user_id AND s.status='CLOSED')`);
          await tx.insert(auditEvents).values({
            id: uuidv7(),
            actorType: "USER",
            actorId: userId,
            action: "LIFE_DELETED",
            targetType: "LIFE_OBJECT",
            targetId: id,
            metadata: {},
            traceId,
          });
        }
        return { id, deleted: true as const };
      },
    );
    return { ...result.body, replayed: result.replayed };
  }

  async search(userId: string, input: LifeSearchRequest) {
    const now = new Date();
    const conditions = [
      eq(lifeObjects.userId, userId),
      isNull(lifeObjects.deletedAt),
      eq(lifeObjects.status, input.section === "HAPPENED" ? "RESOLVED" : "ACTIVE"),
    ];
    switch (input.section) {
      case "UPCOMING": {
        const soon = new Date(now.getTime() + 14 * 86400000);
        conditions.push(
          or(
            and(gte(lifeObjectProjection.nextAt, now), lte(lifeObjectProjection.nextAt, soon)),
            and(
              gte(lifeObjectProjection.expiresAt, now),
              lte(lifeObjectProjection.expiresAt, soon),
            ),
          )!,
        );
        break;
      }
      case "RETURN": {
        const revisited = this.db
          .select({ id: actionCandidates.targetLifeObjectId })
          .from(feedbackEvents)
          .innerJoin(recommendations, eq(recommendations.id, feedbackEvents.recommendationId))
          .innerJoin(actionCandidates, eq(actionCandidates.id, recommendations.actionCandidateId))
          .where(
            and(
              eq(feedbackEvents.userId, userId),
              inArray(feedbackEvents.eventType, ["EXECUTE", "NAVIGATE", "COMPLETE"]),
            ),
          )
          .groupBy(actionCandidates.targetLifeObjectId)
          .having(sql`count(distinct ${feedbackEvents.decisionSessionId}) >= 2`);
        conditions.push(eq(lifeObjects.kind, "PLACE"), inArray(lifeObjects.id, revisited));
        break;
      }
      case "REMEMBERED":
        conditions.push(lt(lifeObjects.createdAt, new Date(now.getTime() - 30 * 86400000)));
        break;
      case "THINKING":
        conditions.push(
          inArray(lifeObjects.kind, ["DESIRE", "OPEN_LOOP"]),
          gte(lifeObjects.lastSeenAt, new Date(now.getTime() - 30 * 86400000)),
        );
        break;
    }
    if (input.savedWithinDays != null)
      conditions.push(
        gte(lifeObjects.createdAt, new Date(now.getTime() - input.savedWithinDays * 86400000)),
      );
    if (input.kind) conditions.push(eq(lifeObjects.kind, input.kind));
    let distance = sql<number | null>`null::double precision`;
    if (input.location === "LOCATED" || input.location === "NEARBY") conditions.push(hasLocation);
    if (input.location === "UNLOCATED") conditions.push(sql`not (${hasLocation})`);
    if (input.location === "NEARBY") {
      const center = input.center!;
      // Great-circle distance between recorded GCJ-02 coordinates; not route/travel distance.
      distance = sql<number>`6371000 * acos(least(1.0, greatest(-1.0,
        sin(radians(${center.latitude}::double precision)) * sin(radians(${lifeObjectProjection.latitude})) +
        cos(radians(${center.latitude}::double precision)) * cos(radians(${lifeObjectProjection.latitude})) *
        cos(radians(${lifeObjectProjection.longitude} - ${center.longitude}::double precision)))))`;
      conditions.push(lte(distance, center.radiusMeters));
    }
    if (input.cursor) {
      let cursor: z.infer<typeof cursorSchema>;
      try {
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()));
      } catch {
        throw new BadRequestException({ code: "INVALID_LIFE_CURSOR" });
      }
      conditions.push(
        sql`(${lifeObjects.createdAt}, ${lifeObjects.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await this.db
      .select({
        ...listFields,
        objectVersion: lifeObjects.objectVersion,
        nextAt: lifeObjectProjection.nextAt,
        expiresAt: lifeObjectProjection.expiresAt,
        hasLocation,
        distanceMeters: distance,
        cursorCreatedAt: sql<string>`to_char(${lifeObjects.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(lifeObjects)
      .leftJoin(lifeObjectProjection, eq(lifeObjectProjection.lifeObjectId, lifeObjects.id))
      .where(and(...conditions))
      .orderBy(desc(lifeObjects.createdAt), desc(lifeObjects.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const facets = page.length
      ? await this.db
          .select({ id: lifeObjectFacets.lifeObjectId, data: lifeObjectFacets.data })
          .from(lifeObjectFacets)
          .where(
            and(
              eq(lifeObjectFacets.userId, userId),
              isNull(lifeObjectFacets.deletedAt),
              inArray(
                lifeObjectFacets.lifeObjectId,
                page.map((item) => item.id),
              ),
            ),
          )
          .orderBy(desc(lifeObjectFacets.confidence), desc(lifeObjectFacets.createdAt))
      : [];
    const names = new Map<string, string>();
    for (const facet of facets) {
      if (names.has(facet.id)) continue;
      const facts = structuredLifeFactsSchema.safeParse(facet.data.facts);
      if (!facts.success || facts.data.origin !== "USER_STATED") continue;
      const place = facts.data.place;
      const name = place?.name ?? place?.city ?? place?.province ?? place?.region;
      if (name) names.set(facet.id, name.slice(0, 240));
    }
    const learned = await new PreferenceReader(this.db).read(userId, page);
    const items = page.map(({ cursorCreatedAt: _cursorCreatedAt, ...item }) => ({
      ...item,
      ...(learned.get(item.id) ?? { myRating: "NONE" as const, preferenceScore: 0 }),
      placeLabel: names.get(item.id) ?? null,
    }));
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        rows.length > input.limit && last
          ? Buffer.from(JSON.stringify({ createdAt: last.cursorCreatedAt, id: last.id })).toString(
              "base64url",
            )
          : null,
    };
  }

  async rebuildFacts(userId: string, id: string, key: string | undefined, traceId: string) {
    const result = await this.idempotency.execute(
      userId,
      `POST /v1/life/${id}/rebuild-facts`,
      key,
      {},
      async (tx) => {
        const [object] = await tx
          .select()
          .from(lifeObjects)
          .where(
            and(
              eq(lifeObjects.userId, userId),
              eq(lifeObjects.id, id),
              isNull(lifeObjects.deletedAt),
            ),
          )
          .for("update")
          .limit(1);
        if (!object) throw new NotFoundException({ code: "LIFE_OBJECT_NOT_FOUND" });
        await tx.insert(outboxEvents).values({
          id: uuidv7(),
          aggregateType: "LIFE_OBJECT",
          aggregateId: id,
          eventType: "LIFE_FACTS_REBUILD",
          payload: { lifeObjectId: id, userId, traceId },
        });
        return { lifeObjectId: id, accepted: true as const };
      },
    );
    return { ...result.body, replayed: result.replayed };
  }

  async patch(userId: string, id: string, input: PatchLifeObjectRequest, key: string | undefined) {
    const result = await this.idempotency.execute(
      userId,
      `PATCH /v1/life/${id}`,
      key,
      input,
      async (tx) => {
        const [object] = await tx
          .select()
          .from(lifeObjects)
          .where(
            and(
              eq(lifeObjects.userId, userId),
              eq(lifeObjects.id, id),
              isNull(lifeObjects.deletedAt),
            ),
          )
          .for("update")
          .limit(1);
        if (!object) throw new NotFoundException({ code: "LIFE_OBJECT_NOT_FOUND" });
        const [user] = await tx
          .select({ timezone: users.timezone })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        const now = new Date();
        const changes = {
          ...("title" in input ? { title: input.title } : {}),
          ...("summary" in input ? { summary: input.summary } : {}),
          ...(input.status ? { status: input.status } : {}),
          updatedAt: now,
          objectVersion: object.objectVersion + 1,
        };
        await tx.update(lifeObjects).set(changes).where(eq(lifeObjects.id, id));
        for (const edit of input.facts ?? []) {
          // Keep replaced AI evidence in the database as historical facets; explicit corrections win.
          await tx
            .update(lifeObjectFacets)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(
                eq(lifeObjectFacets.userId, userId),
                eq(lifeObjectFacets.lifeObjectId, id),
                eq(lifeObjectFacets.facetKey, edit.key),
                eq(lifeObjectFacets.facetType, edit.type),
                isNull(lifeObjectFacets.deletedAt),
              ),
            );
          await tx.insert(lifeObjectFacets).values({
            id: uuidv7(),
            userId,
            lifeObjectId: id,
            facetType: edit.type,
            facetKey: edit.key,
            schemaVersion: 3,
            data: {
              intent: null,
              description: null,
              verification: "UNVERIFIED",
              facts: { ...edit.facts, origin: "USER_STATED" },
            },
            confidence: 1,
            originType: "USER_STATED",
            originId: id,
          });
        }
        const saved = await tx
          .select()
          .from(lifeObjectFacets)
          .where(
            and(
              eq(lifeObjectFacets.userId, userId),
              eq(lifeObjectFacets.lifeObjectId, id),
              isNull(lifeObjectFacets.deletedAt),
            ),
          );
        const facets = saved.flatMap((facet) => {
          const parsed = parsedFacetSchema.safeParse({
            type: facet.facetType,
            key: facet.facetKey,
            data: {
              intent: facet.data.intent ?? null,
              description: facet.data.description ?? null,
              verification: "UNVERIFIED",
              ...(facet.data.facts ? { facts: facet.data.facts } : {}),
            },
            confidence: facet.confidence,
            source: facet.originType === "INFERRED" ? "INFERRED" : "EXTRACTED",
          });
          return parsed.success ? [parsed.data] : [];
        });
        const {
          facets: _normalized,
          actionFacts: _facts,
          ...projection
        } = buildLifeProjection(
          {
            ...object,
            ...changes,
            facets,
            importance: object.importanceScore ?? 0.5,
            kind: facetTypeSchema.parse(object.kind),
          },
          { referenceTime: now.toISOString(), timezone: user?.timezone ?? "Asia/Shanghai" },
        );
        const verified = verifiedDestinationForObject({ ...object, ...changes }, saved);
        if (verified && projection.latitude == null) Object.assign(projection, verified);
        for (const facet of _normalized) {
          if (
            (input.facts ?? []).some((edit) => edit.key === facet.key && edit.type === facet.type)
          )
            await tx
              .update(lifeObjectFacets)
              .set({ data: facet.data })
              .where(
                and(
                  eq(lifeObjectFacets.userId, userId),
                  eq(lifeObjectFacets.lifeObjectId, id),
                  eq(lifeObjectFacets.facetType, facet.type),
                  eq(lifeObjectFacets.facetKey, facet.key),
                  eq(lifeObjectFacets.originType, "USER_STATED"),
                  isNull(lifeObjectFacets.deletedAt),
                ),
              );
        }
        await tx
          .insert(lifeObjectProjection)
          .values({
            lifeObjectId: id,
            userId,
            ...projection,
            displayKind: object.kind,
            importanceScore: object.importanceScore,
            rebuiltAt: now,
          })
          .onConflictDoUpdate({
            target: lifeObjectProjection.lifeObjectId,
            set: { ...projection, rebuiltAt: now },
          });
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          actorType: "USER",
          actorId: userId,
          action: "LIFE_OBJECT_UPDATED",
          targetType: "LIFE_OBJECT",
          targetId: id,
          metadata: { fields: Object.keys(input), objectVersion: changes.objectVersion },
          traceId: uuidv7(),
        });
        return { id, updated: true as const, objectVersion: changes.objectVersion };
      },
    );
    return { ...result.body, replayed: result.replayed };
  }

  async get(userId: string, id: string) {
    const [object] = await this.db
      .select()
      .from(lifeObjects)
      .where(
        and(eq(lifeObjects.userId, userId), eq(lifeObjects.id, id), isNull(lifeObjects.deletedAt)),
      )
      .limit(1);
    if (!object) throw new NotFoundException({ code: "LIFE_OBJECT_NOT_FOUND" });
    const facets = await this.db
      .select()
      .from(lifeObjectFacets)
      .where(
        and(
          eq(lifeObjectFacets.userId, userId),
          eq(lifeObjectFacets.lifeObjectId, id),
          isNull(lifeObjectFacets.deletedAt),
        ),
      );
    const sources = await this.db
      .select()
      .from(lifeObjectSources)
      .where(and(eq(lifeObjectSources.userId, userId), eq(lifeObjectSources.lifeObjectId, id)));
    return { ...object, facets, sources };
  }
}
