import { rebuildLifeFacts } from "./life-facts-rebuild.js";
import { enrichPlaceLocation, enqueuePlaceLocationEnrichment } from "./life-location-enrich.js";
import { TencentLbsAdapter, type LocationProvider } from "@life/integrations";
import { performance } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Pool, PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import type { ModelGateway, ModelCaptureInput } from "@life/agent-core";
import { captureParseResultSchema, uuidSchema, type CaptureParseResult } from "@life/contracts";
import { derivePreferenceSignal, buildLifeProjection } from "@life/domain";
import { z } from "zod";

const captureEventSchema = z.object({
  captureId: uuidSchema,
  userId: uuidSchema,
  traceId: uuidSchema.optional(),
});
const feedbackEventSchema = z.object({
  feedbackId: uuidSchema,
  userId: uuidSchema,
  candidateId: uuidSchema,
  traceId: uuidSchema.optional(),
});
type ClaimedEvent = {
  id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  created_at: Date;
};
type Capture = {
  capture_type?: string;
  text_content: string | null;
  status: string;
  deleted_at: Date | null;
  created_at?: Date;
  timezone?: string;
};

export class OutboxWorker {
  readonly workerId = `${hostname()}:${randomUUID()}`;

  constructor(
    private readonly pool: Pool,
    private readonly gateway: ModelGateway,
    private readonly locations: LocationProvider = TencentLbsAdapter.fromEnvironment(),
  ) {}

  async processNext(allowFactsRebuild = true): Promise<boolean> {
    const {
      rows: [event],
    } = await this.pool.query<ClaimedEvent>(
      `
      WITH candidate AS (
        SELECT queued.id FROM outbox_events queued
        WHERE ((queued.status IN ('PENDING', 'RETRY') AND queued.available_at <= now())
           OR (queued.status = 'PROCESSING' AND queued.locked_at < now() - interval '2 minutes'))
          AND ($2::boolean OR queued.event_type NOT IN ('LIFE_FACTS_REBUILD','PLACE_LOCATION_ENRICH'))
          AND (queued.event_type<>'CAPTURE_CREATED' OR NOT EXISTS (
            SELECT 1 FROM outbox_events active
            WHERE active.aggregate_type=queued.aggregate_type AND active.aggregate_id=queued.aggregate_id
              AND active.id<>queued.id AND active.status='PROCESSING'
              AND active.locked_at>now()-interval '2 minutes'
          ))
        ORDER BY CASE WHEN queued.event_type IN ('LIFE_FACTS_REBUILD','PLACE_LOCATION_ENRICH') THEN 1 ELSE 0 END,queued.created_at,queued.id FOR UPDATE OF queued SKIP LOCKED LIMIT 1
      ) UPDATE outbox_events AS event
        SET status = 'PROCESSING', locked_at = now(), locked_by = $1, attempts = event.attempts + 1
        FROM candidate WHERE event.id = candidate.id
        RETURNING event.id, event.event_type, event.payload, event.attempts, event.created_at`,
      [this.workerId, allowFactsRebuild],
    );
    if (!event) return false;
    try {
      if (event.event_type === "CAPTURE_CREATED") await this.processCapture(event);
      else if (event.event_type === "LIFE_FACTS_REBUILD")
        await rebuildLifeFacts(
          event,
          this.gateway,
          (operation) => this.withEvent(event, operation),
          (client) => this.finish(client, event.id),
        );
      else if (event.event_type === "FEEDBACK_RECORDED") await this.processFeedback(event);
      else if (event.event_type === "PLACE_LOCATION_ENRICH")
        await enrichPlaceLocation(
          event,
          this.locations,
          (operation) => this.withEvent(event, operation),
          (client) => this.finish(client, event.id),
        );
      else throw new Error("UNKNOWN_EVENT_TYPE");
    } catch (error) {
      await this.failEvent(
        event,
        error instanceof Error &&
          ["MODEL_CONFIGURATION_MISSING", "MODEL_IMAGE_UNSUPPORTED"].includes(error.message),
      );
      console.error(
        JSON.stringify({
          level: "error",
          worker_id: this.workerId,
          event_id: event.id,
          code: "OUTBOX_JOB_FAILED",
          attempts: event.attempts,
        }),
      );
    }
    return true;
  }

