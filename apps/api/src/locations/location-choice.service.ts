import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
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
  type LocationChoicesRequest,
  type LocationSelectRequest,
} from "@life/contracts";
import {
  destinationQueryForObject,
  isVerifiedGeocodedPlace,
  TencentLbsAdapter,
  tencentDestinationFacetKey,
  verifiedDestinationData,
  type DestinationQuery,
  type LocationProvider,
  type PoiChoice,
} from "@life/integrations";
import { DATABASE } from "../common/tokens.js";
import { readAuthConfig } from "../common/auth-config.js";
import { IdempotencyService } from "../common/idempotency.service.js";
import { LOCATION_PROVIDER } from "../context/build-decision-context.service.js";

const choicePayloadSchema = z
  .object({
    userId: uuidSchema,
    objectId: uuidSchema,
    objectVersion: z.number().int().positive(),
    query: z.object({
      address: z.string().min(1).max(240),
      label: z.string().min(1).max(240),
      city: z.string().max(80).optional(),
    }),
    choice: z.object({
      id: z.string().min(1).max(256),
      title: z.string().min(1).max(240),
      address: z.string().min(1).max(512),
      city: z.string().min(1).max(80),
      province: z.string().min(1).max(80),
      district: z.string().max(80).optional(),
      location: z.object({
        latitude: z.number().finite().min(-90).max(90),
        longitude: z.number().finite().min(-180).max(180),
        coordinateSystem: z.literal("GCJ02"),
      }),
      match: z.enum(["EXACT_NAME", "EXACT_ADDRESS"]),
    }),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type ChoicePayload = z.infer<typeof choicePayloadSchema>;
const selectedPlace = (choice: PoiChoice) => ({
  location: choice.location,
  city: choice.city,
  region: choice.province,
  verificationMethod: "USER_SELECTED_POI" as const,
  selection: choice,
});
function sign(payload: string) {
  return createHmac("sha256", readAuthConfig().JWT_SECRET)
    .update("kairos-location-choice-v1:" + payload)
    .digest("base64url");
}
function encode(value: ChoicePayload) {
  const body = Buffer.from(JSON.stringify(choicePayloadSchema.parse(value))).toString("base64url");
  return body + "." + sign(body);
}
function decode(token: string): ChoicePayload {
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error();
    const actual = Buffer.from(parts[1], "base64url"),
      expected = Buffer.from(sign(parts[0]), "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    return choicePayloadSchema.parse(
      JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
    );
  } catch {
    throw new BadRequestException({ code: "LOCATION_CHOICE_INVALID" });
  }
}
function sameQuery(a: DestinationQuery, b: DestinationQuery) {
  return a.address === b.address && (a.city ?? "") === (b.city ?? "");
}

@Injectable()
export class LocationChoiceService {
  private readonly locations: LocationProvider;
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Optional() @Inject(LOCATION_PROVIDER) provider?: LocationProvider,
  ) {
    this.locations = provider ?? TencentLbsAdapter.fromEnvironment();
  }

  private async destination(userId: string, objectId: string) {
    const [object] = await this.db
      .select()
      .from(lifeObjects)
      .where(
        and(
          eq(lifeObjects.id, objectId),
          eq(lifeObjects.userId, userId),
          eq(lifeObjects.status, "ACTIVE"),
          isNull(lifeObjects.deletedAt),
        ),
      )
      .limit(1);
    if (!object) throw new NotFoundException({ code: "LOCATION_OBJECT_NOT_FOUND" });
    const facets = await this.db
      .select()
      .from(lifeObjectFacets)
      .where(
        and(
          eq(lifeObjectFacets.lifeObjectId, object.id),
          eq(lifeObjectFacets.userId, userId),
          isNull(lifeObjectFacets.deletedAt),
        ),
      )
      .orderBy(desc(lifeObjectFacets.createdAt), desc(lifeObjectFacets.id));
    return { object, query: destinationQueryForObject(object, facets) };
  }

  async choices(userId: string, input: LocationChoicesRequest) {
    const { object, query } = await this.destination(userId, input.lifeObjectId);
    const expiresAt = Date.now() + 5 * 60000;
    const base = { lifeObjectId: object.id, expiresAt: new Date(expiresAt).toISOString() };
    if (!query) return { ...base, choices: [], reason: "DESTINATION_UNRESOLVED" };
    if (!this.locations.configured || !this.locations.searchChoices)
      return { ...base, choices: [], reason: "NOT_CONFIGURED" };
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.locations.searchChoices(query.address, query.city, abort.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error("CHOICE_TIMEOUT"));
          }, 4000);
        }),
      ]);
      if (!result.ok) return { ...base, choices: [], reason: result.reason };
      const seen = new Set<string>();
      const choices = result.value
        .filter((choice) => {
          if (seen.has(choice.id) || !isVerifiedGeocodedPlace(selectedPlace(choice), query))
            return false;
          seen.add(choice.id);
          return true;
        })
        .slice(0, 6)
        .map((choice) => ({
          token: encode({
            userId,
            objectId: object.id,
            objectVersion: object.objectVersion,
            query,
            choice,
            expiresAt,
          }),
          title: choice.title,
          address: choice.address,
          city: choice.city,
          ...(choice.district ? { district: choice.district } : {}),
        }));
      return { ...base, choices, reason: choices.length ? null : "AMBIGUOUS_ADDRESS" };
    } catch {
      return {
        ...base,
        choices: [],
        reason: abort.signal.aborted ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
      };
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
    }
  }

  async select(
    userId: string,
    input: LocationSelectRequest,
    key: string | undefined,
    traceId: string,
  ) {
    const result = await this.idempotency.execute(
      userId,
      "POST /v1/locations/select",
      key,
      input,
      async (tx) => {
        const payload = decode(input.choiceToken);
        if (payload.userId !== userId || payload.objectId !== input.lifeObjectId)
          throw new BadRequestException({ code: "LOCATION_CHOICE_INVALID" });
        if (payload.expiresAt <= Date.now())
          throw new ConflictException({ code: "LOCATION_CHOICES_EXPIRED" });
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
        if (object.objectVersion !== payload.objectVersion)
          throw new ConflictException({ code: "LOCATION_OBJECT_CHANGED" });
        const facets = await tx
          .select()
          .from(lifeObjectFacets)
          .where(
            and(
              eq(lifeObjectFacets.lifeObjectId, object.id),
              eq(lifeObjectFacets.userId, userId),
              isNull(lifeObjectFacets.deletedAt),
            ),
          )
          .orderBy(desc(lifeObjectFacets.createdAt), desc(lifeObjectFacets.id));
        const query = destinationQueryForObject(object, facets),
          place = selectedPlace(payload.choice);
        if (!query || !sameQuery(query, payload.query) || !isVerifiedGeocodedPlace(place, query))
          throw new ConflictException({ code: "LOCATION_OBJECT_CHANGED" });
        const now = new Date();
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
          originType: "EXTERNAL_VERIFIED",
          originId: object.id,
          confidence: 1,
          schemaVersion: 3,
          data: verifiedDestinationData(query, place, now.toISOString()),
        });
        await tx
          .insert(lifeObjectProjection)
          .values({
            lifeObjectId: object.id,
            userId,
            displayKind: object.kind,
            searchText: object.title,
            projectionVersion: "projection-v0.4",
            ...place.location,
            rebuiltAt: now,
          })
          .onConflictDoUpdate({
            target: lifeObjectProjection.lifeObjectId,
            set: { ...place.location, rebuiltAt: now },
          });
        await tx
          .update(lifeObjects)
          .set({ objectVersion: sql`${lifeObjects.objectVersion}+1`, updatedAt: now })
          .where(and(eq(lifeObjects.id, object.id), eq(lifeObjects.userId, userId)));
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          actorType: "USER",
          actorId: userId,
          action: "LOCATION_CHOICE_SELECTED",
          targetType: "LIFE_OBJECT",
          targetId: object.id,
          metadata: {
            provider: "TENCENT",
            poiId: payload.choice.id,
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
