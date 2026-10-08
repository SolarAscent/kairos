import { lifeImageCaptureId } from "./life-image.js";
import { BadRequestException } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@life/db";
import {
  facetTypeSchema,
  uuidSchema,
  type LifeDeckRequest,
  type LifeBrowseItem,
} from "@life/contracts";
import { z } from "zod";
import {
  preferenceCtes,
  preferenceJoins,
  preferenceScoreSql,
  preferenceOrderingVersion,
} from "../feedback/preference-reader.js";

const cursorSchema = z.strictObject({
  version: z.literal(preferenceOrderingVersion),
  kind: facetTypeSchema,
  asOf: z.iso.datetime(),
  score: z.number().min(-1).max(1),
  importance: z.number().min(0).max(1),
  createdAt: z.iso.datetime(),
  id: uuidSchema,
});
const titles: Record<z.infer<typeof facetTypeSchema>, string> = {
  PLACE: "想去的地方",
  DESIRE: "心愿",
  MEDIA: "想看的内容",
  TIME_ANCHOR: "时间与约定",
  EVENT: "活动",
  ASSET: "拥有的东西",
  PREFERENCE: "喜好",
  ROUTINE: "日常",
  OPEN_LOOP: "待完成的事",
  MEMORY: "回忆",
  COLLECTION: "收藏",
};
type DeckRow = LifeBrowseItem & { cursorCreatedAt: string; ordinal?: string };

/** Ranked SQL pagination never truncates the category to an in-memory candidate shortlist. */
export class LifeDeckReader {
  constructor(private readonly db: Database) {}
  private async rows(
    userId: string,
    asOf: Date,
    kind?: string,
    cursor?: z.infer<typeof cursorSchema>,
    limit = 10,
  ) {
    const filters: SQL[] = [
      sql`o.user_id=${userId}::uuid`,
      sql`o.deleted_at IS NULL`,
      sql`o.status IN ('ACTIVE','RESOLVED')`,
      sql`o.created_at<=${asOf.toISOString()}::timestamptz`,
    ];
    if (kind) filters.push(sql`o.kind=${kind}`);
    const score = preferenceScoreSql();
    const pageFilter = cursor
      ? sql`WHERE ("preferenceScore",coalesce(importance,0.5),"cursorCreatedAt"::timestamptz,id) <
      (${cursor.score}::float8,${cursor.importance}::float8,${cursor.createdAt}::timestamptz,${cursor.id}::uuid)`
      : sql``;
    const result = await this.db.execute(sql`WITH ${preferenceCtes(userId, asOf)}, ranked AS (
      SELECT ${lifeImageCaptureId(sql`o.id`, sql`o.user_id`)} AS "imageCaptureId",o.id,o.title,o.summary,o.kind,o.status,o.importance_score AS importance,
        o.created_at AS "createdAt",o.object_version AS "objectVersion",p.search_text AS "searchText",
        p.display_kind AS "displayKind",p.next_at AS "nextAt",p.expires_at AS "expiresAt",
        (p.latitude BETWEEN -90 AND 90 AND p.longitude BETWEEN -180 AND 180 AND p.coordinate_system='GCJ02') IS TRUE AS "hasLocation",
        null::float8 AS "distanceMeters",coalesce(vr.rating,'NONE') AS "myRating",${score} AS "preferenceScore",
        to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt",
        (SELECT coalesce(f.data#>>'{facts,place,name}',f.data#>>'{facts,place,city}',f.data#>>'{facts,place,province}')
          FROM life_object_facets f WHERE f.user_id=o.user_id AND f.life_object_id=o.id AND f.deleted_at IS NULL
            AND f.data#>>'{facts,origin}'='USER_STATED'
          ORDER BY f.confidence DESC,f.created_at DESC,f.id DESC LIMIT 1) AS "placeLabel"
      FROM life_objects o LEFT JOIN life_object_projection p ON p.life_object_id=o.id AND p.user_id=o.user_id
      ${preferenceJoins()} WHERE ${sql.join(filters, sql` AND `)}
    ), pages AS (
      SELECT *,row_number() OVER(PARTITION BY kind ORDER BY "preferenceScore" DESC,coalesce(importance,0.5) DESC,"createdAt" DESC,id DESC) AS ordinal
      FROM ranked ${pageFilter}
    ) SELECT * FROM pages WHERE ordinal<=${limit + 1}
      ORDER BY kind,"preferenceScore" DESC,coalesce(importance,0.5) DESC,"createdAt" DESC,id DESC`);
    return result.rows as unknown as DeckRow[];
  }
  private page(rows: DeckRow[], kind: z.infer<typeof facetTypeSchema>, asOf: Date, limit: number) {
    const selected = rows.slice(0, limit),
      last = selected.at(-1);
    return {
      items: selected.map(({ cursorCreatedAt: _cursor, ordinal: _ordinal, ...row }) => ({
        ...row,
        createdAt: new Date(row.createdAt).toISOString(),
        nextAt: row.nextAt ? new Date(row.nextAt).toISOString() : null,
        expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
      })),
      asOf: asOf.toISOString(),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                version: preferenceOrderingVersion,
                kind,
                asOf: asOf.toISOString(),
                score: last.preferenceScore,
                importance: last.importance ?? 0.5,
                createdAt: last.cursorCreatedAt,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  }
  async deck(userId: string, input: LifeDeckRequest) {
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (input.cursor) {
      try {
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()));
        if (cursor.kind !== input.kind) throw new Error("KIND_MISMATCH");
        const age = Date.now() - new Date(cursor.asOf).getTime();
        if (age < -1000 || age > 86400000) throw new Error("CURSOR_EXPIRED");
      } catch {
        throw new BadRequestException({ code: "INVALID_LIFE_DECK_CURSOR" });
      }
    }
    const asOf = cursor ? new Date(cursor.asOf) : new Date();
    return this.page(
      await this.rows(userId, asOf, input.kind, cursor, input.limit),
      input.kind,
      asOf,
      input.limit,
    );
  }
  async stacks(userId: string) {
    const asOf = new Date(),
      rows = await this.rows(userId, asOf);
    return facetTypeSchema.options.flatMap((kind) => {
      const group = rows.filter((row) => row.kind === kind);
      return group.length
        ? [{ kind, title: titles[kind], ...this.page(group, kind, asOf, 10) }]
        : [];
    });
  }
}
