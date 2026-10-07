import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { createDatabase } from "@life/db";
import { migrate } from "../../packages/db/dist/migrations.js";
import { createApiApp } from "../../apps/api/dist/bootstrap.js";
import { locationChoicesResponseSchema, locationSelectResponseSchema } from "@life/contracts";
import {
  verifiedDestinationForObject,
  type LocationProvider,
  type PoiChoice,
} from "@life/integrations";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
const schema = "location_choice_" + randomUUID().replaceAll("-", ""),
  admin = createDatabase(testUrl),
  url = new URL(testUrl);
url.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(url.toString()),
  pool = source.pool,
  originalEnv = { ...process.env };
let app: Awaited<ReturnType<typeof createApiApp>>;
const places: PoiChoice[] = [
  {
    id: "public-school-dg",
    title: "合成中心小学",
    address: "广东省东莞市合成路1号",
    city: "东莞市",
    province: "广东省",
    location: { latitude: 23.02, longitude: 113.88, coordinateSystem: "GCJ02" },
    match: "EXACT_NAME",
  },
  {
    id: "public-school-sz",
    title: "合成中心小学",
    address: "广东省深圳市合成路2号",
    city: "深圳市",
    province: "广东省",
    district: "南山区",
    location: { latitude: 22.54, longitude: 114.06, coordinateSystem: "GCJ02" },
    match: "EXACT_NAME",
  },
];
let candidates = places,
  failure: string | undefined;
const provider: LocationProvider = {
  configured: true,
  geocode: async () => ({ ok: false, reason: "AMBIGUOUS_ADDRESS" }),
  route: async () => ({ ok: false, reason: "NO_ROUTE" }),
  searchChoices: async () =>
    failure ? { ok: false, reason: failure as "QUOTA_EXCEEDED" } : { ok: true, value: candidates },
};
type Owner = { userId: string; accessToken: string };
async function request(path: string, owner: Owner | string, body: object, key = randomUUID()) {
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      authorization: "Bearer " + (typeof owner === "string" ? owner : owner.accessToken),
      "x-idempotency-key": key,
    },
    payload: body,
  });
}
async function owner(): Promise<Owner> {
  return (await request("/v1/auth/wechat/login", "", { code: randomUUID() })).json().data;
}
async function seed(user: Owner) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO life_objects(id,user_id,title,kind) VALUES($1,$2,'合成中心小学','PLACE')",
    [id, user.userId],
  );
  await pool.query(
    "INSERT INTO life_object_projection(life_object_id,user_id,search_text,projection_version) VALUES($1,$2,'合成中心小学','projection-v0.4')",
    [id, user.userId],
  );
  return id;
}
async function offer(user: Owner, id: string) {
  const response = await request("/v1/locations/choices", user, { lifeObjectId: id });
  expect(response.statusCode).toBe(201);
  return locationChoicesResponseSchema.parse(response.json().data);
}
beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    JWT_SECRET: "location-choice-test-secret-at-least-32-chars",
    WECHAT_MOCK_LOGIN: "true",
    NODE_ENV: "test",
  });
  app = await createApiApp({ locationProvider: provider });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
