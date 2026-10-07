import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import {
  auditEvents,
  lifeObjectFacets,
  lifeObjectProjection,
  lifeObjects,
  type Database,
} from "@life/db";
import {
  uuidSchema,
  type LocationMapSelectRequest,
  type LocationPickerIntentRequest,
} from "@life/contracts";
import {
  destinationSelectionQueryForObject,
  tencentDestinationFacetKey,
  userSelectedDestinationData,
} from "@life/integrations";
import { DATABASE } from "../common/tokens.js";
import { readAuthConfig } from "../common/auth-config.js";
import { IdempotencyService } from "../common/idempotency.service.js";

const intentSchema = z
  .object({
    userId: uuidSchema,
    objectId: uuidSchema,
    objectVersion: z.number().int().positive(),
    query: z.object({
      address: z.string().min(1).max(240),
      label: z.string().min(1).max(240),
      city: z.string().max(80).optional(),
    }),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type Intent = z.infer<typeof intentSchema>;
type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
function signature(body: string) {
  return createHmac("sha256", readAuthConfig().JWT_SECRET)
    .update("kairos-location-picker-v1:" + body)
    .digest("base64url");
}
function encode(intent: Intent) {
  const body = Buffer.from(JSON.stringify(intentSchema.parse(intent))).toString("base64url");
  return body + "." + signature(body);
}
function decode(token: string): Intent {
  try {
    const [body, sig, ...extra] = token.split(".");
    if (!body || !sig || extra.length) throw new Error();
    const actual = Buffer.from(sig, "base64url"),
      expected = Buffer.from(signature(body), "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    return intentSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    throw new BadRequestException({ code: "LOCATION_PICKER_INVALID" });
  }
}

/** A user supplied destination is intent evidence, never an attestation that its address exists. */
@Injectable()
export class LocationMapSelectionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}
  private async facets(tx: Database | DbTransaction, userId: string, objectId: string) {
    return tx
      .select()
      .from(lifeObjectFacets)
      .where(
        and(
          eq(lifeObjectFacets.userId, userId),
          eq(lifeObjectFacets.lifeObjectId, objectId),
          isNull(lifeObjectFacets.deletedAt),
        ),
      )
      .orderBy(desc(lifeObjectFacets.createdAt), desc(lifeObjectFacets.id));
  }
  async intent(userId: string, input: LocationPickerIntentRequest) {
    const [object] = await this.db
      .select()
      .from(lifeObjects)
      .where(
        and(
          eq(lifeObjects.id, input.lifeObjectId),
          eq(lifeObjects.userId, userId),
          eq(lifeObjects.status, "ACTIVE"),
          isNull(lifeObjects.deletedAt),
        ),
      )
      .limit(1);
    if (!object) throw new NotFoundException({ code: "LOCATION_OBJECT_NOT_FOUND" });
    const query = destinationSelectionQueryForObject(
      object,
      await this.facets(this.db, userId, object.id),
    );
    if (!query) throw new BadRequestException({ code: "LOCATION_DESTINATION_REQUIRED" });
    const expiresAt = Date.now() + 5 * 60000;
    return {
      lifeObjectId: object.id,
      intentToken: encode({
        userId,
        objectId: object.id,
        objectVersion: object.objectVersion,
        query,
        expiresAt,
      }),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  async select(
    userId: string,
    input: LocationMapSelectRequest,
    key: string | undefined,
    traceId: string,
  ) {
    const result = await this.idempotency.execute(
      userId,
      "POST /v1/locations/map-select",
      key,
      input,
      async (tx) => {
        const intent = decode(input.intentToken);
        if (intent.userId !== userId || intent.objectId !== input.lifeObjectId)
          throw new BadRequestException({ code: "LOCATION_PICKER_INVALID" });
        if (intent.expiresAt <= Date.now())
          throw new ConflictException({ code: "LOCATION_PICKER_EXPIRED" });
        const [object] = await tx
          .select()
          .from(lifeObjects)
          .where(
            and(
              eq(lifeObjects.id, input.lifeObjectId),
              eq(lifeObjects.userId, userId),
              eq(lifeObjects.status, "ACTIVE"),
              isNull(lifeObjects.deletedAt),
            ),
          )
          .for("update")
          .limit(1);
        if (!object) throw new NotFoundException({ code: "LOCATION_OBJECT_NOT_FOUND" });
        if (object.objectVersion !== intent.objectVersion)
          throw new ConflictException({ code: "LOCATION_OBJECT_CHANGED" });
        const query = destinationSelectionQueryForObject(
          object,
          await this.facets(tx, userId, object.id),
        );
        if (
          !query ||
          query.address !== intent.query.address ||
          (query.city ?? "") !== (intent.query.city ?? "")
        )
          throw new ConflictException({ code: "LOCATION_OBJECT_CHANGED" });
        const now = new Date();
        const data = userSelectedDestinationData(
          query,
          { name: input.name, address: input.address, location: input.location },
          now.toISOString(),
        );
        await tx
          .update(lifeObjectFacets)
          .set({ deletedAt: now })
          .where(
            and(
              eq(lifeObjectFacets.userId, userId),
              eq(lifeObjectFacets.lifeObjectId, object.id),
              eq(lifeObjectFacets.facetKey, tencentDestinationFacetKey),
              isNull(lifeObjectFacets.deletedAt),
            ),
          );
        await tx.insert(lifeObjectFacets).values({
          id: uuidv7(),
          userId,
          lifeObjectId: object.id,
          facetType: "PLACE",
          facetKey: tencentDestinationFacetKey,
          originType: "USER_STATED",
          originId: object.id,
          confidence: 1,
          schemaVersion: 4,
          data,
        });
        await tx
          .insert(lifeObjectProjection)
          .values({
            lifeObjectId: object.id,
            userId,
            displayKind: object.kind,
            searchText: object.title,
            projectionVersion: "projection-v0.4",
            ...input.location,
            rebuiltAt: now,
          })
          .onConflictDoUpdate({
            target: lifeObjectProjection.lifeObjectId,
            set: { ...input.location, rebuiltAt: now },
          });
        await tx
          .update(lifeObjects)
          .set({ objectVersion: sql`${lifeObjects.objectVersion}+1`, updatedAt: now })
          .where(and(eq(lifeObjects.id, object.id), eq(lifeObjects.userId, userId)));
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          actorType: "USER",
          actorId: userId,
          action: "LOCATION_MAP_SELECTED",
          targetType: "LIFE_OBJECT",
          targetId: object.id,
          metadata: {
            source: "USER_SELECTED_MAP",
            scope: "USER_CONFIRMED_INTENT",
            objectVersion: object.objectVersion + 1,
          },
          traceId,
        });
        return { lifeObjectId: object.id, selected: true as const };
      },
    );
    return { ...result.body, replayed: result.replayed };
  }
}
