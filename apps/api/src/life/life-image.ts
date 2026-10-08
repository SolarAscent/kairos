import { sql, type SQL } from "drizzle-orm";

export function lifeImageCaptureId(objectId: SQL, userId: SQL) {
  return sql<string | null>`(SELECT c.id FROM life_object_sources s
    JOIN captures c ON c.id=s.source_id AND c.user_id=s.user_id
    WHERE s.life_object_id=${objectId} AND s.user_id=${userId}
      AND s.source_type='CAPTURE' AND c.capture_type='IMAGE' AND c.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM capture_assets a WHERE a.capture_id=c.id AND a.user_id=c.user_id
        AND a.asset_type='IMAGE' AND a.deleted_at IS NULL
        AND (a.retain_until IS NULL OR a.retain_until>now())
        AND a.mime_type IN ('image/jpeg','image/png') AND a.storage_key LIKE ('data:' || a.mime_type || ';base64,%'))
    ORDER BY s.is_primary DESC,s.created_at DESC,s.id DESC LIMIT 1)`;
}
