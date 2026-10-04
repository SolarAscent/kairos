import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Pool, PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import type { ModelGateway } from "@life/agent-core";
import { captureParseResultSchema, uuidSchema, type CaptureParseResult } from "@life/contracts";
import { derivePreferenceSignal } from "@life/domain";
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
type ClaimedEvent = { id: string; event_type: string; payload: unknown; attempts: number };
type Capture = { text_content: string | null; status: string; deleted_at: Date | null };

export class OutboxWorker {
  readonly workerId = `${hostname()}:${randomUUID()}`;

  constructor(
    private readonly pool: Pool,
    private readonly gateway: ModelGateway,
  ) {}

  async processNext(): Promise<boolean> {
    const {
      rows: [event],
    } = await this.pool.query<ClaimedEvent>(
      `
      WITH candidate AS (
        SELECT id FROM outbox_events
        WHERE (status IN ('PENDING', 'RETRY') AND available_at <= now())
           OR (status = 'PROCESSING' AND locked_at < now() - interval '2 minutes')
        ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE outbox_events AS event
        SET status = 'PROCESSING', locked_at = now(), locked_by = $1, attempts = event.attempts + 1
        FROM candidate WHERE event.id = candidate.id
        RETURNING event.id, event.event_type, event.payload, event.attempts`,
      [this.workerId],
    );
    if (!event) return false;
    try {
      if (event.event_type === "CAPTURE_CREATED") await this.processCapture(event);
      else if (event.event_type === "FEEDBACK_RECORDED") await this.processFeedback(event);
      else throw new Error("UNKNOWN_EVENT_TYPE");
    } catch {
      await this.failEvent(event);
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
    const text = await this.withEvent(event, async (client) => {
      const {
        rows: [capture],
      } = await client.query<Capture>(
        "SELECT text_content,status,deleted_at FROM captures WHERE id=$1 AND user_id=$2 FOR UPDATE",
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
      if (!capture.text_content) throw new Error("CAPTURE_TEXT_EMPTY");
      await client.query(
        "UPDATE captures SET status='PROCESSING',updated_at=now() WHERE id=$1 AND user_id=$2",
        [payload.captureId, payload.userId],
      );
      return capture.text_content;
    });
    if (text === undefined) return;
    const startedAt = new Date();
    let result: CaptureParseResult;
    try {
      result = captureParseResultSchema.parse(await this.gateway.parseCapture(text));
    } catch (error) {
      await this.withEvent(event, (client) =>
        this.recordModelCall(client, event, payload, text, startedAt, null),
      );
      throw error;
    }
    await this.withEvent(event, async (client) => {
      // Re-read after the provider call: deletion or another event may have won.
      const {
        rows: [capture],
      } = await client.query<Capture>(
        "SELECT text_content,status,deleted_at FROM captures WHERE id=$1 AND user_id=$2 FOR UPDATE",
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
      for (const object of result.objects) {
        const objectId = uuidv7();
        objectIds.push(objectId);
        await client.query(
          `INSERT INTO life_objects(id,user_id,title,summary,status,kind,importance_score)
          VALUES($1,$2,$3,$4,'ACTIVE',$5,$6)`,
          [objectId, payload.userId, object.title, object.summary, object.kind, object.importance],
        );
        for (const facet of object.facets) {
          await client.query(
            `INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,schema_version,data,confidence,origin_type,origin_id)
            VALUES($1,$2,$3,$4,$5,2,$6::jsonb,$7,$8,$9)`,
            [
              uuidv7(),
              payload.userId,
              objectId,
              facet.type,
              facet.key,
              JSON.stringify(facet.data),
              facet.confidence,
              facet.source,
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
          `INSERT INTO life_object_projection(life_object_id,user_id,display_kind,importance_score,desire_score,search_text,projection_version)
          VALUES($1,$2,$3,$4,$5,$6,'projection-v0.2')`,
          [
            objectId,
            payload.userId,
            object.kind,
            object.importance,
            object.kind === "DESIRE" ? object.importance : null,
            [object.title, object.summary].filter(Boolean).join(" "),
          ],
        );
      }
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
      const needsReview =
        !result.objects.length ||
        result.uncertainFields.length > 0 ||
        result.objects.some((object) => object.uncertainFields.length > 0);
      await client.query(
        "UPDATE captures SET status=$1,pipeline_version='capture-v0.2',updated_at=now() WHERE id=$2 AND user_id=$3",
        [needsReview ? "NEEDS_REVIEW" : "READY", payload.captureId, payload.userId],
      );
      await this.recordModelCall(client, event, payload, text, startedAt, result);
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
    text: string,
    startedAt: Date,
    result: CaptureParseResult | null,
  ) {
    const runId = uuidv7();
    await client.query(
      `INSERT INTO agent_runs(id,user_id,purpose,entity_type,entity_id,pipeline_version,status,trace_id,started_at,completed_at,error_code)
      VALUES($1,$2,'CAPTURE_PARSE','CAPTURE',$3,'capture-v0.2',$4,$5,$6,now(),$7)`,
      [
        runId,
        payload.userId,
        payload.captureId,
        result ? "SUCCEEDED" : "FAILED",
        payload.traceId ?? event.id,
        startedAt,
        result ? null : "MODEL_PARSE_FAILED",
      ],
    );
    await client.query(
      `INSERT INTO model_calls(id,agent_run_id,provider,model,prompt_name,prompt_version,schema_version,input_hash,status,structured_output,latency_ms,error_code)
      VALUES($1,$2,$3,$4,'capture.parse','0.2','0.2',$5,$6,$7::jsonb,$8,$9)`,
      [
        uuidv7(),
        runId,
        this.gateway.providerName,
        this.gateway.modelName,
        createHash("sha256").update(text).digest("hex"),
        result ? "SUCCEEDED" : "FAILED",
        result ? JSON.stringify(result) : null,
        Date.now() - startedAt.getTime(),
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
        created_at: Date;
      }>(
        `
        SELECT f.event_type,f.reason_code,f.created_at,c.action_type FROM feedback_events f
        JOIN recommendations r ON r.id=f.recommendation_id AND r.user_id=f.user_id
        JOIN action_candidates c ON c.id=r.action_candidate_id AND c.user_id=f.user_id
        WHERE f.id=$1 AND f.user_id=$2 AND c.id=$3`,
        [payload.feedbackId, payload.userId, payload.candidateId],
      );
      if (!feedback) throw new Error("FEEDBACK_REFERENCE_INVALID");
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

  private async failEvent(event: ClaimedEvent) {
    await this.withEvent(event, async (client) => {
      const exhausted = event.attempts >= 8;
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
