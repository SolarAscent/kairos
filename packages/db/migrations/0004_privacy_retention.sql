ALTER TABLE users ADD COLUMN last_active_at timestamptz NOT NULL DEFAULT now();
-- Preserve existing evidence of use; applying a migration must not reset the clock.
UPDATE users u SET last_active_at = GREATEST(u.created_at, u.updated_at,
  COALESCE((SELECT max(GREATEST(s.created_at,s.last_seen_at)) FROM auth_sessions s WHERE s.user_id=u.id),u.created_at),
  COALESCE((SELECT max(c.created_at) FROM captures c WHERE c.user_id=u.id),u.created_at),
  COALESCE((SELECT max(d.created_at) FROM decision_sessions d WHERE d.user_id=u.id),u.created_at));
CREATE INDEX users_last_active_idx ON users(last_active_at);
CREATE INDEX captures_retention_idx ON captures(created_at);
CREATE INDEX life_objects_retention_idx ON life_objects(created_at);
CREATE INDEX decision_sessions_retention_idx ON decision_sessions(created_at);
CREATE INDEX context_snapshots_purge_idx ON context_snapshots(purge_at);
CREATE INDEX agent_runs_retention_idx ON agent_runs(started_at);
CREATE INDEX audit_events_retention_idx ON audit_events(created_at);
CREATE INDEX outbox_retention_idx ON outbox_events(created_at);
