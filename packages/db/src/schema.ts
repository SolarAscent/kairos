import { sql } from "drizzle-orm";
import {
  captureTypeSchema,
  captureStatusSchema,
  lifeStatusSchema,
  sourceTypeSchema,
  decisionStatusSchema,
} from "@life/contracts";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const json = (name: string) => jsonb(name).$type<Record<string, unknown>>();
const id = () => uuid("id").primaryKey();

export const userStatusEnum = pgEnum("user_status", ["ACTIVE", "DELETING", "DELETED"]);
export const captureTypeEnum = pgEnum("capture_type", captureTypeSchema.enum);
export const captureStatusEnum = pgEnum("capture_status", captureStatusSchema.enum);
export const lifeStatusEnum = pgEnum("life_status", lifeStatusSchema.enum);
export const sourceTypeEnum = pgEnum("source_type", sourceTypeSchema.enum);
export const decisionStatusEnum = pgEnum("decision_status", decisionStatusSchema.enum);
export const outboxStatusEnum = pgEnum("outbox_status", [
  "PENDING",
  "PROCESSING",
  "RETRY",
  "DONE",
  "FAILED",
]);

export const users = pgTable("users", {
  id: id(),
  nickname: varchar("nickname", { length: 32 }),
  bio: varchar("bio", { length: 160 }).notNull().default(""),
  avatarVersion: uuid("avatar_version"),
  avatarMimeType: varchar("avatar_mime_type", { length: 32 }),
  avatarBase64: text("avatar_base64"),
  status: userStatusEnum("status").notNull().default("ACTIVE"),
  locale: varchar("locale", { length: 24 }).notNull().default("zh-CN"),
  timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Shanghai"),
  onboardingVersion: integer("onboarding_version"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
});

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  recommendationSettings: json("recommendation_settings").notNull().default({}),
  privacySettings: json("privacy_settings").notNull().default({}),
  notificationSettings: json("notification_settings").notNull().default({}),
  retentionSettings: json("retention_settings").notNull().default({}),
  schemaVersion: integer("schema_version").notNull().default(1),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const userIdentities = pgTable(
  "user_identities",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 32 }).notNull(),
    providerSubject: varchar("provider_subject", { length: 191 }).notNull(),
    unionSubject: varchar("union_subject", { length: 191 }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("user_identities_provider_subject_uq").on(t.provider, t.providerSubject),
    index("user_identities_user_idx").on(t.userId),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: varchar("refresh_token_hash", { length: 64 }).notNull(),
    clientInstallationId: varchar("client_installation_id", { length: 128 }),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    unique("auth_sessions_refresh_token_hash_key").on(t.refreshTokenHash),
    index("auth_sessions_user_idx").on(t.userId),
  ],
);

