import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@life/db";
import { MockModelProvider } from "@life/agent-core";
import { captureParseResultSchema } from "@life/contracts";
import type { LocationProvider, MapResult, GeocodedPlace } from "@life/integrations";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";
import { OutboxWorker } from "../../apps/worker/dist/worker.js";
import { migrate } from "../../packages/db/dist/migrations.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl)
  throw new Error("TEST_DATABASE_URL must identify a disposable local PostgreSQL database");
const schema = "maps_" + randomUUID().replaceAll("-", ""),
  admin = createDatabase(testUrl),
  url = new URL(testUrl);
url.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(url.toString()),
  pool = source.pool,
  originalEnv = { ...process.env };
let app: Awaited<ReturnType<typeof createApiApp>>,
  configured = true,
  calls = 0;
const point = { latitude: 23.13, longitude: 113.36, coordinateSystem: "GCJ02" as const };
const verified: MapResult<GeocodedPlace> = {
  ok: true,
  value: { location: point, reliability: 10, level: 10, city: "广州市", region: "广东省" },
};
let geocode: LocationProvider["geocode"] = async () => verified;
const provider: LocationProvider = {
  get configured() {
    return configured;
  },
  geocode: async (...args) => {
    calls++;
    return geocode(...args);
  },
  route: async () => ({ ok: false, reason: "NOT_CONFIGURED" }),
};
const worker = new OutboxWorker(pool, new MockModelProvider(), provider);
async function request(
  method: "GET" | "POST" | "PATCH",
  path: string,
  token: string,
  body?: object,
  key = randomUUID(),
) {
  return app.inject({
    method,
    url: path,
    headers: { authorization: `Bearer ${token}`, "x-idempotency-key": key },
    ...(body ? { payload: body } : {}),
  });
}
async function owner() {
  return (await request("POST", "/v1/auth/wechat/login", "", { code: randomUUID() })).json()
    .data as { userId: string; accessToken: string };
}
async function seed(userId: string, name = "天河公园", kind = "PLACE", extra: object = {}) {
  const id = randomUUID();
  await pool.query("INSERT INTO life_objects(id,user_id,title,kind) VALUES($1,$2,$3,$4)", [
    id,
    userId,
    name,
    kind,
  ]);
  await pool.query(
    "INSERT INTO life_object_projection(life_object_id,user_id,display_kind,search_text,projection_version) VALUES($1,$2,$3,$4,'map-test')",
    [id, userId, kind, name],
  );
  await pool.query(
    "INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,data,confidence,origin_type) VALUES($1,$2,$3,$4,'visit',$5,1,'USER_STATED')",
    [
      randomUUID(),
      userId,
      id,
      kind,
      {
        intent: null,
        description: null,
        verification: "UNVERIFIED",
        facts: {
          origin: "USER_STATED",
          evidence: `想去${name}`,
          place: { name, city: "广州市" },
          activityKind: "LOCAL_OUTING",
          ...extra,
        },
      },
    ],
  );
  return id;
}
async function refresh(token: string, ids: string[], key?: string) {
  return request("POST", "/v1/locations/refresh", token, { objectIds: ids }, key);
}
async function coordinates(id: string) {
  return (
    await pool.query(
      "SELECT latitude,longitude,coordinate_system FROM life_object_projection WHERE life_object_id=$1",
      [id],
    )
  ).rows[0];
}
beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    JWT_SECRET: "maps-test-only-key-longer-than-32-characters",
    WECHAT_MOCK_LOGIN: "true",
    NODE_ENV: "test",
  });
  app = await createApiApp({ locationProvider: provider });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 30000);
