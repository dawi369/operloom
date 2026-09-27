-- Keep every reviewed replacement plan and receipt; editing a running job alone
-- would lose provenance and could repeat a repair after a lost response.
CREATE TABLE control_state_migration_repairs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  migration_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  previous_plan_json TEXT NOT NULL, replacement_plan_json TEXT NOT NULL,
  expected_revision INTEGER NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT state_migration_repair_precondition CHECK(preconditions_met = 1),
  UNIQUE(migration_id, idempotency_key)
);

CREATE TRIGGER export_fence_control_state_migration_repairs_insert
BEFORE INSERT ON control_state_migration_repairs
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migration_repairs_update
BEFORE UPDATE ON control_state_migration_repairs
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migration_repairs_delete
BEFORE DELETE ON control_state_migration_repairs
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
