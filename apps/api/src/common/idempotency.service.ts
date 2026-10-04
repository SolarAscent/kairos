import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { idempotencyKeys, type Database } from "@life/db";
import { uuidSchema } from "@life/contracts";
import { DATABASE } from "./tokens.js";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stable(record[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

@Injectable()
export class IdempotencyService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async execute<T extends Record<string, unknown>>(
    userId: string,
    route: string,
    keyInput: string | undefined,
    requestBody: unknown,
    operation: (tx: DbTransaction) => Promise<T>,
  ): Promise<{ body: T; replayed: boolean }> {
    const parsedKey = uuidSchema.safeParse(keyInput);
    if (!parsedKey.success)
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "Provide a UUID X-Idempotency-Key.",
      });
    const key = parsedKey.data;
    const recordKey = and(
      eq(idempotencyKeys.userId, userId),
      eq(idempotencyKeys.route, route),
      eq(idempotencyKeys.idempotencyKey, key),
    );
    const requestHash = createHash("sha256").update(stable(requestBody)).digest("hex");
    return this.db.transaction(async (tx) => {
      await tx
        .insert(idempotencyKeys)
        .values({
          userId,
          route,
          idempotencyKey: key,
          requestHash,
          expiresAt: new Date(Date.now() + 7 * 86400000),
        })
        .onConflictDoNothing();
      const [saved] = await tx.select().from(idempotencyKeys).where(recordKey).for("update");
      if (!saved) throw new Error("IDEMPOTENCY_RECORD_MISSING");
      const expired = saved.expiresAt <= new Date();
      if (expired) {
        await tx
          .update(idempotencyKeys)
          .set({
            requestHash,
            responseBody: null,
            responseStatus: null,
            expiresAt: new Date(Date.now() + 7 * 86400000),
          })
          .where(recordKey);
      } else {
        if (saved.requestHash !== requestHash)
          throw new ConflictException({
            code: "IDEMPOTENCY_CONFLICT",
            message: "This key was already used with a different request.",
          });
        if (saved.responseBody) return { body: saved.responseBody as T, replayed: true };
      }
      const body = await operation(tx);
      await tx
        .update(idempotencyKeys)
        .set({ responseStatus: 201, responseBody: body })
        .where(recordKey);
      return { body, replayed: false };
    });
  }
}
