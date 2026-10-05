import { createHash } from "node:crypto";
import { VoiceService } from "../media/voice.service.js";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { captures, captureAssets, outboxEvents, type Database } from "@life/db";
import type { CreateCaptureRequest } from "@life/contracts";
import { DATABASE } from "../common/tokens.js";
import { IdempotencyService } from "../common/idempotency.service.js";

const captureFields = {
  id: captures.id,
  type: captures.captureType,
  status: captures.status,
  text: captures.textContent,
  title: sql<string | null>`(SELECT obj.title FROM life_object_sources src
    JOIN life_objects obj ON obj.id=src.life_object_id AND obj.user_id=src.user_id
    WHERE src.user_id="captures"."user_id" AND src.source_id="captures"."id"
      AND src.source_type='CAPTURE' AND src.is_primary=true AND obj.deleted_at IS NULL
    ORDER BY obj.created_at,obj.id LIMIT 1)`,
  summary: sql<string | null>`(SELECT obj.summary FROM life_object_sources src
    JOIN life_objects obj ON obj.id=src.life_object_id AND obj.user_id=src.user_id
    WHERE src.user_id="captures"."user_id" AND src.source_id="captures"."id"
      AND src.source_type='CAPTURE' AND src.is_primary=true AND obj.deleted_at IS NULL
    ORDER BY obj.created_at,obj.id LIMIT 1)`,
  createdAt: captures.createdAt,
  updatedAt: captures.updatedAt,
};

@Injectable()
export class CapturesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(VoiceService) private readonly voice: VoiceService,
  ) {}

  async create(
    userId: string,
    input: CreateCaptureRequest,
    key: string | undefined,
    traceId: string,
  ) {
    // Validate bytes before committing. Only inline JPEG/PNG data can reach the model.
    let imageBytes: Buffer | undefined;
    if (input.type === "IMAGE") {
      imageBytes = Buffer.from(input.image.base64, "base64");
      const valid =
        imageBytes.length > 8 &&
        imageBytes.length <= 2 * 1024 * 1024 &&
        imageBytes.toString("base64") === input.image.base64 &&
        (input.image.mimeType === "image/png"
          ? imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : imageBytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])));
      if (!valid) throw new BadRequestException({ code: "IMAGE_FORMAT_OR_SIZE_INVALID" });
    }
    const result = await this.idempotency.execute(
      userId,
      "POST /v1/captures",
      key,
      input,
      async (tx) => {
        const captureId = uuidv7();
        const eventId = uuidv7();
        await tx.insert(captures).values({
          id: captureId,
          userId,
          captureType: input.type,
          sourceChannel: input.sourceChannel,
          textContent: input.text ?? null,
          sourceUrl: input.type === "VOICE" ? `asr:${input.transcriptionSessionId}` : null,
          language: input.language,
        });
        if (input.type === "IMAGE" && imageBytes) {
          await tx.insert(captureAssets).values({
            id: uuidv7(),
            userId,
            captureId,
            assetType: "IMAGE",
            storageKey: `data:${input.image.mimeType};base64,${input.image.base64}`,
            mimeType: input.image.mimeType,
            sizeBytes: imageBytes.length,
            sha256: createHash("sha256").update(imageBytes).digest("hex"),
          });
        }
        if (input.type === "VOICE") {
          const transcript = this.voice.assertTranscript(userId, input.transcriptionSessionId);
          const bytes = Buffer.from(JSON.stringify(transcript));
          await tx.insert(captureAssets).values({
            id: uuidv7(),
            userId,
            captureId,
            assetType: "TRANSCRIPT",
            storageKey: `data:application/json;base64,${bytes.toString("base64")}`,
            mimeType: "application/json",
            sizeBytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
        }
        await tx.insert(outboxEvents).values({
          id: eventId,
          aggregateType: "CAPTURE",
          aggregateId: captureId,
          eventType: "CAPTURE_CREATED",
          payload: { captureId, userId, traceId },
        });
        return { captureId, status: "UPLOADED", accepted: true };
      },
    );
    return { ...result.body, replayed: result.replayed };
  }

  async list(userId: string) {
    return this.db
      .select(captureFields)
      .from(captures)
      .where(and(eq(captures.userId, userId), isNull(captures.deletedAt)))
      .orderBy(desc(captures.createdAt))
      .limit(50);
  }

  async get(userId: string, captureId: string) {
    const [capture] = await this.db
      .select(captureFields)
      .from(captures)
      .where(
        and(eq(captures.id, captureId), eq(captures.userId, userId), isNull(captures.deletedAt)),
      )
      .limit(1);
    if (!capture) throw new NotFoundException({ code: "CAPTURE_NOT_FOUND" });
    return capture;
  }
}
