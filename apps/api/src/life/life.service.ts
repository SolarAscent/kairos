import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  lifeSectionSchema,
  lifeSectionTitles,
  uuidSchema,
  type LifeSearchRequest,
} from "@life/contracts";
import {
  lifeObjectFacets,
  lifeObjectProjection,
  lifeObjectSources,
  lifeObjects,
  actionCandidates,
  feedbackEvents,
  recommendations,
  type Database,
} from "@life/db";
import { DATABASE } from "../common/tokens.js";

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
  constructor(@Inject(DATABASE) private readonly db: Database) {}

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
    const items = page.map(({ cursorCreatedAt: _cursorCreatedAt, ...item }) => item);
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