beforeEach(async () => {
  configured = true;
  calls = 0;
  geocode = async () => verified;
  await pool.query("DELETE FROM outbox_events");
});
afterAll(async () => {
  if (app) await app.close();
  await pool.end();
  await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
describe("owned asynchronous destination enrichment", () => {
  it("preserves the declared district when enriching a named venue", async () => {
    const user = await owner();
    const id = await seed(user.userId, "广州图书馆", "PLACE", {
      place: { name: "广州图书馆", city: "广州市", region: "天河区", province: "广东省" },
    });
    geocode = async (address, city) => {
      expect(address).toBe("广东省广州市天河区广州图书馆");
      expect(city).toBe("广州市");
      return verified;
    };
    await refresh(user.accessToken, [id]);
    await worker.processNext();
    expect((await coordinates(id)).latitude).toBe(point.latitude);
    const stored = await pool.query(
      "SELECT data FROM life_object_facets WHERE life_object_id=$1 AND facet_key='tencent_destination_location' AND deleted_at IS NULL",
      [id],
    );
    expect(stored.rows[0].data.location).toMatchObject({
      label: "广州图书馆",
      query: { address: "广东省广州市天河区广州图书馆", city: "广州市" },
    });
  });
  it("persists verified POI provenance without inventing geocoder reliability", async () => {
    const user = await owner();
    const id = await seed(user.userId);
    geocode = async () => ({
      ok: true,
      value: {
        location: point,
        city: "广州市",
        region: "广东省",
        verificationMethod: "POI_SEARCH",
        poi: {
          id: "test-poi-id",
          title: "天河公园",
          address: "广东省广州市天河区黄埔大道中",
          type: 0,
          city: "广州市",
          province: "广东省",
          district: "天河区",
          location: point,
          query: "天河公园",
          searchCity: "广州市",
          resultCount: 1,
          complete: true,
          uniqueMatches: 1,
          match: "EXACT_NAME",
        },
      },
    });
    await refresh(user.accessToken, [id]);
    await worker.processNext();
    expect((await coordinates(id)).latitude).toBe(point.latitude);
    const stored = await pool.query(
      "SELECT data FROM life_object_facets WHERE life_object_id=$1 AND facet_key='tencent_destination_location' AND deleted_at IS NULL",
      [id],
    );
    expect(stored.rows[0].data.location).toMatchObject({
      verificationMethod: "POI_SEARCH",
      poi: { id: "test-poi-id", title: "天河公园" },
    });
    expect(stored.rows[0].data.location).not.toHaveProperty("reliability");
    expect(stored.rows[0].data.location).not.toHaveProperty("level");
    expect((await refresh(user.accessToken, [id])).json().data.items[0].status).toBe(
      "ALREADY_LOCATED",
    );
  });
  it("reports configuration without key/IP leakage and never queues when unconfigured", async () => {
    const user = await owner(),
      id = await seed(user.userId);
    configured = false;
    const status = await request("GET", "/v1/locations/status", user.accessToken);
    expect(status.statusCode).toBe(200);
    expect(status.json().data).toEqual({
      provider: "TENCENT",
      configured: false,
      geocoding: false,
      walkingRoutes: false,
      destinationPersistence: true,
    });
    const response = await refresh(user.accessToken, [id]);
    expect(response.json().data.items[0]).toMatchObject({
      lifeObjectId: id,
      eventId: null,
      status: "NOT_CONFIGURED",
    });
    expect((await pool.query("SELECT id FROM outbox_events")).rowCount).toBe(0);
    expect(calls).toBe(0);
    expect((await request("GET", "/v1/locations/status", "")).statusCode).toBe(401);
  });
  it("validates batch size/duplicates and keeps mixed foreign batches atomic", async () => {
    const user = await owner(),
      other = await owner(),
      id = await seed(user.userId),
      foreign = await seed(other.userId);
    for (const ids of [[], [id, id], Array.from({ length: 6 }, () => randomUUID())])
      expect((await refresh(user.accessToken, ids)).statusCode).toBe(400);
    expect((await refresh(user.accessToken, [id, foreign])).statusCode).toBe(404);
    expect((await pool.query("SELECT id FROM outbox_events")).rowCount).toBe(0);
  });
  it("deduplicates overlapping refreshes and persists externally sourced coordinates for life/nearby", async () => {
    const user = await owner(),
      other = await owner(),
      id = await seed(user.userId),
      foreign = await seed(other.userId),
      key = randomUUID();
    const first = await refresh(user.accessToken, [id], key);
    const replay = await refresh(user.accessToken, [id], key);
    expect(replay.json().data.replayed).toBe(true);
    expect(replay.json().data.items).toEqual(first.json().data.items);
    const concurrent = await Promise.all([
      refresh(user.accessToken, [id]),
      refresh(user.accessToken, [id]),
    ]);
    expect(concurrent.every((response) => response.json().data.items[0].status === "PENDING")).toBe(
      true,
    );
    expect(
      (await pool.query("SELECT id FROM outbox_events WHERE event_type='PLACE_LOCATION_ENRICH'"))
        .rowCount,
    ).toBe(1);
    expect(await worker.processNext()).toBe(true);
    expect(calls).toBe(1);
    expect(await coordinates(id)).toMatchObject({
      latitude: point.latitude,
      longitude: point.longitude,
      coordinate_system: "GCJ02",
    });
    expect((await coordinates(foreign)).latitude).toBeNull();
    const external = (
      await pool.query(
        "SELECT origin_type,data FROM life_object_facets WHERE life_object_id=$1 AND facet_key='tencent_destination_location' AND deleted_at IS NULL",
        [id],
      )
    ).rows[0];
    expect(external.origin_type).toBe("EXTERNAL_VERIFIED");
    expect(external.data.location).toMatchObject({
      source: "EXTERNAL_VERIFIED",
      provider: "TENCENT",
      query: { address: "天河公园", city: "广州市" },
      ...point,
    });
    expect(external.data.facts).toBeUndefined();
    expect((await refresh(user.accessToken, [id])).json().data.items[0].status).toBe(
      "ALREADY_LOCATED",
    );
    const nearby = await request("POST", "/v1/life/search", user.accessToken, {
      location: "NEARBY",
      center: { ...point, radiusMeters: 1000 },
    });
    expect(nearby.json().data.items.map((item: { id: string }) => item.id)).toContain(id);
  });
  it("preserves external coordinates through a nonlocation patch and invalidates a changed destination", async () => {
    const user = await owner(),
      id = await seed(user.userId);
    await refresh(user.accessToken, [id]);
    await worker.processNext();
    expect(
      (await request("PATCH", `/v1/life/${id}`, user.accessToken, { summary: "以后有空再去" }))
        .statusCode,
    ).toBe(200);
    expect((await coordinates(id)).latitude).toBe(point.latitude);
    const additiveWorker = new OutboxWorker(
      pool,
      {
        providerName: "map-rebuild-fixture",
        modelName: "fixture",
        parseCapture: async () =>
          captureParseResultSchema.parse({
            objects: [
              {
                title: "天河公园",
                summary: null,
                kind: "PLACE",
                importance: 0.8,
                confidence: 1,
                uncertainFields: [],
                facets: [
                  {
                    type: "PLACE",
                    key: "additional-destination",
                    confidence: 1,
                    source: "EXTRACTED",
                    data: {
                      intent: null,
                      description: "想去天河公园",
                      verification: "UNVERIFIED",
                      facts: {
                        origin: "USER_STATED",
                        evidence: "想去天河公园",
                        place: { name: "天河公园", city: "广州市" },
                        activityKind: "LOCAL_OUTING",
                      },
                    },
                  },
                ],
              },
            ],
            relations: [],
            uncertainFields: [],
            suggestedEnrichments: [],
          }),
      },
      provider,
    );
    await request("POST", `/v1/life/${id}/rebuild-facts`, user.accessToken);
    await additiveWorker.processNext();
    expect((await coordinates(id)).latitude).toBe(point.latitude);
    // Remove this additional same-destination fact so the following explicit user correction
    // replaces the only authoritative address and cannot match an older provider result.
    await pool.query(
      "UPDATE life_object_facets SET deleted_at=now() WHERE life_object_id=$1 AND facet_key='additional-destination'",
      [id],
    );
    const changed = await request("PATCH", `/v1/life/${id}`, user.accessToken, {
      facts: [
        {
          type: "PLACE",
          key: "visit",
          facts: {
            origin: "USER_STATED",
            evidence: "改为越秀公园",
            place: { name: "越秀公园", city: "广州市" },
            activityKind: "LOCAL_OUTING",
          },
        },
      ],
    });
    expect(changed.statusCode).toBe(200);
    expect((await coordinates(id)).latitude).toBeNull();
  });
  it("rejects centroids and deduplicates a permanent ambiguity for the same revision", async () => {
    const user = await owner(),
      coarse = await seed(user.userId, "广州市"),
      id = await seed(user.userId);
    expect((await refresh(user.accessToken, [coarse])).json().data.items[0].status).toBe(
      "NO_ADDRESS",
    );
    geocode = async () => ({ ok: true, value: { location: point, reliability: 10, level: 1 } });
    await refresh(user.accessToken, [id]);
    await worker.processNext();
    expect((await coordinates(id)).latitude).toBeNull();
    expect((await refresh(user.accessToken, [id])).json().data.items[0].status).toBe("NO_ADDRESS");
    expect(calls).toBe(1);
  });
  it("fences a destination edit during the external request by object version and revision", async () => {
    const user = await owner(),
      id = await seed(user.userId);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    geocode = async () => {
      entered();
      await waiting;
      return verified;
    };
    await refresh(user.accessToken, [id]);
    const processing = worker.processNext();
    await started;
    await pool.query(
      "UPDATE life_objects SET object_version=object_version+1,title='已修改' WHERE id=$1",
      [id],
    );
    release();
    await processing;
    expect((await coordinates(id)).latitude).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT payload#>>'{result,status}' AS outcome FROM outbox_events WHERE aggregate_id=$1",
          [id],
        )
      ).rows[0].outcome,
    ).toBe("OBJECT_CHANGED");
  });
  it("fences a reclaimed worker lease before writing provider coordinates", async () => {
    const user = await owner(),
      id = await seed(user.userId);
    geocode = async () => {
      await pool.query(
        "UPDATE outbox_events SET locked_by='different-worker',attempts=attempts+1 WHERE aggregate_id=$1",
        [id],
      );
      return verified;
    };
    await refresh(user.accessToken, [id]);
    await worker.processNext();
    expect((await coordinates(id)).latitude).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT origin_type FROM life_object_facets WHERE life_object_id=$1 AND origin_type='EXTERNAL_VERIFIED'",
          [id],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await pool.query("SELECT status FROM outbox_events WHERE aggregate_id=$1", [id])).rows[0]
        .status,
    ).toBe("PROCESSING");
  });
  it("queues at most five destinations after Capture READY and reserves foreground processing", async () => {
    const user = await owner(),
      names = Array.from({ length: 6 }, (_, i) => `天河公园${i + 1}`);
    const text = `我在广东；${names.map((name) => `想去${name}`).join("；")}`;
    const response = await request("POST", "/v1/captures", user.accessToken, {
      type: "TEXT",
      text,
    });
    expect(response.statusCode).toBe(201);
    const parser = new OutboxWorker(
      pool,
      {
        providerName: "map-capture-fixture",
        modelName: "fixture",
        parseCapture: async () =>
          captureParseResultSchema.parse({
            objects: names.map((name) => ({
              title: name,
              summary: null,
              kind: "PLACE",
              importance: 0.8,
              confidence: 1,
              uncertainFields: [],
              facets: [
                {
                  type: "PLACE",
                  key: "destination",
                  confidence: 1,
                  source: "EXTRACTED",
                  data: {
                    intent: "VISIT",
                    description: `想去${name}`,
                    verification: "UNVERIFIED",
                    facts: {
                      origin: "USER_STATED",
                      evidence: `想去${name}`,
                      place: { name, city: "广州市" },
                      originContext: { region: "广东" },
                      activityKind: "LOCAL_OUTING",
                    },
                  },
                },
              ],
            })),
            relations: [],
            uncertainFields: [],
            suggestedEnrichments: [],
          }),
      },
      provider,
    );
    expect(await parser.processNext(false)).toBe(true);
    const captureId = response.json().data.captureId;
    expect(
      (await pool.query("SELECT status FROM captures WHERE id=$1", [captureId])).rows[0].status,
    ).toBe("READY");
    const jobs = (
      await pool.query(
        "SELECT aggregate_id,payload,status FROM outbox_events WHERE event_type='PLACE_LOCATION_ENRICH'",
      )
    ).rows;
    expect(jobs).toHaveLength(5);
    expect(calls).toBe(0);
    expect(
      jobs.every((job) => names.includes(job.payload.address) && job.payload.address !== "广东"),
    ).toBe(true);
    expect(await parser.processNext(false)).toBe(false);
    expect(calls).toBe(0);
    const queried: string[] = [];
    geocode = async (address) => {
      queried.push(address);
      return verified;
    };
    expect(await parser.processNext(true)).toBe(true);
    expect(queried).toHaveLength(1);
    expect(names).toContain(queried[0]);
    const done = (
      await pool.query(
        "SELECT aggregate_id FROM outbox_events WHERE event_type='PLACE_LOCATION_ENRICH' AND status='DONE'",
      )
    ).rows[0];
    expect((await coordinates(done.aggregate_id)).latitude).toBe(point.latitude);
  });
});
