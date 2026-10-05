import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@life/db";
import { learnedPreference, preferenceWeights, type LearnedPreference } from "@life/domain";
import type { LifeRating } from "@life/contracts";

export type PreferenceDbReader = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
export const preferenceOrderingVersion = "preferences-v1";

/** Immutable votes make an asOf cursor reproducible after a subsequent vote or withdrawal. */
export function preferenceCtes(userId: string, asOf: Date): SQL {
  return sql`
    ratings AS (
      SELECT DISTINCT ON (value->>'lifeObjectId') value->>'lifeObjectId' AS object_id,
        value->>'kind' AS kind, value->>'rating' AS rating
      FROM preference_signals WHERE user_id=${userId}::uuid AND dimension='life_object'
        AND source_type='LIFE_RATING' AND occurred_at<=${asOf.toISOString()}::timestamptz
      ORDER BY value->>'lifeObjectId',occurred_at DESC,id DESC
    ),
    visible_ratings AS (
      SELECT r.* FROM ratings r JOIN life_objects o ON o.id::text=r.object_id
      WHERE o.user_id=${userId}::uuid AND o.created_at<=${asOf.toISOString()}::timestamptz
        AND (o.deleted_at IS NULL OR o.deleted_at>${asOf.toISOString()}::timestamptz)
    ),
    category_ratings AS (
      SELECT kind, sum(CASE rating WHEN 'LIKE' THEN 1 WHEN 'DISLIKE' THEN -1 ELSE 0 END)::float8 /
        (count(*) FILTER (WHERE rating<>'NONE')+3) AS affinity
      FROM visible_ratings WHERE rating IN ('LIKE','DISLIKE') GROUP BY kind
    ),
    episodes AS (
      SELECT DISTINCT ON (f.recommendation_id) c.target_life_object_id AS object_id,o.kind,
        CASE WHEN f.event_type='REJECT' THEN -0.2 ELSE
          CASE WHEN f.event_type='COMPLETE' THEN 0.52 ELSE 0.325 END END *
          power(0.5,greatest(0,extract(epoch from (${asOf.toISOString()}::timestamptz-f.created_at))/86400)/90) AS affinity
      FROM feedback_events f
      JOIN recommendations r ON r.id=f.recommendation_id AND r.user_id=f.user_id
      JOIN action_candidates c ON c.id=r.action_candidate_id AND c.user_id=f.user_id
      JOIN life_objects o ON o.id=c.target_life_object_id AND o.user_id=f.user_id
      WHERE f.user_id=${userId}::uuid AND f.created_at<=${asOf.toISOString()}::timestamptz
        AND f.created_at>=${asOf.toISOString()}::timestamptz-interval '365 days'
        AND (o.deleted_at IS NULL OR o.deleted_at>${asOf.toISOString()}::timestamptz)
        AND (f.event_type IN ('ACCEPT','EXECUTE','COMPLETE') OR
          (f.event_type='REJECT' AND f.reason_code IN ('NOT_INTERESTED','DISLIKE')))
      ORDER BY f.recommendation_id,
        CASE WHEN f.event_type='REJECT' THEN 3 WHEN f.event_type='COMPLETE' THEN 2 ELSE 1 END DESC,
        f.created_at DESC,f.id DESC
    ),
    object_behavior AS (SELECT object_id,avg(affinity)::float8 AS affinity FROM episodes GROUP BY object_id),
    category_behavior AS (SELECT kind,avg(affinity)::float8 AS affinity FROM episodes GROUP BY kind)
  `;
}

export function preferenceScoreSql(): SQL<number> {
  return sql<number>`(
    CASE vr.rating WHEN 'LIKE' THEN ${preferenceWeights.direct}::float8 WHEN 'DISLIKE' THEN ${-preferenceWeights.direct}::float8 ELSE 0::float8 END
    + coalesce(cr.affinity,0)*${preferenceWeights.category}
    + coalesce(ob.affinity,0)*${preferenceWeights.behavior}
    + coalesce(cb.affinity,0)*${preferenceWeights.behaviorCategory}
  )::float8`;
}
export function preferenceJoins(): SQL {
  return sql`LEFT JOIN visible_ratings vr ON vr.object_id=o.id::text
    LEFT JOIN category_ratings cr ON cr.kind=o.kind::text
    LEFT JOIN object_behavior ob ON ob.object_id=o.id
    LEFT JOIN category_behavior cb ON cb.kind=o.kind`;
}

export class PreferenceReader {
  constructor(private readonly db: PreferenceDbReader) {}
  async read(
    userId: string,
    candidates: Array<{ id: string; kind: string }>,
    asOf = new Date(),
    reader: PreferenceDbReader = this.db,
  ): Promise<Map<string, LearnedPreference>> {
    const result = new Map<string, LearnedPreference>();
    if (!candidates.length) return result;
    const ids = candidates.map((item) => sql`${item.id}::uuid`);
    const rows = await reader.execute(sql`WITH ${preferenceCtes(userId, asOf)}
      SELECT o.id,coalesce(vr.rating,'NONE') AS rating,coalesce(cr.affinity,0)::float8 AS category,
        coalesce(ob.affinity,0)::float8 AS behavior,coalesce(cb.affinity,0)::float8 AS behavior_category
      FROM life_objects o ${preferenceJoins()}
      WHERE o.user_id=${userId}::uuid AND o.id IN (${sql.join(ids, sql`,`)}) AND o.deleted_at IS NULL`);
    for (const row of rows.rows) {
      result.set(
        String(row.id),
        learnedPreference(
          row.rating as LifeRating,
          Number(row.category),
          Number(row.behavior),
          Number(row.behavior_category),
        ),
      );
    }
    return result;
  }
}