beforeEach(() => {
  candidates = places;
  failure = undefined;
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe("explicit city-aware location selection", () => {
  it("offers both cities without choosing or persisting either until user confirmation", async () => {
    const user = await owner(),
      id = await seed(user),
      result = await offer(user, id);
    expect(result.choices.map((c) => c.city)).toEqual(["东莞市", "深圳市"]);
    expect(result.choices[1]?.address).toContain("深圳市");
    expect(result.choices).not.toContainEqual(
      expect.objectContaining({ latitude: expect.anything() }),
    );
    expect(
      (
        await pool.query("SELECT latitude FROM life_object_projection WHERE life_object_id=$1", [
          id,
        ])
      ).rows[0].latitude,
    ).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM life_object_facets WHERE life_object_id=$1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("persists the exact user-selected POI and makes it available for future route and nearby queries", async () => {
    const user = await owner(),
      id = await seed(user),
      options = await offer(user, id),
      key = randomUUID();
    const body = { lifeObjectId: id, choiceToken: options.choices[1]!.token };
    const response = await request("/v1/locations/select", user, body, key);
    expect(response.statusCode).toBe(201);
    expect(locationSelectResponseSchema.parse(response.json().data)).toEqual({
      lifeObjectId: id,
      selected: true,
      replayed: false,
    });
    const projection = (
      await pool.query(
        "SELECT latitude,longitude FROM life_object_projection WHERE life_object_id=$1",
        [id],
      )
    ).rows[0];
    expect(projection).toEqual({
      latitude: places[1]!.location.latitude,
      longitude: places[1]!.location.longitude,
    });
    const object = (
      await pool.query("SELECT title,kind,object_version FROM life_objects WHERE id=$1", [id])
    ).rows[0];
    const facets = (
      await pool.query(
        'SELECT data,origin_type as "originType",facet_key as "facetKey" FROM life_object_facets WHERE life_object_id=$1 AND deleted_at IS NULL',
        [id],
      )
    ).rows;
    expect(verifiedDestinationForObject(object, facets)).toEqual(places[1]!.location);
    expect(facets[0].data.location.verificationMethod).toBe("USER_SELECTED_POI");
    expect(facets[0].data.location).not.toHaveProperty("reliability");
    expect(object.object_version).toBe(2);
    const replay = await request("/v1/locations/select", user, body, key);
    expect(replay.json().data.replayed).toBe(true);
    expect(
      (await pool.query("SELECT object_version FROM life_objects WHERE id=$1", [id])).rows[0]
        .object_version,
    ).toBe(2);
  });
  it("does not let another user enumerate the object or apply its signed option", async () => {
    const user = await owner(),
      other = await owner(),
      id = await seed(user),
      options = await offer(user, id);
    expect((await request("/v1/locations/choices", other, { lifeObjectId: id })).statusCode).toBe(
      404,
    );
    expect(
      (
        await request("/v1/locations/select", other, {
          lifeObjectId: id,
          choiceToken: options.choices[0]!.token,
        })
      ).statusCode,
    ).toBe(400);
  });
  it("rejects an altered token, an arbitrary coordinate payload, and applying it to a different object", async () => {
    const user = await owner(),
      id = await seed(user),
      otherId = await seed(user),
      options = await offer(user, id),
      token = options.choices[0]!.token;
    expect(
      (
        await request("/v1/locations/select", user, {
          lifeObjectId: id,
          choiceToken: token.slice(1),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request("/v1/locations/select", user, {
          lifeObjectId: id,
          choiceToken: token,
          latitude: 20,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await request("/v1/locations/select", user, { lifeObjectId: otherId, choiceToken: token }))
        .statusCode,
    ).toBe(400);
  });
  it("requires a fresh option after the object has changed", async () => {
    const user = await owner(),
      id = await seed(user),
      options = await offer(user, id);
    await pool.query("UPDATE life_objects SET object_version=object_version+1 WHERE id=$1", [id]);
    const response = await request("/v1/locations/select", user, {
      lifeObjectId: id,
      choiceToken: options.choices[0]!.token,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("LOCATION_OBJECT_CHANGED");
  });
  it("rejects expired options even with a valid signature", async () => {
    const user = await owner(),
      id = await seed(user),
      options = await offer(user, id),
      payload = JSON.parse(
        Buffer.from(options.choices[0]!.token.split(".")[0]!, "base64url").toString(),
      );
    payload.expiresAt = Date.now() - 1;
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url"),
      signature = createHmac("sha256", process.env.JWT_SECRET!)
        .update("kairos-location-choice-v1:" + body)
        .digest("base64url");
    const response = await request("/v1/locations/select", user, {
      lifeObjectId: id,
      choiceToken: body + "." + signature,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("LOCATION_CHOICES_EXPIRED");
  });
  it("serializes competing selections and accepts just one object version", async () => {
    const user = await owner(),
      id = await seed(user),
      options = await offer(user, id);
    const responses = await Promise.all(
      options.choices.map((choice) =>
        request("/v1/locations/select", user, { lifeObjectId: id, choiceToken: choice.token }),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM life_object_facets WHERE life_object_id=$1 AND deleted_at IS NULL",
          [id],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("rejects invalid provider choices and makes quota errors visible instead of empty success", async () => {
    const user = await owner(),
      id = await seed(user);
    candidates = [{ ...places[0]!, title: "别的学校" }];
    expect((await offer(user, id)).choices).toEqual([]);
    failure = "QUOTA_EXCEEDED";
    expect(await offer(user, id)).toMatchObject({ choices: [], reason: "QUOTA_EXCEEDED" });
  });
});
