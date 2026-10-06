import { sql } from "drizzle-orm";
import type { PreferenceDbReader } from "./preference-reader.js";

export type TransportPreference = {
  preferScenicBus: boolean;
  source: "EXPLICIT" | "LEARNED" | null;
};

const scenic =
  "(?:(?:看|欣赏)?(?:沿途|窗外|自然|路上)?(?:的)?(?:风景|景色)|看日落|看夕阳|看海|看江景|看山景|看湖景|赏景)";
const liking = "(?:喜欢|倾向|偏爱)";
const prefix =
  "^(?:我)?(?:现在|目前|其实|更|很|比较|一直|平时|通常|还是|已经|不再|并不|不|从不|不太|不怎么|不想|不愿意|再也不|最)*";
const affirmativePrefix = "^(?:我)?(?:现在|目前|其实|更|很|比较|一直|平时|通常|还是|已经|最)*";
const scenicSuffix = "(?!的人|的人们|的话题|的文章|的电影|的照片)";
const negativeScenic = new RegExp(
  `${prefix}(?:不再|并不|不|从不|不太|不怎么|再也不)${liking}.{0,12}${scenic}${scenicSuffix}`,
  "u",
);
const scenicActivity =
  "(?:(?:坐|乘坐|乘)(?:公交(?:车)?|巴士)(?:时|上|的时候)?|出去|出门|慢慢|沿途|在路上|散步时|旅行时|旅途中|顺便)*";
const positiveScenic = new RegExp(
  `${affirmativePrefix}${liking}${scenicActivity}${scenic}${scenicSuffix}`,
  "u",
);
const negativeBus = new RegExp(
  `${prefix}(?:(?:不再|并不|不|从不|不太|不怎么|再也不)${liking}(?:坐|乘坐|乘)?(?:公交|巴士)|(?:不坐|不乘|不想坐|不愿意坐|不再坐)(?:公交|巴士))`,
  "u",
);
const preferredAlternative = new RegExp(
  `${affirmativePrefix}${liking}(?:坐|乘坐|乘)?(?:地铁|骑行|骑车)`,
  "u",
);
const withdrawal =
  /^(?:我)?(?:撤回|取消|删除|忘掉).{0,16}(?:风景|公交).{0,8}(?:偏好|喜好|倾向|喜爱)/u;

/** Deliberately narrow first-person grammar: destination wishes and quoted opinions are not preferences. */
function explicitOpinion(text: string): boolean | null {
  const clauses = text
    .normalize("NFKC")
    .split(/[，。！？；,;.!?\n]/u)
    .map((value) => value.trim());
  let positive = false;
  let reported = false;
  for (const original of clauses) {
    const clause = original.replace(/^(?:但是|不过|而且|因为|所以|以后|现在|但|而|也)+/u, "");
    if (/^(?:朋友|别人|他|她|文章|书里|例如|比如|假如|如果)/u.test(clause)) reported = true;
    if (/^我/u.test(clause)) reported = false;
    if (reported) continue;
    if (
      negativeScenic.test(clause) ||
      negativeBus.test(clause) ||
      preferredAlternative.test(clause) ||
      withdrawal.test(clause)
    )
      return false;
    // Negation anywhere in this clause makes an otherwise ambiguous positive unsafe.
    if (!/(?:不|没|无|别|不要|撤回|取消)/u.test(clause) && positiveScenic.test(clause))
      positive = true;
  }
  return positive ? true : null;
}

