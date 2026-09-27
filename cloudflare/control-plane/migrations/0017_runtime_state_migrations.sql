-- D1 remains the sole state authority. Durable migration cursors and receipts are
-- required because a request deadline cannot migrate an unbounded record set.
CREATE TABLE control_state_schema_heads (
  scope_id TEXT NOT NULL, namespace TEXT NOT NULL, kind TEXT NOT NULL,
  user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','migrating')),
  migration_id TEXT NOT NULL, PRIMARY KEY(scope_id, namespace, kind)
);
CREATE TABLE control_state_migrations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  scope_id TEXT NOT NULL, migration_key TEXT NOT NULL, plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
  namespace TEXT NOT NULL, kind TEXT NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed')), revision INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0, after_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT state_migration_precondition CHECK(preconditions_met = 1),
  UNIQUE(scope_id, migration_key)
);
CREATE TABLE control_state_migration_steps (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  migration_id TEXT NOT NULL, expected_revision INTEGER NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT state_migration_step_precondition CHECK(preconditions_met = 1),
  UNIQUE(migration_id, expected_revision)
);

CREATE TRIGGER export_fence_control_state_schema_heads_insert
BEFORE INSERT ON control_state_schema_heads
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_schema_heads_update
BEFORE UPDATE ON control_state_schema_heads
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_schema_heads_delete
BEFORE DELETE ON control_state_schema_heads
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migrations_insert
BEFORE INSERT ON control_state_migrations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migrations_update
BEFORE UPDATE ON control_state_migrations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migrations_delete
BEFORE DELETE ON control_state_migrations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migration_steps_insert
BEFORE INSERT ON control_state_migration_steps
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migration_steps_update
BEFORE UPDATE ON control_state_migration_steps
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migration_steps_delete
BEFORE DELETE ON control_state_migration_steps
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
