import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { captures, outboxEvents, type Database } from "@life/db";
import type { CreateCaptureRequest } from "@life/contracts";
import { DATABASE } from "../common/tokens.js";
import { IdempotencyService } from "../common/idempotency.service.js";

const captureFields = {
  id: captures.id,
  type: captures.captureType,
  status: captures.status,
  text: captures.textContent,
  createdAt: captures.createdAt,
  updatedAt: captures.updatedAt,
};

@Injectable()
export class CapturesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  async create(
    userId: string,
    input: CreateCaptureRequest,
    key: string | undefined,
    traceId: string,
  ) {
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
          textContent: input.text,
          language: input.language,
        });
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