export const captures = pgTable(
  "captures",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    captureType: captureTypeEnum("capture_type").notNull(),
    sourceChannel: varchar("source_channel", { length: 32 }).notNull(),
    status: captureStatusEnum("status").notNull().default("UPLOADED"),
    textContent: text("text_content"),
    sourceUrl: text("source_url"),
    language: varchar("language", { length: 16 }),
    pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull().default("capture-v0.2"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    index("captures_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("captures_user_status_idx").on(t.userId, t.status),
  ],
);

export const captureAssets = pgTable(
  "capture_assets",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    captureId: uuid("capture_id")
      .notNull()
      .references(() => captures.id, { onDelete: "cascade" }),
    assetType: varchar("asset_type", { length: 32 }).notNull(),
    storageKey: text("storage_key").notNull(),
    normalizedStorageKey: text("normalized_storage_key"),
    mimeType: varchar("mime_type", { length: 128 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: integer("duration_seconds"),
    sensitivityLevel: varchar("sensitivity_level", { length: 24 }).notNull().default("NORMAL"),
    retainUntil: ts("retain_until"),
    createdAt: ts("created_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    check("capture_assets_size_bytes_check", sql`${t.sizeBytes} >= 0`),
    index("capture_assets_user_capture_idx").on(t.userId, t.captureId),
  ],
);

export const lifeObjects = pgTable(
  "life_objects",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 240 }).notNull(),
    summary: text("summary"),
    status: lifeStatusEnum("status").notNull().default("ACTIVE"),
    kind: varchar("kind", { length: 32 }).notNull(),
    importanceScore: doublePrecision("importance_score"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    lastActedAt: ts("last_acted_at"),
    objectVersion: integer("object_version").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("life_objects_user_status_updated_idx").on(t.userId, t.status, t.updatedAt.desc())],
);

export const lifeObjectFacets = pgTable(
  "life_object_facets",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lifeObjectId: uuid("life_object_id")
      .notNull()
      .references(() => lifeObjects.id, { onDelete: "cascade" }),
    facetType: varchar("facet_type", { length: 32 }).notNull(),
    facetKey: varchar("facet_key", { length: 96 }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    data: json("data").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    originType: varchar("origin_type", { length: 24 }).notNull(),
    originId: uuid("origin_id"),
    validFrom: ts("valid_from"),
    validUntil: ts("valid_until"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    check("life_object_facets_confidence_check", sql`${t.confidence} BETWEEN 0 AND 1`),
    index("life_object_facets_user_object_idx").on(t.userId, t.lifeObjectId),
  ],
);

export const lifeObjectRelations = pgTable(
  "life_object_relations",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fromObjectId: uuid("from_object_id")
      .notNull()
      .references(() => lifeObjects.id, { onDelete: "cascade" }),
    relationType: varchar("relation_type", { length: 32 }).notNull(),
    toObjectId: uuid("to_object_id")
      .notNull()
      .references(() => lifeObjects.id, { onDelete: "cascade" }),
    confidence: doublePrecision("confidence").notNull(),
    originType: varchar("origin_type", { length: 24 }).notNull(),
    originId: uuid("origin_id"),
    validFrom: ts("valid_from"),
    validUntil: ts("valid_until"),
    createdAt: ts("created_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    check("life_object_relations_confidence_check", sql`${t.confidence} BETWEEN 0 AND 1`),
    index("life_object_relations_user_from_idx").on(t.userId, t.fromObjectId),
  ],
);

export const lifeObjectSources = pgTable(
  "life_object_sources",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lifeObjectId: uuid("life_object_id")
      .notNull()
      .references(() => lifeObjects.id, { onDelete: "cascade" }),
    sourceType: sourceTypeEnum("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    confidence: doublePrecision("confidence").notNull(),
    evidence: json("evidence"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("life_object_sources_confidence_check", sql`${t.confidence} BETWEEN 0 AND 1`),
    unique("life_object_sources_unique_uq").on(t.userId, t.lifeObjectId, t.sourceType, t.sourceId),
    index("life_object_sources_user_source_idx").on(t.userId, t.sourceId),
  ],
);

export const lifeObjectProjection = pgTable(
  "life_object_projection",
  {
    lifeObjectId: uuid("life_object_id")
      .primaryKey()
      .references(() => lifeObjects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayKind: varchar("display_kind", { length: 32 }),
    nextAt: ts("next_at"),
    expiresAt: ts("expires_at"),
    costMinMinor: integer("cost_min_minor"),
    costMaxMinor: integer("cost_max_minor"),
    currency: varchar("currency", { length: 3 }),
    durationMinSeconds: integer("duration_min_seconds"),
    durationMaxSeconds: integer("duration_max_seconds"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    coordinateSystem: varchar("coordinate_system", { length: 16 }),
    desireScore: doublePrecision("desire_score"),
    importanceScore: doublePrecision("importance_score"),
    actionabilityScore: doublePrecision("actionability_score"),
    lastUsedAt: ts("last_used_at"),
    searchText: text("search_text").notNull(),
    projectionVersion: varchar("projection_version", { length: 48 }).notNull(),
    rebuiltAt: ts("rebuilt_at").notNull().defaultNow(),
  },
  (t) => [index("life_projection_user_kind_idx").on(t.userId, t.displayKind)],
);

export const decisionSessions = pgTable(
  "decision_sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: decisionStatusEnum("status").notNull().default("BUILDING"),
    scoringVersion: varchar("scoring_version", { length: 48 }).notNull(),
    questionPolicyVersion: varchar("question_policy_version", { length: 48 }).notNull(),
    interventionScore: doublePrecision("intervention_score"),
    contextSummary: json("context_summary").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    closedAt: ts("closed_at"),
  },
  (t) => [index("decision_sessions_user_created_idx").on(t.userId, t.createdAt.desc())],
);

export const contextSnapshots = pgTable("context_snapshots", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  decisionSessionId: uuid("decision_session_id")
    .notNull()
    .references(() => decisionSessions.id, { onDelete: "cascade" }),
  contextSchemaVersion: integer("context_schema_version").notNull().default(1),
  context: json("context").notNull(),
  containsPreciseLocation: boolean("contains_precise_location").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  purgeAt: ts("purge_at"),
});

export const actionCandidates = pgTable(
  "action_candidates",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    decisionSessionId: uuid("decision_session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    targetLifeObjectId: uuid("target_life_object_id").references(() => lifeObjects.id, {
      onDelete: "set null",
    }),
    actionType: varchar("action_type", { length: 32 }).notNull(),
    actionPayload: json("action_payload").notNull(),
    valueScore: doublePrecision("value_score").notNull(),
    fitScore: doublePrecision("fit_score").notNull(),
    frictionScore: doublePrecision("friction_score").notNull(),
    urgencyScore: doublePrecision("urgency_score").notNull(),
    uncertaintyScore: doublePrecision("uncertainty_score").notNull(),
    totalScore: doublePrecision("total_score").notNull(),
    hardFilterStatus: varchar("hard_filter_status", { length: 24 }).notNull(),
    hardFilterReason: varchar("hard_filter_reason", { length: 64 }),
    rank: integer("rank"),
    generatorVersion: varchar("generator_version", { length: 48 }).notNull(),
    scoringVersion: varchar("scoring_version", { length: 48 }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("action_candidates_user_session_idx").on(t.userId, t.decisionSessionId)],
);

export const clarificationRequests = pgTable(
  "clarification_requests",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", { length: 16 }).notNull(),
    captureId: uuid("capture_id").references(() => captures.id, { onDelete: "cascade" }),
    decisionSessionId: uuid("decision_session_id").references(() => decisionSessions.id, {
      onDelete: "cascade",
    }),
    questionKey: varchar("question_key", { length: 96 }).notNull(),
    questionText: text("question_text").notNull(),
    options: json("options").notNull(),
    informationGain: doublePrecision("information_gain"),
    sequence: integer("sequence").notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    answer: json("answer"),
    createdAt: ts("created_at").notNull().defaultNow(),
    answeredAt: ts("answered_at"),
  },
  (t) => [index("clarifications_user_session_idx").on(t.userId, t.decisionSessionId)],
);

export const recommendations = pgTable(
  "recommendations",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    decisionSessionId: uuid("decision_session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    actionCandidateId: uuid("action_candidate_id")
      .notNull()
      .references(() => actionCandidates.id, { onDelete: "cascade" }),
    headline: text("headline").notNull(),
    body: text("body"),
    reasonText: text("reason_text"),
    executionType: varchar("execution_type", { length: 32 }).notNull(),
    executionPayload: json("execution_payload").notNull(),
    copyVersion: varchar("copy_version", { length: 48 }).notNull(),
    surfacedAt: ts("surfaced_at").notNull().defaultNow(),
    expiresAt: ts("expires_at"),
  },
  (t) => [index("recommendations_user_session_idx").on(t.userId, t.decisionSessionId)],
);

export const feedbackEvents = pgTable(
  "feedback_events",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id, { onDelete: "cascade" }),
    decisionSessionId: uuid("decision_session_id")
      .notNull()
      .references(() => decisionSessions.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 24 }).notNull(),
    reasonCode: varchar("reason_code", { length: 96 }),
    metadata: json("metadata"),
    clientEventId: uuid("client_event_id").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("feedback_events_client_event_uq").on(t.userId, t.clientEventId),
    index("feedback_events_user_created_idx").on(t.userId, t.createdAt.desc()),
  ],
);

