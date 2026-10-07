import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@life/db";
import {
  locationMapSelectResponseSchema,
  locationPickerIntentResponseSchema,
  nowResponseSchema,
} from "@life/contracts";
import {
  tencentDestinationFacetKey,
  userSelectedDestinationForObject,
  verifiedDestinationForObject,
  type GeoPoint,
  type LocationProvider,
} from "@life/integrations";
import { migrate } from "../../packages/db/dist/migrations.js";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
const schema = "location_map_" + randomUUID().replaceAll("-", ""),
  admin = createDatabase(testUrl),
  url = new URL(testUrl);
url.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(url.toString()),
  pool = source.pool,
  originalEnv = { ...process.env };
const origin: GeoPoint = { latitude: 23.1, longitude: 113.3, coordinateSystem: "GCJ02" },
  selectedPoint: GeoPoint = { latitude: 23.105, longitude: 113.305, coordinateSystem: "GCJ02" },
  oldProjectionPoint: GeoPoint = { latitude: 24.1, longitude: 114.3, coordinateSystem: "GCJ02" };
const selection = {
  name: "用户选定的合成公园南门",
  address: "广州市合成路18号",
  location: selectedPoint,
};
type Owner = { userId: string; accessToken: string };
let app: Awaited<ReturnType<typeof createApiApp>>;
const routes: Array<{ from: GeoPoint; to: GeoPoint }> = [];
let geocodeCalls = 0,
  choiceCalls = 0;
const provider: LocationProvider = {
  configured: true,
  geocode: async () => {
    geocodeCalls++;
    return { ok: false, reason: "AMBIGUOUS_ADDRESS" };
  },
  searchChoices: async () => {
    choiceCalls++;
    return { ok: true, value: [] };
  },
  route: async (from, to) => {
    routes.push({ from: { ...from }, to: { ...to } });
    return {
      ok: true,
      value: {
        distanceMeters: 100,
        durationSeconds: 120,
        mode: "walking",
        provider: "TENCENT",
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      },
    };
  },
};
async function request(
  path: string,
  user: Owner | string,
  body?: object,
  key = randomUUID(),
  method: "POST" | "GET" = "POST",
) {
  return app.inject({
    method,
    url: path,
    headers: {
      authorization: "Bearer " + (typeof user === "string" ? user : user.accessToken),
      "x-idempotency-key": key,
    },
    ...(body ? { payload: body } : {}),
  });
}
async function owner(): Promise<Owner> {
  const response = await request("/v1/auth/wechat/login", "", { code: randomUUID() });
  expect(response.statusCode).toBe(201);
  return response.json().data;
}
async function seed(user: Owner, legacyCoordinates = false) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO life_objects(id,user_id,title,kind,importance_score) VALUES($1,$2,'合成公园','PLACE',0.9)",
    [id, user.userId],
  );
  await pool.query(
    `INSERT INTO life_object_projection(life_object_id,user_id,display_kind,search_text,projection_version,duration_min_seconds,latitude,longitude,coordinate_system)
     VALUES($1,$2,'PLACE','合成公园','map-selection-fixture',600,$3,$4,$5)`,
    [
      id,
      user.userId,
      legacyCoordinates ? oldProjectionPoint.latitude : null,
      legacyCoordinates ? oldProjectionPoint.longitude : null,
      legacyCoordinates ? "GCJ02" : null,
    ],
  );
  return id;
}
async function intent(user: Owner, id: string) {
  const response = await request("/v1/locations/picker-intents", user, { lifeObjectId: id });
  expect(response.statusCode).toBe(201);
  return locationPickerIntentResponseSchema.parse(response.json().data);
}
function selectBody(id: string, token: string) {
  return { lifeObjectId: id, intentToken: token, ...selection };
}
async function stored(id: string) {
  const object = (await pool.query("SELECT * FROM life_objects WHERE id=$1", [id])).rows[0];
  const facets = (
    await pool.query(
      'SELECT data,origin_type AS "originType",facet_key AS "facetKey" FROM life_object_facets WHERE life_object_id=$1 AND deleted_at IS NULL',
      [id],
    )
  ).rows;
  return { object, facets };
}
async function assertUnselected(id: string) {
  const { object, facets } = await stored(id);
  expect(object.object_version).toBe(1);
  expect(facets).toHaveLength(0);
}
function nowInput(id?: string) {
  return {
    ...(id ? { focusObjectId: id } : {}),
    context: {
      availableMinutes: 60,
      willingToGoOut: true,
      location: {
        ...origin,
        source: "DEVICE",
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    },
  };
}
beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    JWT_SECRET: "location-map-test-secret-at-least-32-chars",
    WECHAT_MOCK_LOGIN: "true",
    NODE_ENV: "test",
  });
  app = await createApiApp({ locationProvider: provider });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 30000);
