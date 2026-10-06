import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { uuidSchema } from "@life/contracts";
import {
  destinationQueryForObject,
  verifiedDestinationForObject,
  verifiedDestinationData,
  tencentDestinationFacetKey,
  isVerifiedGeocodedPlace,
  type LocationProvider,
  type DestinationFacet,
} from "@life/integrations";

type Event = { id: string; payload: unknown; created_at: Date };
type Fence = <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T | undefined>;
const payloadSchema = z.object({
  lifeObjectId: uuidSchema,
  userId: uuidSchema,
  objectVersion: z.number().int().positive(),
  address: z.string().trim().min(1).max(240),
  city: z.string().max(80).optional(),
  label: z.string().min(1).max(240),
  traceId: uuidSchema.optional(),
});
type ObjectRow = {
  id: string;
  user_id: string;
  title: string;
  kind: string;
  status: string;
  object_version: number;
  revision: string;
  deleted_at: Date | null;
};

async function facetsFor(
  client: PoolClient,
  objectId: string,
  userId: string,
): Promise<DestinationFacet[]> {
  const result = await client.query<{
    facet_type: string;
    facet_key: string;
    origin_type: string;
    data: Record<string, unknown>;
  }>(
    "SELECT facet_type,facet_key,origin_type,data FROM life_object_facets WHERE life_object_id=$1 AND user_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC,id DESC",
    [objectId, userId],
  );
  return result.rows.map((row) => ({
    facetType: row.facet_type,
    facetKey: row.facet_key,
    originType: row.origin_type,
    data: row.data,
  }));
}
/** Best-effort auto enrichment is bounded per capture and never queries the user's current location. */
export async function enqueuePlaceLocationEnrichment(
  client: PoolClient,
  objects: Array<{
    id: string;
    userId: string;
    title: string;
    kind: string;
    objectVersion: number;
    facets: DestinationFacet[];
  }>,
  configured: boolean,
  traceId?: string,
) {
  if (!configured) return 0;
  let queued = 0;
  for (const object of objects) {
    if (queued >= 5) break;
    const destination = destinationQueryForObject(object, object.facets);
    if (!destination || verifiedDestinationForObject(object, object.facets)) continue;
    const pending = await client.query(
      `SELECT id FROM outbox_events WHERE aggregate_id=$1 AND event_type='PLACE_LOCATION_ENRICH'
      AND status IN ('PENDING','RETRY','PROCESSING') AND payload->>'userId'=$2 AND payload->>'objectVersion'=$3 LIMIT 1`,
      [object.id, object.userId, String(object.objectVersion)],
    );
    if (pending.rowCount) continue;
    await client.query(
      `INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,'LIFE_OBJECT',$2,'PLACE_LOCATION_ENRICH',$3::jsonb)`,
      [
        uuidv7(),
        object.id,
        JSON.stringify({
          lifeObjectId: object.id,
          userId: object.userId,
          objectVersion: object.objectVersion,
          ...destination,
          ...(traceId ? { traceId } : {}),
        }),
      ],
    );
    queued++;
  }
  return queued;
}