export const preferenceSignals = pgTable(
  "preference_signals",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dimension: varchar("dimension", { length: 64 }).notNull(),
    value: json("value").notNull(),
    polarity: integer("polarity").notNull(),
    strength: doublePrecision("strength").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    sourceId: uuid("source_id").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    halfLifeDays: integer("half_life_days"),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("preference_signals_polarity_check", sql`${t.polarity} IN (-1, 1)`),
    check("preference_signals_strength_check", sql`${t.strength} BETWEEN 0 AND 1`),
    check("preference_signals_confidence_check", sql`${t.confidence} BETWEEN 0 AND 1`),
    unique("preference_signals_source_uq").on(t.userId, t.sourceId),
    index("preference_signals_user_dimension_idx").on(t.userId, t.dimension),
  ],
);

export const preferenceState = pgTable("preference_state", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  profile: json("profile").notNull(),
  profileVersion: integer("profile_version").notNull().default(1),
  rebuiltAt: ts("rebuilt_at").notNull().defaultNow(),
});

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    purpose: varchar("purpose", { length: 32 }).notNull(),
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    result: json("result"),
    startedAt: ts("started_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
    errorCode: varchar("error_code", { length: 64 }),
    traceId: uuid("trace_id").notNull(),
  },
  (t) => [index("agent_runs_user_started_idx").on(t.userId, t.startedAt.desc())],
);

