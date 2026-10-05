import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { lifeObjectFacets, lifeObjects, outboxEvents } from "@life/db";
import {
  destinationQueryForObject,
  verifiedDestinationForObject,
  TencentLbsAdapter,
  type LocationProvider,
} from "@life/integrations";
import { IdempotencyService } from "../common/idempotency.service.js";
import { LOCATION_PROVIDER } from "../context/build-decision-context.service.js";
import type { LocationRefreshRequest } from "./location.contracts.js";

@Injectable()
export class PlaceLocationService {
  private readonly locations: LocationProvider;
  constructor(
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Optional() @Inject(LOCATION_PROVIDER) provider?: LocationProvider,
  ) {
    this.locations = provider ?? TencentLbsAdapter.fromEnvironment();
  }
  status() {
    return {
      provider: "TENCENT" as const,
      configured: this.locations.configured,
      geocoding: this.locations.configured,
      walkingRoutes: this.locations.configured,
      destinationPersistence: true as const,
    };
  }
  async refresh(
    userId: string,
    input: LocationRefreshRequest,
    key: string | undefined,
    traceId: string,
  ) {
    const result = await this.idempotency.execute(
      userId,
      "POST /v1/locations/refresh",
      key,
      input,
      async (tx) => {
        // A stable lock order makes overlapping batches safe and deduplicates differently keyed refreshes.
        const owned = await tx
          .select()
          .from(lifeObjects)
          .where(
            and(
              eq(lifeObjects.userId, userId),
              inArray(lifeObjects.id, input.objectIds),
              eq(lifeObjects.status, "ACTIVE"),
              isNull(lifeObjects.deletedAt),
            ),
          )
          .orderBy(lifeObjects.id)
          .for("update");
        if (owned.length !== input.objectIds.length)
          throw new NotFoundException({ code: "LOCATION_OBJECT_NOT_FOUND" });
        const items: Array<{
          lifeObjectId: string;
          eventId: string | null;
          status: "QUEUED" | "PENDING" | "NOT_CONFIGURED" | "NO_ADDRESS" | "ALREADY_LOCATED";
        }> = [];
        for (const id of input.objectIds) {
          const object = owned.find((row) => row.id === id)!;
          if (!this.locations.configured) {
            items.push({ lifeObjectId: id, eventId: null, status: "NOT_CONFIGURED" });
            continue;
          }
          const facets = await tx
            .select({
              facetType: lifeObjectFacets.facetType,
              facetKey: lifeObjectFacets.facetKey,
              originType: lifeObjectFacets.originType,
              data: lifeObjectFacets.data,
            })
            .from(lifeObjectFacets)
            .where(
              and(
                eq(lifeObjectFacets.userId, userId),
                eq(lifeObjectFacets.lifeObjectId, id),
                isNull(lifeObjectFacets.deletedAt),
              ),
            )
            .orderBy(desc(lifeObjectFacets.createdAt), desc(lifeObjectFacets.id));
          const destination = destinationQueryForObject(object, facets);
          if (!destination) {
            items.push({ lifeObjectId: id, eventId: null, status: "NO_ADDRESS" });
            continue;
          }
          if (verifiedDestinationForObject(object, facets)) {
            items.push({ lifeObjectId: id, eventId: null, status: "ALREADY_LOCATED" });
            continue;
          }
          const [permanent] = await tx
            .select({ id: outboxEvents.id })
            .from(outboxEvents)
            .where(
              and(
                eq(outboxEvents.aggregateId, id),
                eq(outboxEvents.eventType, "PLACE_LOCATION_ENRICH"),
                eq(outboxEvents.status, "DONE"),
                sql`${outboxEvents.payload} ->> 'userId' = ${userId}`,
                sql`${outboxEvents.payload} ->> 'objectVersion' = ${String(object.objectVersion)}`,
                sql`${outboxEvents.payload} ->> 'address' = ${destination.address}`,
                sql`coalesce(${outboxEvents.payload} ->> 'city', '') = ${destination.city ?? ""}`,
                sql`${outboxEvents.payload} #>> '{result,status}' IN ('AMBIGUOUS_ADDRESS','NO_ADDRESS','INVALID_LOCATION','INVALID_RESPONSE')`,
              ),
            )
            .limit(1);
          if (permanent) {
            items.push({ lifeObjectId: id, eventId: permanent.id, status: "NO_ADDRESS" });
            continue;
          }
          const [pending] = await tx
            .select({ id: outboxEvents.id })
            .from(outboxEvents)
            .where(
              and(
                eq(outboxEvents.aggregateId, id),
                eq(outboxEvents.eventType, "PLACE_LOCATION_ENRICH"),
                inArray(outboxEvents.status, ["PENDING", "RETRY", "PROCESSING"]),
                sql`${outboxEvents.payload} ->> 'userId' = ${userId}`,
                sql`${outboxEvents.payload} ->> 'objectVersion' = ${String(object.objectVersion)}`,
                sql`${outboxEvents.payload} ->> 'address' = ${destination.address}`,
                sql`coalesce(${outboxEvents.payload} ->> 'city', '') = ${destination.city ?? ""}`,
              ),
            )
            .limit(1);
          if (pending) {
            items.push({ lifeObjectId: id, eventId: pending.id, status: "PENDING" });
            continue;
          }
          const eventId = uuidv7();
          await tx.insert(outboxEvents).values({
            id: eventId,
            aggregateType: "LIFE_OBJECT",
            aggregateId: id,
            eventType: "PLACE_LOCATION_ENRICH",
            payload: {
              userId,
              lifeObjectId: id,
              objectVersion: object.objectVersion,
              address: destination.address,
              city: destination.city,
              label: destination.label,
              traceId,
            },
          });
          items.push({ lifeObjectId: id, eventId, status: "QUEUED" });
        }
        return { items };
      },
    );
    return { ...result.body, replayed: result.replayed };
  }
}
