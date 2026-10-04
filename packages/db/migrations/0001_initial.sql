CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_status AS ENUM ('ACTIVE','DELETING','DELETED');
CREATE TYPE capture_type AS ENUM ('TEXT','IMAGE','VOICE','URL','FILE','FUTURE_CONNECTOR');
CREATE TYPE capture_status AS ENUM ('UPLOADED','PROCESSING','READY','NEEDS_REVIEW','FAILED','DELETED');
CREATE TYPE life_status AS ENUM ('ACTIVE','RESOLVED','ARCHIVED','DELETED');
CREATE TYPE source_type AS ENUM ('CAPTURE','USER','CONNECTOR','MODEL','INFERENCE','SYSTEM');
CREATE TYPE decision_status AS ENUM ('BUILDING','NEEDS_ANSWER','RECOMMENDED','QUIET','FAILED','CLOSED');
CREATE TYPE outbox_status AS ENUM ('PENDING','PROCESSING','RETRY','DONE','FAILED');

CREATE TABLE users (
  id uuid PRIMARY KEY, status user_status NOT NULL DEFAULT 'ACTIVE', locale varchar(24) NOT NULL DEFAULT 'zh-CN',
  timezone varchar(64) NOT NULL DEFAULT 'Asia/Shanghai', onboarding_version integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, recommendation_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  privacy_settings jsonb NOT NULL DEFAULT '{}'::jsonb, notification_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention_settings jsonb NOT NULL DEFAULT '{}'::jsonb, schema_version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_identities (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider varchar(32) NOT NULL,
  provider_subject varchar(191) NOT NULL, union_subject varchar(191), created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_identities_provider_subject_uq UNIQUE(provider, provider_subject)
);
CREATE INDEX user_identities_user_idx ON user_identities(user_id);
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, refresh_token_hash varchar(64) NOT NULL UNIQUE,
  client_installation_id varchar(128), created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE TABLE captures (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, capture_type capture_type NOT NULL,
  source_channel varchar(32) NOT NULL, status capture_status NOT NULL DEFAULT 'UPLOADED', text_content text, source_url text,
  language varchar(16), pipeline_version varchar(48) NOT NULL DEFAULT 'capture-v0.1',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX captures_user_created_idx ON captures(user_id, created_at DESC);
CREATE INDEX captures_user_status_idx ON captures(user_id, status);
CREATE TABLE capture_assets (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, capture_id uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  asset_type varchar(32) NOT NULL, storage_key text NOT NULL, normalized_storage_key text, mime_type varchar(128) NOT NULL,
  size_bytes integer NOT NULL CHECK(size_bytes >= 0), sha256 varchar(64) NOT NULL, width integer, height integer,
  duration_seconds integer, sensitivity_level varchar(24) NOT NULL DEFAULT 'NORMAL', retain_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX capture_assets_user_capture_idx ON capture_assets(user_id, capture_id);
CREATE TABLE life_objects (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, title varchar(240) NOT NULL,
  summary text, status life_status NOT NULL DEFAULT 'ACTIVE', kind varchar(32) NOT NULL, importance_score double precision,
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), last_acted_at timestamptz,
  object_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX life_objects_user_status_updated_idx ON life_objects(user_id, status, updated_at DESC);
CREATE TABLE life_object_facets (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, life_object_id uuid NOT NULL REFERENCES life_objects(id) ON DELETE CASCADE,
  facet_type varchar(32) NOT NULL, facet_key varchar(96) NOT NULL, schema_version integer NOT NULL DEFAULT 1, data jsonb NOT NULL,
  confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1), origin_type varchar(24) NOT NULL, origin_id uuid,
  valid_from timestamptz, valid_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX life_object_facets_user_object_idx ON life_object_facets(user_id, life_object_id);
CREATE TABLE life_object_relations (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, from_object_id uuid NOT NULL REFERENCES life_objects(id) ON DELETE CASCADE,
  relation_type varchar(32) NOT NULL, to_object_id uuid NOT NULL REFERENCES life_objects(id) ON DELETE CASCADE,
  confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1), origin_type varchar(24) NOT NULL, origin_id uuid,
  valid_from timestamptz, valid_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX life_object_relations_user_from_idx ON life_object_relations(user_id, from_object_id);
CREATE TABLE life_object_sources (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, life_object_id uuid NOT NULL REFERENCES life_objects(id) ON DELETE CASCADE,
  source_type source_type NOT NULL, source_id uuid NOT NULL, is_primary boolean NOT NULL DEFAULT false,
  confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1), evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT life_object_sources_unique_uq UNIQUE(user_id, life_object_id, source_type, source_id)
);
CREATE INDEX life_object_sources_user_source_idx ON life_object_sources(user_id, source_id);
CREATE TABLE life_object_projection (
  life_object_id uuid PRIMARY KEY REFERENCES life_objects(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_kind varchar(32), next_at timestamptz, expires_at timestamptz, cost_min_minor integer, cost_max_minor integer,
  currency varchar(3), duration_min_seconds integer, duration_max_seconds integer, latitude double precision, longitude double precision,
  coordinate_system varchar(16), desire_score double precision, importance_score double precision, actionability_score double precision,
  last_used_at timestamptz, search_text text NOT NULL, projection_version varchar(48) NOT NULL, rebuilt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX life_projection_user_kind_idx ON life_object_projection(user_id, display_kind);
CREATE TABLE decision_sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, status decision_status NOT NULL DEFAULT 'BUILDING',
  scoring_version varchar(48) NOT NULL, question_policy_version varchar(48) NOT NULL, intervention_score double precision,
  context_summary jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, closed_at timestamptz
);
CREATE INDEX decision_sessions_user_created_idx ON decision_sessions(user_id, created_at DESC);
CREATE TABLE context_snapshots (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, decision_session_id uuid NOT NULL REFERENCES decision_sessions(id) ON DELETE CASCADE,
  context_schema_version integer NOT NULL DEFAULT 1, context jsonb NOT NULL, contains_precise_location boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), purge_at timestamptz
);
CREATE TABLE action_candidates (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, decision_session_id uuid NOT NULL REFERENCES decision_sessions(id) ON DELETE CASCADE,
  target_life_object_id uuid REFERENCES life_objects(id) ON DELETE SET NULL, action_type varchar(32) NOT NULL, action_payload jsonb NOT NULL,
  value_score double precision NOT NULL, fit_score double precision NOT NULL, friction_score double precision NOT NULL,
  urgency_score double precision NOT NULL, uncertainty_score double precision NOT NULL, total_score double precision NOT NULL,
  hard_filter_status varchar(24) NOT NULL, hard_filter_reason varchar(64), rank integer, generator_version varchar(48) NOT NULL,
  scoring_version varchar(48) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_candidates_user_session_idx ON action_candidates(user_id, decision_session_id);
CREATE TABLE clarification_requests (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope_type varchar(16) NOT NULL,
  capture_id uuid REFERENCES captures(id) ON DELETE CASCADE, decision_session_id uuid REFERENCES decision_sessions(id) ON DELETE CASCADE,
  question_key varchar(96) NOT NULL, question_text text NOT NULL, options jsonb NOT NULL, information_gain double precision,
  sequence integer NOT NULL, status varchar(24) NOT NULL, answer jsonb, created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz
);
CREATE INDEX clarifications_user_session_idx ON clarification_requests(user_id, decision_session_id);
CREATE TABLE recommendations (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, decision_session_id uuid NOT NULL REFERENCES decision_sessions(id) ON DELETE CASCADE,
  action_candidate_id uuid NOT NULL REFERENCES action_candidates(id) ON DELETE CASCADE, headline text NOT NULL, body text, reason_text text,
  execution_type varchar(32) NOT NULL, execution_payload jsonb NOT NULL, copy_version varchar(48) NOT NULL,
  surfaced_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz
);
CREATE INDEX recommendations_user_session_idx ON recommendations(user_id, decision_session_id);
CREATE TABLE feedback_events (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, recommendation_id uuid NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  decision_session_id uuid NOT NULL REFERENCES decision_sessions(id) ON DELETE CASCADE, event_type varchar(24) NOT NULL,
  reason_code varchar(96), metadata jsonb, client_event_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feedback_events_client_event_uq UNIQUE(user_id, client_event_id)
);
CREATE INDEX feedback_events_user_created_idx ON feedback_events(user_id, created_at DESC);
CREATE TABLE preference_signals (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, dimension varchar(64) NOT NULL, value jsonb NOT NULL,
  polarity integer NOT NULL CHECK(polarity IN (-1, 1)), strength double precision NOT NULL CHECK(strength BETWEEN 0 AND 1),
  confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1), source_type varchar(32) NOT NULL, source_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL, half_life_days integer, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT preference_signals_source_uq UNIQUE(user_id, source_id)
);
CREATE INDEX preference_signals_user_dimension_idx ON preference_signals(user_id, dimension);
CREATE TABLE preference_state (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, profile jsonb NOT NULL, profile_version integer NOT NULL DEFAULT 1, rebuilt_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE CASCADE, purpose varchar(32) NOT NULL, entity_type varchar(32) NOT NULL,
  entity_id uuid NOT NULL, pipeline_version varchar(48) NOT NULL, status varchar(24) NOT NULL, result jsonb,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, error_code varchar(64), trace_id uuid NOT NULL
);
CREATE INDEX agent_runs_user_started_idx ON agent_runs(user_id, started_at DESC);
CREATE TABLE model_calls (
  id uuid PRIMARY KEY, agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, provider varchar(48) NOT NULL,
  model varchar(96) NOT NULL, prompt_name varchar(64) NOT NULL, prompt_version varchar(32) NOT NULL, schema_version varchar(32) NOT NULL,
  input_hash varchar(64) NOT NULL, status varchar(24) NOT NULL, structured_output jsonb, input_tokens integer, output_tokens integer,
  latency_ms integer NOT NULL, provider_request_id varchar(128), error_code varchar(64), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY, aggregate_type varchar(32) NOT NULL, aggregate_id uuid NOT NULL, event_type varchar(64) NOT NULL,
  payload jsonb NOT NULL, status outbox_status NOT NULL DEFAULT 'PENDING', available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0, locked_at timestamptz, locked_by varchar(128), last_error varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE INDEX outbox_claim_idx ON outbox_events(status, available_at, created_at);
CREATE INDEX outbox_aggregate_idx ON outbox_events(aggregate_type, aggregate_id);
CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, route varchar(160) NOT NULL, idempotency_key uuid NOT NULL,
  request_hash varchar(64) NOT NULL, response_status integer, response_body jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, CONSTRAINT idempotency_keys_pk PRIMARY KEY(user_id, route, idempotency_key)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys(expires_at);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY, actor_type varchar(24) NOT NULL, actor_id uuid, action varchar(64) NOT NULL,
  target_type varchar(32) NOT NULL, target_id uuid, metadata jsonb NOT NULL, trace_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
