import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { v7 as uuidv7 } from "uuid";
import type { PoolClient } from "pg";
import type { ModelGateway, ModelCaptureInput } from "@life/agent-core";
import {
  captureParseResultSchema,
  uuidSchema,
  structuredLifeFactsSchema,
  type ParsedLifeObject,
} from "@life/contracts";
import { buildLifeProjection } from "@life/domain";
import { verifiedDestinationForObject, userSelectedDestinationForObject } from "@life/integrations";
import { z } from "zod";

type Event = { id: string; payload: unknown; created_at: Date };
type Fence = <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T | undefined>;
const payloadSchema = z.object({
  lifeObjectId: uuidSchema,
  userId: uuidSchema,
  traceId: uuidSchema.optional(),
});
type Row = {
  id: string;
  title: string;
  summary: string | null;
  kind: ParsedLifeObject["kind"];
  importance_score: number | null;
  object_version: number;
  revision: string;
  created_at: Date;
  deleted_at: Date | null;
  status: string;
};
type FacetRow = {
  id: string;
  facet_type: ParsedLifeObject["kind"];
  facet_key: string;
  data: Record<string, unknown>;
  confidence: number;
  origin_type: string;
};

/** Add facts to an existing object; never replace its title, source, or user facts. */
export async function rebuildLifeFacts(
  event: Event,
  gateway: ModelGateway,
  fence: Fence,
  finish: (client: PoolClient) => Promise<void>,
) {
  const payload = payloadSchema.parse(event.payload);
  const snapshot = await fence(async (client) => {
    const {
      rows: [object],
    } = await client.query<Row>(
      "SELECT *,xmin::text AS revision FROM life_objects WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [payload.lifeObjectId, payload.userId],
    );
    if (!object || object.deleted_at || object.status === "DELETED") {
      await finish(client);
      return undefined;
    }
    const facets = (
      await client.query<FacetRow>(
        "SELECT id,facet_type,facet_key,data,confidence,origin_type FROM life_object_facets WHERE life_object_id=$1 AND user_id=$2 AND deleted_at IS NULL ORDER BY created_at,id",
        [object.id, payload.userId],
      )
    ).rows;
    const {
      rows: [source],
    } = await client.query<{
      capture_id: string;
      created_at: Date;
      timezone: string;
      capture_type: string;
      text_content: string | null;
    }>(
      `SELECT c.id AS capture_id,c.created_at,u.timezone,c.capture_type,c.text_content FROM life_object_sources src
      JOIN captures c ON c.id=src.source_id AND c.user_id=src.user_id JOIN users u ON u.id=src.user_id
      WHERE src.life_object_id=$1 AND src.user_id=$2 AND src.source_type='CAPTURE' AND src.is_primary=true
        AND c.deleted_at IS NULL ORDER BY src.created_at,src.id LIMIT 1`,
      [object.id, payload.userId],
    );
    const sourceObjectCount = source
      ? (
          await client.query<{ count: number }>(
            `SELECT count(DISTINCT lo.id)::int AS count FROM life_object_sources s
      JOIN life_objects lo ON lo.id=s.life_object_id AND lo.user_id=s.user_id
      WHERE s.user_id=$1 AND s.source_type='CAPTURE' AND s.source_id=$2
        AND lo.deleted_at IS NULL AND lo.status<>'DELETED'`,
            [payload.userId, source.capture_id],
          )
        ).rows[0]!.count
      : 0;
    const timezone =
      source?.timezone ??
      (
        await client.query<{ timezone: string }>("SELECT timezone FROM users WHERE id=$1", [
          payload.userId,
        ])
      ).rows[0]!.timezone;
    return {
      object,
      facets,
      sourceId: source?.capture_id ?? null,
      originalCaptureText:
        sourceObjectCount === 1 && source?.capture_type !== "IMAGE"
          ? (source?.text_content ?? undefined)
          : undefined,
      context: {
        referenceTime: (source?.created_at ?? object.created_at).toISOString(),
        timezone,
        ...(source?.capture_type !== "IMAGE" && source?.text_content
          ? { sourceText: source.text_content }
          : {}),
      },
    };
  });
  if (!snapshot) return;
  const input: ModelCaptureInput = {
    text: JSON.stringify({
      title: snapshot.object.title,
      summary: snapshot.object.summary,
      kind: snapshot.object.kind,
      descriptions: snapshot.facets.map((facet) => facet.data.description).filter(Boolean),
    }),
    ...snapshot.context,
    factsOnly: true,
    ...(snapshot.originalCaptureText ? { originalCaptureText: snapshot.originalCaptureText } : {}),
  };
  const startedAt = new Date(),
    monotonic = performance.now();
  let result: ReturnType<typeof captureParseResultSchema.parse>;
  try {
    result = captureParseResultSchema.parse(await gateway.parseCapture(input));
  } catch (error) {
    await fence((client) => auditModel(client, null, "MODEL_PARSE_FAILED"));
    throw error;
  }
  const modelLatencyMs = Math.round(performance.now() - monotonic);
  const matched = result.objects.length === 1 && result.objects[0]!.title === snapshot.object.title;
  await fence(async (client) => {
    const {
      rows: [current],
    } = await client.query<Row>(
      "SELECT *,xmin::text AS revision FROM life_objects WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [payload.lifeObjectId, payload.userId],
    );
    if (
      !current ||
      current.deleted_at ||
      current.status === "DELETED" ||
      current.object_version !== snapshot.object.object_version ||
      current.revision !== snapshot.object.revision
    ) {
      await auditModel(client, result, "OBJECT_CHANGED");
      await finish(client);
      return;
    }
    if (!matched) {
      await auditModel(client, result, "FACTS_BINDING_UNCLEAR");
      await finish(client);
      return;
    }
    const candidate = result.objects[0]!;
    const projection = buildLifeProjection(candidate, snapshot.context);
    const currentFacets = (
      await client.query<FacetRow>(
        "SELECT id,facet_type,facet_key,data,confidence,origin_type FROM life_object_facets WHERE life_object_id=$1 AND user_id=$2 AND deleted_at IS NULL ORDER BY created_at,id",
        [current.id, payload.userId],
      )
    ).rows;
    let changed = false;
    for (const facet of projection.facets) {
      if (!facet.data.facts || facet.confidence < 0.7) continue;
      const existing = currentFacets.find(
        (row) => row.facet_type === facet.type && row.facet_key === facet.key,
      );
      if (existing?.data.facts !== undefined) continue; // User facts and previous enrichment are immutable here.
      const data = existing
        ? { ...existing.data, facts: facet.data.facts, normalization: facet.data.normalization }
        : facet.data;
      if (existing) {
        await client.query(
          "UPDATE life_object_facets SET data=$1::jsonb,schema_version=3,origin_type=$4,updated_at=now() WHERE id=$2 AND user_id=$3",
          [JSON.stringify(data), existing.id, payload.userId, facet.data.facts.origin],
        );
        existing.data = data;
      } else {
        const id = uuidv7();
        await client.query(
          `INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,schema_version,data,confidence,origin_type,origin_id)
          VALUES($1,$2,$3,$4,$5,3,$6::jsonb,$7,$8,$9)`,
          [
            id,
            payload.userId,
            current.id,
            facet.type,
            facet.key,
            JSON.stringify(data),
            facet.confidence,
            facet.data.facts.origin === "USER_STATED" ? "USER_STATED" : "INFERRED",
            snapshot.sourceId,
          ],
        );
        currentFacets.push({
          id,
          facet_type: facet.type,
          facet_key: facet.key,
          data,
          confidence: facet.confidence,
          origin_type: facet.data.facts.origin,
        });
      }
      changed = true;
    }
    if (changed) {
      const facets: ParsedLifeObject["facets"] = currentFacets.map((row) => ({
        type: row.facet_type,
        key: row.facet_key,
        confidence: row.confidence,
        source: "EXTRACTED",
        data: {
          ...row.data,
          intent: typeof row.data.intent === "string" ? row.data.intent : null,
          description: typeof row.data.description === "string" ? row.data.description : null,
          verification: "UNVERIFIED",
          facts: structuredLifeFactsSchema.safeParse(row.data.facts).success
            ? structuredLifeFactsSchema.parse(row.data.facts)
            : undefined,
        },
      }));
      const merged = buildLifeProjection(
        {
          title: current.title,
          summary: current.summary,
          kind: current.kind,
          importance: current.importance_score ?? 0.5,
          facets,
        },
        snapshot.context,
      );
      const selected = userSelectedDestinationForObject(
        current,
        currentFacets.map((row) => ({
          facetType: row.facet_type,
          facetKey: row.facet_key,
          originType: row.origin_type,
          data: row.data,
        })),
      );
      const verified =
        selected?.location ??
        verifiedDestinationForObject(
          current,
          currentFacets.map((row) => ({
            facetType: row.facet_type,
            facetKey: row.facet_key,
            originType: row.origin_type,
            data: row.data,
          })),
        );
      if (verified && merged.latitude == null) Object.assign(merged, verified);
      await client.query(
        `INSERT INTO life_object_projection(life_object_id,user_id,display_kind,importance_score,search_text,projection_version,next_at,expires_at,cost_min_minor,cost_max_minor,currency,duration_min_seconds,duration_max_seconds,latitude,longitude,coordinate_system)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT(life_object_id) DO UPDATE SET search_text=EXCLUDED.search_text,projection_version=EXCLUDED.projection_version,
          next_at=EXCLUDED.next_at,expires_at=EXCLUDED.expires_at,cost_min_minor=EXCLUDED.cost_min_minor,cost_max_minor=EXCLUDED.cost_max_minor,currency=EXCLUDED.currency,
          duration_min_seconds=EXCLUDED.duration_min_seconds,duration_max_seconds=EXCLUDED.duration_max_seconds,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,coordinate_system=EXCLUDED.coordinate_system,rebuilt_at=now()`,
        [
          current.id,
          payload.userId,
          current.kind,
          current.importance_score,
          merged.searchText,
          merged.projectionVersion,
          merged.nextAt,
          merged.expiresAt,
          merged.costMinMinor,
          merged.costMaxMinor,
          merged.currency,
          merged.durationMinSeconds,
          merged.durationMaxSeconds,
          merged.latitude,
          merged.longitude,
          merged.coordinateSystem,
        ],
      );
      await client.query(
        "UPDATE life_objects SET object_version=object_version+1,updated_at=now() WHERE id=$1 AND user_id=$2",
        [current.id, payload.userId],
      );
    }
    await auditModel(client, result, changed ? null : "NO_ADDITIVE_FACTS");
    await client.query(
      `INSERT INTO audit_events(id,actor_type,action,target_type,target_id,metadata,trace_id) VALUES($1,'WORKER','LIFE_FACTS_REBUILT','LIFE_OBJECT',$2,$3::jsonb,$4)`,
      [
        uuidv7(),
        current.id,
        JSON.stringify({ changed, objectVersion: current.object_version }),
        payload.traceId ?? event.id,
      ],
    );
    await finish(client);
  });
  async function auditModel(client: PoolClient, output: unknown, errorCode: string | null) {
    const runId = uuidv7(),
      latency = output ? modelLatencyMs : Math.round(performance.now() - monotonic);
    await client.query(
      `INSERT INTO agent_runs(id,user_id,purpose,entity_type,entity_id,pipeline_version,status,trace_id,started_at,completed_at,error_code,result)
      VALUES($1,$2,'LIFE_FACTS_REBUILD','LIFE_OBJECT',$3,'life-facts-v0.4',$4,$5,$6,now(),$7,$8::jsonb)`,
      [
        runId,
        payload.userId,
        payload.lifeObjectId,
        output ? "SUCCEEDED" : "FAILED",
        payload.traceId ?? event.id,
        startedAt,
        errorCode,
        JSON.stringify({
          modelLatencyMs: latency,
          queueWaitMs: Math.max(0, startedAt.getTime() - event.created_at.getTime()),
        }),
      ],
    );
    await client.query(
      `INSERT INTO model_calls(id,agent_run_id,provider,model,prompt_name,prompt_version,schema_version,input_hash,status,structured_output,latency_ms,error_code)
      VALUES($1,$2,$3,$4,'life.facts','0.4','0.3',$5,$6,$7::jsonb,$8,$9)`,
      [
        uuidv7(),
        runId,
        gateway.providerName,
        gateway.modelForInput?.(input) ?? gateway.modelName,
        createHash("sha256").update(JSON.stringify(input)).digest("hex"),
        output ? "SUCCEEDED" : "FAILED",
        output ? JSON.stringify(output) : null,
        latency,
        errorCode,
      ],
    );
  }
}