beforeEach(() => {
  routes.length = 0;
  geocodeCalls = 0;
  choiceCalls = 0;
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe("native map destination intent and confirmation", () => {
  it("issues a bounded intent without selecting coordinates or calling the location provider", async () => {
    const user = await owner(),
      id = await seed(user),
      offered = await intent(user, id);
    expect(offered.lifeObjectId).toBe(id);
    expect(Date.parse(offered.expiresAt) - Date.now()).toBeGreaterThan(290000);
    expect(Date.parse(offered.expiresAt) - Date.now()).toBeLessThanOrEqual(300000);
    const payload = JSON.parse(
      Buffer.from(offered.intentToken.split(".")[0]!, "base64url").toString(),
    );
    expect(payload).toMatchObject({
      userId: user.userId,
      objectId: id,
      objectVersion: 1,
      query: { address: "合成公园", label: "合成公园" },
    });
    expect(JSON.stringify(payload)).not.toMatch(/latitude|longitude/);
    await assertUnselected(id);
    expect(
      (
        await pool.query(
          "SELECT latitude,longitude FROM life_object_projection WHERE life_object_id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({ latitude: null, longitude: null });
    expect(routes).toEqual([]);
    expect(geocodeCalls + choiceCalls).toBe(0);
  });

  it("persists user intent with USER_STATED origin and does not impersonate external address verification", async () => {
    const user = await owner(),
      id = await seed(user),
      offered = await intent(user, id);
    const response = await request(
      "/v1/locations/map-select",
      user,
      selectBody(id, offered.intentToken),
    );
    expect(response.statusCode).toBe(201);
    expect(locationMapSelectResponseSchema.parse(response.json().data)).toEqual({
      lifeObjectId: id,
      selected: true,
      replayed: false,
    });
    const { object, facets } = await stored(id);
    expect(object.object_version).toBe(2);
    expect(facets).toHaveLength(1);
    expect(facets[0]).toMatchObject({
      originType: "USER_STATED",
      facetKey: tencentDestinationFacetKey,
      data: {
        verification: "USER_CONFIRMED",
        location: {
          source: "USER_SELECTED_MAP",
          provider: "WECHAT_NATIVE",
          query: { address: "合成公园" },
          selection,
        },
      },
    });
    expect(userSelectedDestinationForObject(object, facets)).toEqual({
      ...selection,
      source: "USER_SELECTED_MAP",
      scope: "USER_CONFIRMED_INTENT",
    });
    expect(verifiedDestinationForObject(object, facets)).toBeUndefined();
    expect(
      (
        await pool.query(
          "SELECT latitude,longitude,coordinate_system FROM life_object_projection WHERE life_object_id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({
      latitude: selectedPoint.latitude,
      longitude: selectedPoint.longitude,
      coordinate_system: "GCJ02",
    });
    expect(routes).toEqual([]);
  });

  it("replays a selection exactly once without another version, facet, or audit event", async () => {
    const user = await owner(),
      id = await seed(user),
      offered = await intent(user, id),
      key = randomUUID(),
      body = selectBody(id, offered.intentToken);
    expect((await request("/v1/locations/map-select", user, body, key)).statusCode).toBe(201);
    const replay = await request("/v1/locations/map-select", user, body, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.replayed).toBe(true);
    const { object, facets } = await stored(id);
    expect(object.object_version).toBe(2);
    expect(facets).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM audit_events WHERE target_id=$1 AND action='LOCATION_MAP_SELECTED'",
          [id],
        )
      ).rows[0].count,
    ).toBe(1);
    const conflict = await request(
      "/v1/locations/map-select",
      user,
      { ...body, address: "另一个地址" },
      key,
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("serializes competing confirmations so a single object version is selected once", async () => {
    const user = await owner(),
      id = await seed(user),
      offered = await intent(user, id);
    const responses = await Promise.all([
      request("/v1/locations/map-select", user, selectBody(id, offered.intentToken)),
      request("/v1/locations/map-select", user, {
        ...selectBody(id, offered.intentToken),
        name: "用户选定的合成公园北门",
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json().error.code).toBe(
      "LOCATION_OBJECT_CHANGED",
    );
    const { object, facets } = await stored(id);
    expect(object.object_version).toBe(2);
    expect(facets).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM audit_events WHERE target_id=$1 AND action='LOCATION_MAP_SELECTED'",
          [id],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("isolates both intent enumeration and signed confirmation by owner", async () => {
    const user = await owner(),
      other = await owner(),
      id = await seed(user),
      offered = await intent(user, id);
    expect(
      (await request("/v1/locations/picker-intents", other, { lifeObjectId: id })).statusCode,
    ).toBe(404);
    const response = await request(
      "/v1/locations/map-select",
      other,
      selectBody(id, offered.intentToken),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("LOCATION_PICKER_INVALID");
    await assertUnselected(id);
  });

  it("rejects tampered intent payloads and a valid token applied to another object", async () => {
    const user = await owner(),
      id = await seed(user),
      otherId = await seed(user),
      offered = await intent(user, id);
    const [encoded, signature] = offered.intentToken.split(".");
    const payload = JSON.parse(Buffer.from(encoded!, "base64url").toString());
    payload.query.address = "篡改的目的地";
    const altered = Buffer.from(JSON.stringify(payload)).toString("base64url") + "." + signature;
    for (const body of [selectBody(id, altered), selectBody(otherId, offered.intentToken)]) {
      const response = await request("/v1/locations/map-select", user, body);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("LOCATION_PICKER_INVALID");
    }
    await assertUnselected(id);
    await assertUnselected(otherId);
  });

  it("rejects expired intents even when their signature remains valid", async () => {
    const user = await owner(),
      id = await seed(user),
      offered = await intent(user, id);
    const payload = JSON.parse(
      Buffer.from(offered.intentToken.split(".")[0]!, "base64url").toString(),
    );
    payload.expiresAt = Date.now() - 1;
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url"),
      signature = createHmac("sha256", process.env.JWT_SECRET!)
        .update("kairos-location-picker-v1:" + encoded)
        .digest("base64url");
    const response = await request(
      "/v1/locations/map-select",
      user,
      selectBody(id, encoded + "." + signature),
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("LOCATION_PICKER_EXPIRED");
    await assertUnselected(id);
  });

  it.each(["version", "destination"] as const)(
    "requires a new intent after changing the %s",
    async (change) => {
      const user = await owner(),
        id = await seed(user),
        offered = await intent(user, id);
      if (change === "version")
        await pool.query("UPDATE life_objects SET object_version=object_version+1 WHERE id=$1", [
          id,
        ]);
      else await pool.query("UPDATE life_objects SET title='另一个合成公园' WHERE id=$1", [id]);
      const response = await request(
        "/v1/locations/map-select",
        user,
        selectBody(id, offered.intentToken),
      );
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("LOCATION_OBJECT_CHANGED");
      expect((await stored(id)).facets).toHaveLength(0);
    },
  );

  it.each([
    { latitude: 0, longitude: 0, coordinateSystem: "GCJ02" },
    { latitude: 17, longitude: 113, coordinateSystem: "GCJ02" },
    { latitude: 23, longitude: 136, coordinateSystem: "GCJ02" },
    { latitude: 23, longitude: 113, coordinateSystem: "WGS84" },
    { latitude: "23", longitude: 113, coordinateSystem: "GCJ02" },
  ])("rejects invalid selected coordinates at the API boundary: %j", async (location) => {
    const user = await owner(),
      id = await seed(user),
      offered = await intent(user, id);
    const response = await request("/v1/locations/map-select", user, {
      ...selectBody(id, offered.intentToken),
      location,
    });
    expect(response.statusCode).toBe(400);
    await assertUnselected(id);
    expect(routes).toEqual([]);
  });

  it.each([true, false])(
    "ignores old projection coordinates without user confirmation (focused=%s)",
    async (focused) => {
      const user = await owner(),
        id = await seed(user, true);
      const response = await request("/v1/now/sessions", user, nowInput(focused ? id : undefined));
      expect(response.statusCode).toBe(201);
      const state = nowResponseSchema.parse(response.json().data);
      expect(state.selectedDestination).toBeNull();
      expect(
        state.candidates.find((candidate) => candidate.lifeObjectId === id)?.routeCheck,
      ).toEqual({ status: "UNAVAILABLE", reason: "DESTINATION_UNRESOLVED" });
      expect(routes).toEqual([]);
      expect(geocodeCalls + choiceCalls).toBe(0);
    },
  );

  it("uses the confirmed point for a round trip, restores its address in Now, and omits GPS from durable metadata", async () => {
    const user = await owner(),
      id = await seed(user, true),
      offered = await intent(user, id);
    expect(
      (await request("/v1/locations/map-select", user, selectBody(id, offered.intentToken)))
        .statusCode,
    ).toBe(201);
    const key = randomUUID(),
      body = nowInput(id),
      response = await request("/v1/now/sessions", user, body, key);
    expect(response.statusCode).toBe(201);
    const state = nowResponseSchema.parse(response.json().data),
      expected = {
        lifeObjectId: id,
        name: selection.name,
        address: selection.address,
        source: "USER_SELECTED_MAP",
      };
    expect(state.selectedDestination).toEqual(expected);
    expect(response.json().data.selectedDestination).toEqual(expected);
    expect(state.routeCheck).toMatchObject({
      status: "READY",
      reason: null,
      detail: { origin, destination: selectedPoint, destinationLabel: selection.name },
    });
    expect(routes).toEqual([
      { from: origin, to: selectedPoint },
      { from: selectedPoint, to: origin },
    ]);
    expect(geocodeCalls + choiceCalls).toBe(0);
    const restored = await request(
      `/v1/now/sessions/${state.sessionId}`,
      user,
      undefined,
      randomUUID(),
      "GET",
    );
    expect(restored.statusCode).toBe(200);
    expect(nowResponseSchema.parse(restored.json().data).selectedDestination).toEqual(expected);
    expect(restored.json().data.selectedDestination).toEqual(expected);
    const replay = await request("/v1/now/sessions", user, body, key);
    expect(replay.json().data.selectedDestination).toEqual(expected);
    expect(replay.json().data.replayed).toBe(true);
    expect(routes).toHaveLength(2);
    const durable = (
      await pool.query(
        `SELECT
       (SELECT jsonb_agg(metadata) FROM audit_events WHERE target_id=$1 OR target_id=$2) AS audits,
       (SELECT context_summary FROM decision_sessions WHERE id=$2) AS summary,
       (SELECT jsonb_agg(action_payload) FROM action_candidates WHERE decision_session_id=$2) AS actions,
       (SELECT jsonb_agg(execution_payload) FROM recommendations WHERE decision_session_id=$2) AS recommendations,
       (SELECT response_body FROM idempotency_keys WHERE user_id=$3 AND idempotency_key=$4) AS replay_body`,
        [id, state.sessionId, user.userId, key],
      )
    ).rows[0];
    expect(durable.audits).toContainEqual(
      expect.objectContaining({
        source: "USER_SELECTED_MAP",
        scope: "USER_CONFIRMED_INTENT",
        objectVersion: 2,
      }),
    );
    for (const value of Object.values(durable))
      expect(JSON.stringify(value)).not.toMatch(/"latitude"|"longitude"|"origin"/);
  });
});