  // A reclaimed lease may finish elsewhere. Fence every write by owner AND attempt.
  private async withEvent<T>(
    event: ClaimedEvent,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owned = await client.query(
        `SELECT id FROM outbox_events
        WHERE id=$1 AND status='PROCESSING' AND locked_by=$2 AND attempts=$3 FOR UPDATE`,
        [event.id, this.workerId, event.attempts],
      );
      const result = owned.rowCount ? await operation(client) : undefined;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async finish(client: PoolClient, eventId: string) {
    await client.query(
      `UPDATE outbox_events SET status='DONE', locked_at=NULL, locked_by=NULL,
      last_error=NULL, processed_at=now() WHERE id=$1`,
      [eventId],
    );
  }

  private async processCapture(event: ClaimedEvent) {
    const payload = captureEventSchema.parse(event.payload);
    const input = await this.withEvent(
      event,
      async (client): Promise<ModelCaptureInput | undefined> => {
        const {
          rows: [capture],
        } = await client.query<Capture>(
          "SELECT c.capture_type,c.text_content,c.status,c.deleted_at,c.created_at,u.timezone FROM captures c JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.user_id=$2 FOR UPDATE OF c",
          [payload.captureId, payload.userId],
        );
        if (
          !capture ||
          capture.deleted_at ||
          ["DELETED", "READY", "NEEDS_REVIEW"].includes(capture.status)
        ) {
          await this.finish(client, event.id);
          return undefined;
        }
        if (capture.status === "PROCESSING") {
          // The capture row lock serializes this check with another claimant.
          // Defer a duplicate while a fresh sibling lease is parsing the same input.
          const other = await client.query(
            `SELECT id FROM outbox_events WHERE aggregate_type='CAPTURE' AND aggregate_id=$1
              AND id<>$2 AND status='PROCESSING' AND locked_at>now()-interval '2 minutes' LIMIT 1`,
            [payload.captureId, event.id],
          );
          if (other.rowCount) {
            await client.query(
              `UPDATE outbox_events SET status='RETRY',available_at=now()+interval '250 milliseconds',
                locked_at=NULL,locked_by=NULL WHERE id=$1`,
              [event.id],
            );
            return undefined;
          }
        }
        let image: ModelCaptureInput["image"];
        if (capture.capture_type === "IMAGE") {
          const {
            rows: [asset],
          } = await client.query<{ storage_key: string; mime_type: string }>(
            "SELECT storage_key,mime_type FROM capture_assets WHERE capture_id=$1 AND user_id=$2 AND asset_type='IMAGE' AND deleted_at IS NULL LIMIT 1",
            [payload.captureId, payload.userId],
          );
          const match = asset?.storage_key.match(
            /^data:(image\/jpeg|image\/png);base64,([A-Za-z0-9+/=]+)$/,
          );
          if (!match || asset!.storage_key.length > 3 * 1024 * 1024)
            throw new Error("CAPTURE_IMAGE_INVALID");
          image = { mimeType: match[1] as "image/jpeg" | "image/png", base64: match[2]! };
        } else if (!capture.text_content) throw new Error("CAPTURE_TEXT_EMPTY");
        await client.query(
          "UPDATE captures SET status='PROCESSING',updated_at=now() WHERE id=$1 AND user_id=$2",
          [payload.captureId, payload.userId],
        );
        return {
          text: capture.text_content ?? "",
          referenceTime: capture.created_at!.toISOString(),
          timezone: capture.timezone!,
          ...(image ? { image } : {}),
        };
      },
    );
    if (input === undefined) return;
    const startedAt = new Date();
    const modelStarted = performance.now();
    let modelLatencyMs: number;
    let result: CaptureParseResult;
    try {
      result = captureParseResultSchema.parse(await this.gateway.parseCapture(input));
    } catch (error) {
      await this.withEvent(event, (client) =>
        this.recordModelCall(
          client,
          event,
          payload,
          input,
          startedAt,
          null,
          Math.round(performance.now() - modelStarted),
        ),
      );
      throw error;
    }
    modelLatencyMs = Math.round(performance.now() - modelStarted);
    await this.withEvent(event, async (client) => {
      // Re-read after the provider call: deletion or another event may have won.
      const {
        rows: [capture],
      } = await client.query<Capture>(
        "SELECT capture_type,text_content,status,deleted_at FROM captures WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [payload.captureId, payload.userId],
      );
      if (
        !capture ||
        capture.deleted_at ||
        ["DELETED", "READY", "NEEDS_REVIEW"].includes(capture.status)
      ) {
        await this.finish(client, event.id);
        return;
      }
      const objectIds: string[] = [];
      const destinations: Parameters<typeof enqueuePlaceLocationEnrichment>[1] = [];
      for (const object of result.objects) {
        const projection = buildLifeProjection(object, {
          referenceTime: input.referenceTime!,
          timezone: input.timezone!,
          ...(!input.image ? { sourceText: input.text } : {}),
        });
        const objectId = uuidv7();
        objectIds.push(objectId);
        destinations.push({
          id: objectId,
          userId: payload.userId,
          title: object.title,
          kind: object.kind,
          objectVersion: 1,
          facets: projection.facets.map((facet) => ({
            facetType: facet.type,
            facetKey: facet.key,
            originType: facet.data.facts?.origin ?? facet.source,
            data: facet.data,
          })),
        });
        await client.query(
          `INSERT INTO life_objects(id,user_id,title,summary,status,kind,importance_score)
          VALUES($1,$2,$3,$4,'ACTIVE',$5,$6)`,
          [objectId, payload.userId, object.title, object.summary, object.kind, object.importance],
        );
        for (const facet of projection.facets) {
          await client.query(
            `INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,schema_version,data,confidence,origin_type,origin_id)
            VALUES($1,$2,$3,$4,$5,3,$6::jsonb,$7,$8,$9)`,
            [
              uuidv7(),
              payload.userId,
              objectId,
              facet.type,
              facet.key,
              JSON.stringify(facet.data),
              facet.confidence,
              facet.data.facts?.origin ?? facet.source,
              payload.captureId,
            ],
          );
        }
        await client.query(
          `INSERT INTO life_object_sources(id,user_id,life_object_id,source_type,source_id,is_primary,confidence,evidence)
          VALUES($1,$2,$3,'CAPTURE',$4,true,$5,$6::jsonb)`,
          [
            uuidv7(),
            payload.userId,
            objectId,
            payload.captureId,
            object.confidence,
            JSON.stringify({ captureId: payload.captureId, extractedTitle: object.title }),
          ],
        );
        await client.query(
          `INSERT INTO life_object_projection(life_object_id,user_id,display_kind,importance_score,desire_score,search_text,projection_version,
            next_at,expires_at,cost_min_minor,cost_max_minor,currency,duration_min_seconds,duration_max_seconds,latitude,longitude,coordinate_system)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            objectId,
            payload.userId,
            object.kind,
            object.importance,
            object.kind === "DESIRE" ? object.importance : null,
            projection.searchText,
            projection.projectionVersion,
            projection.nextAt,
            projection.expiresAt,
            projection.costMinMinor,
            projection.costMaxMinor,
            projection.currency,
            projection.durationMinSeconds,
            projection.durationMaxSeconds,
            projection.latitude,
            projection.longitude,
            projection.coordinateSystem,
          ],
        );
      }
      await enqueuePlaceLocationEnrichment(
        client,
        destinations,
        this.locations.configured,
        payload.traceId,
      );
      for (const relation of result.relations) {
        await client.query(
          `INSERT INTO life_object_relations(id,user_id,from_object_id,relation_type,to_object_id,confidence,origin_type,origin_id)
          VALUES($1,$2,$3,$4,$5,$6,'EXTRACTED',$7)`,
          [
            uuidv7(),
            payload.userId,
            objectIds[relation.fromIndex],
            relation.type,
            objectIds[relation.toIndex],
            relation.confidence,
            payload.captureId,
          ],
        );
      }
      // Passive capture never executes an action. Missing dates or weak inference
      // remain in the model audit; they do not block an already-saved note.
      await client.query(
        "UPDATE captures SET status=$1,pipeline_version='capture-v0.4',updated_at=now() WHERE id=$2 AND user_id=$3",
        ["READY", payload.captureId, payload.userId],
      );
      await this.recordModelCall(client, event, payload, input, startedAt, result, modelLatencyMs);
      await client.query(
        `INSERT INTO audit_events(id,actor_type,action,target_type,target_id,metadata,trace_id)
        VALUES($1,'WORKER','CAPTURE_PARSED','CAPTURE',$2,$3::jsonb,$4)`,
        [
          uuidv7(),
          payload.captureId,
          JSON.stringify({ workerId: this.workerId, objectIds }),
          payload.traceId ?? event.id,
        ],
      );
      await this.finish(client, event.id);
    });
  }

  private async recordModelCall(
    client: PoolClient,
    event: ClaimedEvent,
    payload: z.infer<typeof captureEventSchema>,
    input: ModelCaptureInput,
    startedAt: Date,
    result: CaptureParseResult | null,
    modelLatencyMs: number,
  ) {
    const runId = uuidv7();
    await client.query(
      `INSERT INTO agent_runs(id,user_id,purpose,entity_type,entity_id,pipeline_version,status,trace_id,started_at,completed_at,error_code,result)
      VALUES($1,$2,'CAPTURE_PARSE','CAPTURE',$3,'capture-v0.4',$4,$5,$6,now(),$7,$8::jsonb)`,
      [
        runId,
        payload.userId,
        payload.captureId,
        result ? "SUCCEEDED" : "FAILED",
        payload.traceId ?? event.id,
        startedAt,
        result ? null : "MODEL_PARSE_FAILED",
        JSON.stringify({
          queueWaitMs: Math.max(0, startedAt.getTime() - event.created_at.getTime()),
          modelLatencyMs,
        }),
      ],
    );
    await client.query(
      `INSERT INTO model_calls(id,agent_run_id,provider,model,prompt_name,prompt_version,schema_version,input_hash,status,structured_output,latency_ms,error_code)
      VALUES($1,$2,$3,$4,'capture.parse','0.4','0.3',$5,$6,$7::jsonb,$8,$9)`,
      [
        uuidv7(),
        runId,
        this.gateway.providerName,
        this.gateway.modelForInput?.(input) ?? this.gateway.modelName,
        createHash("sha256").update(JSON.stringify(input)).digest("hex"),
        result ? "SUCCEEDED" : "FAILED",
        result ? JSON.stringify(result) : null,
        modelLatencyMs,
        result ? null : "MODEL_PARSE_FAILED",
      ],
    );
  }

  private async processFeedback(event: ClaimedEvent) {
    const payload = feedbackEventSchema.parse(event.payload);
    await this.withEvent(event, async (client) => {
      const {
        rows: [feedback],
      } = await client.query<{
        event_type: string;
        reason_code: string | null;
        action_type: string;
        target_life_object_id: string | null;
        action_payload: Record<string, unknown>;
        execution_payload: Record<string, unknown>;
        created_at: Date;
      }>(
        `
        SELECT f.event_type,f.reason_code,f.created_at,c.action_type,c.target_life_object_id,c.action_payload,r.execution_payload FROM feedback_events f
        JOIN recommendations r ON r.id=f.recommendation_id AND r.user_id=f.user_id
        JOIN action_candidates c ON c.id=r.action_candidate_id AND c.user_id=f.user_id
        WHERE f.id=$1 AND f.user_id=$2 AND c.id=$3`,
        [payload.feedbackId, payload.userId, payload.candidateId],
      );
      if (!feedback) throw new Error("FEEDBACK_REFERENCE_INVALID");
      if (
        feedback.target_life_object_id &&
        ["ACCEPT", "EXECUTE", "COMPLETE"].includes(feedback.event_type)
      ) {
        await client.query(
          `UPDATE life_objects SET last_acted_at=GREATEST(COALESCE(last_acted_at,$3),$3),updated_at=now(),
          status=CASE WHEN $4 AND ($5::integer IS NULL OR object_version=$5) AND kind IN ('DESIRE','EVENT','OPEN_LOOP') THEN 'RESOLVED'::life_status ELSE status END
          WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL AND status IN ('ACTIVE','RESOLVED')`,
          [
            feedback.target_life_object_id,
            payload.userId,
            feedback.created_at,
            feedback.event_type === "COMPLETE" &&
              feedback.action_payload.actionMode === "DO" &&
              !String(feedback.action_payload.actionKey).endsWith(":DO:SEGMENT"),
            feedback.execution_payload.targetObjectVersion ?? null,
          ],
        );
        await client.query(
          `UPDATE life_object_projection SET last_used_at=GREATEST(COALESCE(last_used_at,$3),$3)
          WHERE life_object_id=$1 AND user_id=$2`,
          [feedback.target_life_object_id, payload.userId, feedback.created_at],
        );
      }
      const signal = derivePreferenceSignal(
        feedback.event_type,
        feedback.action_type,
        feedback.reason_code ?? undefined,
      );
      if (signal) {
        await client.query(
          `INSERT INTO preference_signals(id,user_id,dimension,value,polarity,strength,confidence,source_type,source_id,occurred_at,half_life_days)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,90) ON CONFLICT(user_id,source_id) DO NOTHING`,
          [
            uuidv7(),
            payload.userId,
            signal.dimension,
            JSON.stringify(signal.value),
            signal.polarity,
            signal.strength,
            signal.confidence,
            feedback.event_type,
            payload.feedbackId,
            feedback.created_at,
          ],
        );
      }
      await client.query(
        `INSERT INTO audit_events(id,actor_type,action,target_type,target_id,metadata,trace_id)
        VALUES($1,'WORKER','FEEDBACK_PROCESSED','FEEDBACK',$2,$3::jsonb,$4)`,
        [
          uuidv7(),
          payload.feedbackId,
          JSON.stringify({ workerId: this.workerId }),
          payload.traceId ?? event.id,
        ],
      );
      await this.finish(client, event.id);
    });
  }

  private async failEvent(event: ClaimedEvent, terminal = false) {
    await this.withEvent(event, async (client) => {
      const exhausted = terminal || event.attempts >= 8;
      const backoffSeconds = Math.min(300, 2 ** (event.attempts - 1));
      await client.query(
        `UPDATE outbox_events SET status=$1,available_at=now()+$2*interval '1 second',
        locked_at=NULL,locked_by=NULL,last_error='PROCESSING_FAILED' WHERE id=$3`,
        [exhausted ? "FAILED" : "RETRY", backoffSeconds, event.id],
      );
      const payload = captureEventSchema.safeParse(event.payload);
      if (exhausted && event.event_type === "CAPTURE_CREATED" && payload.success) {
        await client.query(
          `UPDATE captures SET status='FAILED',updated_at=now()
          WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL AND status IN ('UPLOADED','PROCESSING')`,
          [payload.data.captureId, payload.data.userId],
        );
      }
    });
  }
}
