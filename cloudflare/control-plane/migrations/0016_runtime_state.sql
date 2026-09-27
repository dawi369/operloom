CREATE TABLE control_state_records (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, namespace TEXT NOT NULL,
  kind TEXT NOT NULL, record_key TEXT NOT NULL, schema_version INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0), data_json TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(scope_id, namespace, kind, record_key)
);
CREATE INDEX idx_state_records_scope ON control_state_records(scope_id, namespace, kind, record_key);
CREATE TABLE control_state_commits (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT state_precondition CHECK(preconditions_met = 1),
  UNIQUE(scope_id, idempotency_key)
);
CREATE TABLE control_state_entries (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, entry_key TEXT NOT NULL,
  commit_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('decision', 'effect')),
  data_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(scope_id, entry_key)
);
CREATE TABLE control_state_outbox (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, event_key TEXT NOT NULL,
  commit_id TEXT NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, delivered_at TEXT, UNIQUE(scope_id, event_key)
);

CREATE TABLE control_state_indexes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, namespace TEXT NOT NULL,
  kind TEXT NOT NULL, record_key TEXT NOT NULL, index_name TEXT NOT NULL, value_json TEXT NOT NULL,
  UNIQUE(scope_id, namespace, kind, record_key, index_name)
);
CREATE INDEX idx_state_index_lookup ON control_state_indexes(scope_id, namespace, kind, index_name, value_json, record_key);

CREATE TRIGGER export_fence_control_state_records_insert
BEFORE INSERT ON control_state_records
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_records_update
BEFORE UPDATE ON control_state_records
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_records_delete
BEFORE DELETE ON control_state_records
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_commits_insert
BEFORE INSERT ON control_state_commits
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_commits_update
BEFORE UPDATE ON control_state_commits
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_commits_delete
BEFORE DELETE ON control_state_commits
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_entries_insert
BEFORE INSERT ON control_state_entries
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_entries_update
BEFORE UPDATE ON control_state_entries
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_entries_delete
BEFORE DELETE ON control_state_entries
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_outbox_insert
BEFORE INSERT ON control_state_outbox
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_outbox_update
BEFORE UPDATE ON control_state_outbox
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_outbox_delete
BEFORE DELETE ON control_state_outbox
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_indexes_insert
BEFORE INSERT ON control_state_indexes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_indexes_update
BEFORE UPDATE ON control_state_indexes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_indexes_delete
BEFORE DELETE ON control_state_indexes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