/** All reads/writes use the worker lease fence. The bounded provider call runs outside transactions. */
export async function enrichPlaceLocation(
  event: Event,
  provider: LocationProvider,
  fence: Fence,
  finish: (client: PoolClient) => Promise<void>,
) {
  const payload = payloadSchema.parse(event.payload);
  async function outcome(client: PoolClient, status: string) {
    await client.query(
      "UPDATE outbox_events SET payload=jsonb_set(payload,'{result}',$2::jsonb,true) WHERE id=$1",
      [
        event.id,
        JSON.stringify({ status, provider: "TENCENT", observedAt: new Date().toISOString() }),
      ],
    );
    await client.query(
      `INSERT INTO audit_events(id,actor_type,action,target_type,target_id,metadata,trace_id)
      VALUES($1,'WORKER','PLACE_LOCATION_ENRICHED','LIFE_OBJECT',$2,$3::jsonb,$4)`,
      [
        uuidv7(),
        payload.lifeObjectId,
        JSON.stringify({ userId: payload.userId, eventId: event.id, status, provider: "TENCENT" }),
        payload.traceId ?? event.id,
      ],
    );
    await finish(client);
  }
  const snapshot = await fence(async (client) => {
    const {
      rows: [object],
    } = await client.query<ObjectRow>(
      "SELECT *,xmin::text AS revision FROM life_objects WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [payload.lifeObjectId, payload.userId],
    );
    if (
      !object ||
      object.deleted_at ||
      object.status !== "ACTIVE" ||
      object.object_version !== payload.objectVersion
    ) {
      await outcome(client, "OBJECT_CHANGED");
      return undefined;
    }
    const destination = destinationQueryForObject(
      object,
      await facetsFor(client, object.id, payload.userId),
    );
    if (
      !destination ||
      destination.address !== payload.address ||
      (destination.city ?? "") !== (payload.city ?? "")
    ) {
      await outcome(client, "ADDRESS_CHANGED");
      return undefined;
    }
    return { object, destination };
  });
  if (!snapshot) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    provider.geocode(snapshot.destination.address, snapshot.destination.city, controller.signal),
    new Promise<{ ok: false; reason: "TIMEOUT" }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: "TIMEOUT" });
      }, 2000);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (!result.ok) {
    if (
      [
        "TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_REJECTED",
        "RATE_LIMITED",
        "QUOTA_EXCEEDED",
      ].includes(result.reason)
    )
      throw new Error(`MAP_${result.reason}`);
    await fence((client) => outcome(client, result.reason));
    return;
  }
  if (!isVerifiedGeocodedPlace(result.value, snapshot.destination)) {
    await fence((client) => outcome(client, "AMBIGUOUS_ADDRESS"));
    return;
  }
  await fence(async (client) => {
    const {
      rows: [current],
    } = await client.query<ObjectRow>(
      "SELECT *,xmin::text AS revision FROM life_objects WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [payload.lifeObjectId, payload.userId],
    );
    if (
      !current ||
      current.deleted_at ||
      current.status !== "ACTIVE" ||
      current.object_version !== payload.objectVersion ||
      current.revision !== snapshot.object.revision
    ) {
      await outcome(client, "OBJECT_CHANGED");
      return;
    }
    const destination = destinationQueryForObject(
      current,
      await facetsFor(client, current.id, payload.userId),
    );
    if (
      !destination ||
      destination.address !== snapshot.destination.address ||
      (destination.city ?? "") !== (snapshot.destination.city ?? "")
    ) {
      await outcome(client, "ADDRESS_CHANGED");
      return;
    }
    const observedAt = new Date().toISOString(),
      data = verifiedDestinationData(destination, result.value, observedAt);
    await client.query(
      "UPDATE life_object_facets SET deleted_at=now(),updated_at=now() WHERE life_object_id=$1 AND user_id=$2 AND facet_key=$3 AND origin_type='EXTERNAL_VERIFIED' AND deleted_at IS NULL",
      [current.id, payload.userId, tencentDestinationFacetKey],
    );
    await client.query(
      `INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,schema_version,data,confidence,origin_type,origin_id,valid_from)
      VALUES($1,$2,$3,'PLACE',$4,1,$5::jsonb,1,'EXTERNAL_VERIFIED',$6,now())`,
      [
        uuidv7(),
        payload.userId,
        current.id,
        tencentDestinationFacetKey,
        JSON.stringify(data),
        event.id,
      ],
    );
    await client.query(
      `INSERT INTO life_object_projection(life_object_id,user_id,display_kind,search_text,projection_version,latitude,longitude,coordinate_system)
      VALUES($1,$2,$3,$4,'tencent-destination-v1',$5,$6,'GCJ02') ON CONFLICT(life_object_id) DO UPDATE SET
      latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,coordinate_system='GCJ02',rebuilt_at=now()
      WHERE life_object_projection.user_id=EXCLUDED.user_id`,
      [
        current.id,
        payload.userId,
        current.kind,
        current.title,
        result.value.location.latitude,
        result.value.location.longitude,
      ],
    );
    await client.query(
      "UPDATE life_objects SET object_version=object_version+1,updated_at=now() WHERE id=$1 AND user_id=$2",
      [current.id, payload.userId],
    );
    await outcome(client, "VERIFIED");
  });
}