/** A user-authored sightseeing action, never PLACE/category affinity or media about scenery. */
function isScenicAction(evidence: string): boolean {
  if (
    /(?:不|没|无|别|不要|撤回|取消|不再|朋友|他|她|别人|视频|电影|照片|图片|纪录片|小说|文章|讨论|研究|[《》“”"])/u.test(
      evidence,
    )
  )
    return false;
  return /(?:看|欣赏|观赏|赏|观).{0,16}(?:风景|日落|夕阳|海|江景|山景|湖景|景色)/u.test(evidence);
}

const evidenceWindow = 2000;

export class TransportPreferenceReader {
  constructor(private readonly db: PreferenceDbReader) {}

  async read(userId: string, decisionTime = new Date()): Promise<TransportPreference> {
    const at = decisionTime.toISOString();
    const result = await this.db.execute(sql`
      WITH latest_ratings AS (
        SELECT DISTINCT ON (value->>'lifeObjectId') value->>'lifeObjectId' AS object_id,
          CASE WHEN expires_at IS NOT NULL AND expires_at<=${at}::timestamptz THEN 'EXPIRED'
            ELSE value->>'rating' END AS rating,occurred_at AS rated_at
        FROM preference_signals
        WHERE user_id=${userId}::uuid AND dimension='life_object' AND source_type='LIFE_RATING'
          AND occurred_at<=${at}::timestamptz
        ORDER BY value->>'lifeObjectId',occurred_at DESC,id DESC
      ), latest_behavior AS (
        SELECT DISTINCT ON (a.target_life_object_id) a.target_life_object_id AS object_id,
          f.event_type,f.created_at AS acted_at
        FROM feedback_events f
        JOIN recommendations r ON r.id=f.recommendation_id AND r.user_id=f.user_id
          AND r.decision_session_id=f.decision_session_id
        JOIN action_candidates a ON a.id=r.action_candidate_id AND a.user_id=f.user_id
          AND a.decision_session_id=f.decision_session_id
        WHERE f.user_id=${userId}::uuid AND f.created_at<=${at}::timestamptz
          AND f.created_at>=${at}::timestamptz-interval '365 days'
          AND coalesce(a.action_payload->>'actionMode',r.execution_payload->'plan'->>'mode')='DO'
          AND (f.event_type='COMPLETE' OR
            (f.event_type='REJECT' AND f.reason_code IN ('NOT_INTERESTED','DISLIKE')))
        ORDER BY a.target_life_object_id,f.created_at DESC,f.id DESC
      )
      SELECT o.id AS object_id,o.kind,c.id AS capture_id,c.text_content,c.created_at AS stated_at,
        coalesce(f.data->'facts'->>'evidence',f.data->>'description') AS evidence,
        f.data->'facts'->>'activityKind' AS activity_kind,
        lr.rating,lr.rated_at,lb.event_type,lb.acted_at
      FROM life_objects o
      JOIN life_object_facets f ON f.life_object_id=o.id AND f.user_id=o.user_id
      JOIN life_object_sources s ON s.life_object_id=o.id AND s.user_id=o.user_id AND s.source_type='CAPTURE'
      JOIN captures c ON c.id=s.source_id AND c.user_id=s.user_id
        AND (f.origin_id IS NULL OR f.origin_id=c.id)
      LEFT JOIN latest_ratings lr ON lr.object_id=o.id::text
      LEFT JOIN latest_behavior lb ON lb.object_id=o.id
      WHERE o.user_id=${userId}::uuid AND o.status IN ('ACTIVE','RESOLVED')
        AND o.created_at<=${at}::timestamptz AND o.deleted_at IS NULL
        AND f.origin_type IN ('USER_STATED','EXTRACTED') AND f.confidence>=0.8 AND s.confidence>=0.8
        AND coalesce(f.data->'facts'->>'origin','USER_STATED')='USER_STATED'
        AND f.created_at<=${at}::timestamptz AND f.deleted_at IS NULL
        AND (f.valid_from IS NULL OR f.valid_from<=${at}::timestamptz)
        AND (f.valid_until IS NULL OR f.valid_until>${at}::timestamptz)
        AND s.created_at<=${at}::timestamptz AND c.created_at<=${at}::timestamptz
        AND c.deleted_at IS NULL AND c.status='READY' AND c.capture_type IN ('TEXT','VOICE')
        AND c.text_content ~ '(风景|景色|日落|夕阳|看海|江景|山景|湖景|公交|巴士|地铁|骑行|骑车)'
      ORDER BY c.created_at DESC,c.id DESC,f.id DESC
      LIMIT ${evidenceWindow}
    `);

    const rows = result.rows.filter((row) => {
      const text = row.text_content,
        evidence = row.evidence;
      return (
        typeof text === "string" &&
        typeof evidence === "string" &&
        evidence.trim().length > 0 &&
        text.normalize("NFKC").includes(evidence.normalize("NFKC"))
      );
    });
    const seenCaptures = new Set<string>();
    for (const row of rows) {
      const id = String(row.capture_id);
      if (seenCaptures.has(id)) continue;
      seenCaptures.add(id);
      const opinion = explicitOpinion(String(row.text_content));
      if (opinion !== null) return { preferScenicBus: opinion, source: "EXPLICIT" };
    }

    // If the bounded window is full, omitted older negative evidence could change the net vote.
    // Explicit statements remain usable above; learning requires the complete relevant window.
    if (result.rows.length >= evidenceWindow) return { preferScenicBus: false, source: null };
    // A single positive, repeated clicks/facets/objects from one capture, and broad PLACE likes never suffice.
    const objects = new Map<string, { sign: number; captureId: string }>();
    for (const row of rows) {
      if (
        !isScenicAction(String(row.evidence)) ||
        row.kind === "MEDIA" ||
        ["REMOTE", "HOME"].includes(String(row.activity_kind))
      )
        continue;
      const rating = row.rating == null ? null : String(row.rating);
      const sign =
        rating === "LIKE"
          ? 1
          : rating === "DISLIKE"
            ? -1
            : rating === "NONE" || rating === "EXPIRED"
              ? 0
              : row.event_type === "COMPLETE"
                ? 1
                : row.event_type === "REJECT"
                  ? -1
                  : 0;
      // Latest NONE/EXPIRED blocks older votes and completions for this object alone.
      if (!sign) continue;
      const objectId = String(row.object_id);
      if (!objects.has(objectId))
        objects.set(objectId, { sign, captureId: String(row.capture_id) });
    }
    const captures = new Map<string, number>();
    for (const vote of objects.values()) {
      // One input split into several objects supplies at most one vote; negative interest wins a conflict.
      captures.set(vote.captureId, Math.min(captures.get(vote.captureId) ?? vote.sign, vote.sign));
    }
    const votes = [...captures.values()];
    const positive = votes.filter((vote) => vote > 0);
    const negative = votes.filter((vote) => vote < 0);
    const learned = positive.length >= 2 && positive.length - negative.length >= 2;
    return { preferScenicBus: learned, source: learned ? "LEARNED" : null };
  }
}