export const modelCalls = pgTable("model_calls", {
  id: id(),
  agentRunId: uuid("agent_run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 48 }).notNull(),
  model: varchar("model", { length: 96 }).notNull(),
  promptName: varchar("prompt_name", { length: 64 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 32 }).notNull(),
  schemaVersion: varchar("schema_version", { length: 32 }).notNull(),
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  status: varchar("status", { length: 24 }).notNull(),
  structuredOutput: json("structured_output"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  latencyMs: integer("latency_ms").notNull(),
  providerRequestId: varchar("provider_request_id", { length: 128 }),
  errorCode: varchar("error_code", { length: 64 }),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: id(),
    aggregateType: varchar("aggregate_type", { length: 32 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    payload: json("payload").notNull(),
    status: outboxStatusEnum("status").notNull().default("PENDING"),
    availableAt: ts("available_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lockedAt: ts("locked_at"),
    lockedBy: varchar("locked_by", { length: 128 }),
    lastError: varchar("last_error", { length: 128 }),
    createdAt: ts("created_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
  },
  (t) => [
    index("outbox_claim_idx").on(t.status, t.availableAt, t.createdAt),
    index("outbox_aggregate_idx").on(t.aggregateType, t.aggregateId),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    route: varchar("route", { length: 160 }).notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    responseStatus: integer("response_status"),
    responseBody: json("response_body"),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.route, t.idempotencyKey], name: "idempotency_keys_pk" }),
    index("idempotency_keys_expires_idx").on(t.expiresAt),
  ],
);

export const auditEvents = pgTable("audit_events", {
  id: id(),
  actorType: varchar("actor_type", { length: 24 }).notNull(),
  actorId: uuid("actor_id"),
  action: varchar("action", { length: 64 }).notNull(),
  targetType: varchar("target_type", { length: 32 }).notNull(),
  targetId: uuid("target_id"),
  metadata: json("metadata").notNull(),
  traceId: uuid("trace_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});
