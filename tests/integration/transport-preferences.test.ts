import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "@life/db";
import { migrate } from "../../packages/db/dist/migrations.js";
import { TransportPreferenceReader } from "../../apps/api/src/feedback/transport-preference-reader.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
const schema = "transport_pref_" + randomUUID().replaceAll("-", "");
const admin = createDatabase(testUrl),
  url = new URL(testUrl);
url.searchParams.set("options", `-c search_path=${schema}`);
const source = createDatabase(url.toString()),
  pool = source.pool;
const reader = new TransportPreferenceReader(source.db);
const at = new Date("2026-10-06T12:00:00Z");
const earlier = new Date("2026-10-01T12:00:00Z");
const later = new Date("2026-10-05T12:00:00Z");

beforeAll(async () => {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
}, 30000);
afterAll(async () => {
  await pool.end();
  await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.pool.end();
});
async function owner() {
  const id = randomUUID();
  await pool.query("INSERT INTO users(id) VALUES($1)", [id]);
  return id;
}
type RecordOptions = {
  text?: string;
  evidence?: string;
  date?: Date;
  origin?: string;
  factsOrigin?: string;
  kind?: string;
  captureOwner?: string;
  facetOwner?: string;
  expired?: boolean;
  confidence?: number;
  captureType?: string;
};
async function record(user: string, text: string, options: RecordOptions = {}) {
  const id = randomUUID(),
    capture = randomUUID(),
    facet = randomUUID();
  const date = options.date ?? earlier;
  await pool.query(
    "INSERT INTO life_objects(id,user_id,title,kind,created_at) VALUES($1,$2,$3,$4,$5)",
    [id, user, text, options.kind ?? "DESIRE", date],
  );
  await pool.query(
    `INSERT INTO captures(id,user_id,capture_type,source_channel,status,text_content,created_at)
    VALUES($1,$2,$3,'test','READY',$4,$5)`,
    [
      capture,
      options.captureOwner ?? user,
      options.captureType ?? "TEXT",
      options.text ?? text,
      date,
    ],
  );
  await pool.query(
    `INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,data,
    confidence,origin_type,origin_id,created_at,valid_until) VALUES($1,$2,$3,'PREFERENCE','test',$4,$5,$6,$7,$8,$9)`,
    [
      facet,
      options.facetOwner ?? user,
      id,
      {
        description: text,
        facts: {
          origin: options.factsOrigin ?? "USER_STATED",
          evidence: options.evidence ?? text,
        },
      },
      options.confidence ?? 1,
      options.origin ?? "USER_STATED",
      capture,
      date,
      options.expired ? later : null,
    ],
  );
  await pool.query(
    `INSERT INTO life_object_sources(id,user_id,life_object_id,source_type,source_id,is_primary,
    confidence,created_at) VALUES($1,$2,$3,'CAPTURE',$4,true,1,$5)`,
    [randomUUID(), user, id, capture, date],
  );
  return { id, capture, facet };
}
async function vote(user: string, id: string, rating: string, date = later, expires?: Date) {
  await pool.query(
    `INSERT INTO preference_signals(id,user_id,dimension,value,polarity,strength,confidence,
    source_type,source_id,occurred_at,expires_at) VALUES($1,$2,'life_object',$3,$4,$5,1,'LIFE_RATING',$6,$7,$8)`,
    [
      randomUUID(),
      user,
      { lifeObjectId: id, kind: "DESIRE", rating },
      rating === "DISLIKE" ? -1 : 1,
      rating === "NONE" ? 0 : 1,
      randomUUID(),
      date,
      expires ?? null,
    ],
  );
}
async function behavior(
  user: string,
  id: string,
  event: string,
  reason?: string,
  mode = "DO",
  date = later,
) {
  const session = randomUUID(),
    candidate = randomUUID(),
    recommendation = randomUUID();
  await pool.query(
    `INSERT INTO decision_sessions(id,user_id,status,scoring_version,question_policy_version,
    context_summary,expires_at) VALUES($1,$2,'RECOMMENDED','test','test','{}',$3)`,
    [session, user, at],
  );
  await pool.query(
    `INSERT INTO action_candidates(id,user_id,decision_session_id,target_life_object_id,action_type,
    action_payload,value_score,fit_score,friction_score,urgency_score,uncertainty_score,total_score,
    hard_filter_status,generator_version,scoring_version)
    VALUES($1,$2,$3,$4,'GO_TO_PLACE',$5,0.5,0.5,0.1,0.1,0.1,0.5,'PASS','test','test')`,
    [candidate, user, session, id, { actionMode: mode }],
  );
  await pool.query(
    `INSERT INTO recommendations(id,user_id,decision_session_id,action_candidate_id,headline,
    execution_type,execution_payload,copy_version) VALUES($1,$2,$3,$4,'test','GO_TO_PLACE','{}','test')`,
    [recommendation, user, session, candidate],
  );
  await pool.query(
    `INSERT INTO feedback_events(id,user_id,recommendation_id,decision_session_id,event_type,
    reason_code,client_event_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), user, recommendation, session, event, reason ?? null, randomUUID(), date],
  );
}
const none = { preferScenicBus: false, source: null };

describe("traceable scenic transport preference", () => {
  it("reads an explicit source through a transaction and lets latest mode/scenery negation dominate", async () => {
    const user = await owner();
    await record(user, "我喜欢看沿途风景");
    expect(
      await source.db.transaction((tx) => new TransportPreferenceReader(tx).read(user, at)),
    ).toEqual({ preferScenicBus: true, source: "EXPLICIT" });
    for (const [index, text] of [
      "我不喜欢看风景",
      "我不坐公交",
      "我更喜欢地铁",
      "撤回我的看风景偏好",
    ].entries()) {
      await record(user, text, { date: new Date(later.getTime() + index * 1000) });
      expect(await reader.read(user, at)).toEqual({ preferScenicBus: false, source: "EXPLICIT" });
    }
  });
  it.each([
    "我想去公园看风景",
    "我想去新疆",
    "朋友喜欢看风景",
    "他说我喜欢看风景",
    "我想知道喜欢看风景的人去哪",
    "我喜欢不看风景",
    "我不太喜欢看风景",
    "朋友说，喜欢看风景",
    "我喜欢看风景的人",
    "我喜欢讨论看风景",
    "我不喜欢看风景的电影",
  ])("does not infer a positive explicit preference from %s", async (text) => {
    const user = await owner();
    await record(user, text);
    expect((await reader.read(user, at)).preferScenicBus).toBe(false);
  });
  it("rejects fabricated, inferred, third-party and low-confidence evidence", async () => {
    for (const options of [
      { evidence: "我喜欢看风景", text: "想去新疆" },
      { origin: "INFERRED" },
      { factsOrigin: "INFERRED" },
      { confidence: 0.5 },
      { captureType: "URL" },
    ]) {
      const user = await owner();
      await record(user, "我喜欢看风景", options);
      expect(await reader.read(user, at)).toEqual(none);
    }
  });
  it.each([
    "我喜欢风景",
    "我偏爱看窗外的风景",
    "我喜欢坐公交看沿途风景",
    "喜欢看日落",
    "我不喜欢地铁，我喜欢看风景",
  ])("recognizes narrowly stated self preferences in %s", async (text) => {
    const user = await owner();
    await record(user, text.replace("風景", "风景"));
    expect(await reader.read(user, at)).toEqual({ preferScenicBus: true, source: "EXPLICIT" });
  });
  it("checks owners at every join and ignores another user's explicit preferences and likes", async () => {
    const user = await owner(),
      other = await owner();
    await record(other, "我喜欢看风景");
    await record(user, "我喜欢看风景", { captureOwner: other });
    await record(user, "我喜欢看风景", { facetOwner: other });
    const object = await record(user, "想去看日落");
    await vote(other, object.id, "LIKE");
    expect(await reader.read(user, at)).toEqual(none);
  });
  it("honors deleted source/facet/object, validity and future capture boundaries", async () => {
    for (const table of ["captures", "life_object_facets", "life_objects"]) {
      const user = await owner(),
        object = await record(user, "我喜欢看风景");
      const id =
        table === "captures"
          ? object.capture
          : table === "life_object_facets"
            ? object.facet
            : object.id;
      await pool.query(`UPDATE ${table} SET deleted_at=$1 WHERE id=$2`, [later, id]);
      expect(await reader.read(user, at)).toEqual(none);
    }
    for (const options of [{ expired: true }, { date: new Date(at.getTime() + 1000) }]) {
      const user = await owner();
      await record(user, "我喜欢看风景", options);
      expect(await reader.read(user, at)).toEqual(none);
    }
  });
  it("learns repeated independent sightseeing records even within the same theme", async () => {
    const user = await owner();
    const first = await record(user, "我想去海边看日落");
    await vote(user, first.id, "LIKE");
    expect(await reader.read(user, at)).toEqual(none);
    const duplicate = await record(user, "我想去山顶看日落");
    await vote(user, duplicate.id, "LIKE");
    expect(await reader.read(user, at)).toEqual({ preferScenicBus: true, source: "LEARNED" });
    const second = await record(user, "我想去江边看风景");
    await vote(user, second.id, "LIKE");
    expect(await reader.read(user, at)).toEqual({ preferScenicBus: true, source: "LEARNED" });
    await record(user, "我喜欢地铁", { date: later });
    expect(await reader.read(user, at)).toEqual({ preferScenicBus: false, source: "EXPLICIT" });
  });
  it("does not turn broad PLACE likes or multiple themes from a single capture into bus preference", async () => {
    const user = await owner();
    for (const text of ["想去公园", "想去新疆"]) {
      const object = await record(user, text, { kind: "PLACE" });
      await vote(user, object.id, "LIKE");
    }
    expect(await reader.read(user, at)).toEqual(none);
    const sunset = await record(user, "想看日落", { text: "想看日落，想看江景" });
    const river = await record(user, "想看江景");
    await pool.query("UPDATE life_object_sources SET source_id=$1 WHERE life_object_id=$2", [
      sunset.capture,
      river.id,
    ]);
    await pool.query("UPDATE life_object_facets SET origin_id=$1 WHERE id=$2", [
      sunset.capture,
      river.facet,
    ]);
    await vote(user, sunset.id, "LIKE");
    await vote(user, river.id, "LIKE");
    expect(await reader.read(user, at)).toEqual(none);
  });
  it("uses completed DO actions, excludes preparation, skipped/no-time and stale feedback", async () => {
    const user = await owner(),
      sunset = await record(user, "想看日落"),
      river = await record(user, "想看江景");
    await behavior(user, sunset.id, "COMPLETE");
    await behavior(user, river.id, "COMPLETE", undefined, "PREPARE");
    await behavior(user, river.id, "SKIP");
    await behavior(user, river.id, "REJECT", "NO_TIME");
    await behavior(user, river.id, "COMPLETE", undefined, "DO", new Date("2025-01-01"));
    expect(await reader.read(user, at)).toEqual(none);
    await behavior(user, river.id, "COMPLETE");
    expect(await reader.read(user, at)).toEqual({ preferScenicBus: true, source: "LEARNED" });
    await behavior(
      user,
      river.id,
      "REJECT",
      "NOT_INTERESTED",
      "DO",
      new Date(later.getTime() + 1000),
    );
    expect(await reader.read(user, at)).toEqual(none);
  });
  it("withdrawal and expiration cancel only that object; an independent dislike offsets positives", async () => {
    for (const rating of ["NONE", "DISLIKE", "EXPIRED"]) {
      const user = await owner(),
        sunset = await record(user, "想看日落"),
        river = await record(user, "想看江景");
      await vote(user, sunset.id, "LIKE", earlier);
      await vote(user, river.id, "LIKE", earlier);
      const recent = await record(user, "想去海边看日落");
      await behavior(user, recent.id, "COMPLETE", undefined, "DO", earlier);
      await vote(
        user,
        recent.id,
        rating === "EXPIRED" ? "LIKE" : rating,
        later,
        rating === "EXPIRED" ? later : undefined,
      );
      expect(await reader.read(user, at)).toEqual(
        rating === "DISLIKE" ? none : { preferScenicBus: true, source: "LEARNED" },
      );
    }
  });
  it("a withdrawal blocks old completion on that card but preserves other same-theme likes", async () => {
    const user = await owner();
    const objects = [];
    for (const text of ["想去东边看海", "想去西边看海", "想去南边看海"]) {
      const object = await record(user, text);
      objects.push(object);
      await vote(user, object.id, "LIKE", earlier);
    }
    await behavior(user, objects[0]!.id, "COMPLETE", undefined, "DO", earlier);
    await vote(user, objects[0]!.id, "NONE", later);
    expect(await reader.read(user, at)).toEqual({ preferScenicBus: true, source: "LEARNED" });
    await vote(user, objects[1]!.id, "NONE", later);
    expect(await reader.read(user, at)).toEqual(none);
  });
  it("does not multiply a single card through repeated facets or feedback", async () => {
    const user = await owner(),
      object = await record(user, "想看日落");
    await pool.query(
      `INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,data,
      confidence,origin_type,origin_id,created_at)
      SELECT gen_random_uuid(),user_id,life_object_id,facet_type,'duplicate',data,confidence,origin_type,
      origin_id,created_at FROM life_object_facets WHERE id=$1`,
      [object.facet],
    );
    await vote(user, object.id, "LIKE");
    await behavior(user, object.id, "COMPLETE");
    await behavior(user, object.id, "COMPLETE");
    expect(await reader.read(user, at)).toEqual(none);
  });
  it("does not learn outdoor interest from movies or remote media about scenery", async () => {
    const user = await owner();
    for (const [text, kind] of [
      ["想看海边风景的视频", "DESIRE"],
      ["想看日落", "MEDIA"],
    ]) {
      const object = await record(user, text!, { kind: kind! });
      await vote(user, object.id, "LIKE");
    }
    expect(await reader.read(user, at)).toEqual(none);
  });
  it("bounds relevant evidence conservatively while retaining the newest explicit negation", async () => {
    const user = await owner(),
      object = await record(user, "想看日落");
    const river = await record(user, "想看江景");
    await vote(user, object.id, "LIKE");
    await vote(user, river.id, "LIKE");
    await pool.query(
      `INSERT INTO life_object_facets(id,user_id,life_object_id,facet_type,facet_key,data,
      confidence,origin_type,origin_id,created_at)
      SELECT gen_random_uuid(),f.user_id,f.life_object_id,f.facet_type,'bounded-'||n,f.data,
      f.confidence,f.origin_type,f.origin_id,f.created_at FROM life_object_facets f CROSS JOIN
      generate_series(1,2000) n WHERE f.id=$1`,
      [object.facet],
    );
    expect(await reader.read(user, at)).toEqual(none);
    await record(user, "我不坐公交", { date: later });
    expect(await reader.read(user, at)).toEqual({ preferScenicBus: false, source: "EXPLICIT" });
  });
  it("net negative theme evidence offsets positives and future ratings do not leak into a decision", async () => {
    const user = await owner();
    for (const [text, rating] of [
      ["想看日落", "LIKE"],
      ["想看江景", "LIKE"],
      ["想看山景", "DISLIKE"],
    ]) {
      const object = await record(user, text!);
      await vote(user, object.id, rating!);
    }
    expect(await reader.read(user, at)).toEqual(none);
    const sea = await record(user, "想看海");
    await vote(user, sea.id, "LIKE", new Date(at.getTime() + 1000));
    expect(await reader.read(user, at)).toEqual(none);
    expect(await reader.read(user, new Date(at.getTime() + 2000))).toEqual({
      preferScenicBus: true,
      source: "LEARNED",
    });
  });
});
