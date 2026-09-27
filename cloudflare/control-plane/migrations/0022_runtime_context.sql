-- Context snapshots are canonical evidence, not executable handlers or model reasoning.
CREATE TABLE control_context_snapshots (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL, run_kind TEXT NOT NULL CHECK(run_kind IN ('workflow','chat')),
  agent_revision INTEGER NOT NULL, pack_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ready','blocked')), created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT context_snapshot_precondition CHECK(preconditions_met = 1),
  UNIQUE(user_id,workspace_id,agent_id,run_kind,run_id)
);
CREATE INDEX idx_context_snapshot_scope ON control_context_snapshots(user_id,workspace_id,agent_id,id);
CREATE TRIGGER immutable_control_context_snapshots BEFORE UPDATE ON control_context_snapshots
BEGIN SELECT RAISE(ABORT, 'context_snapshot_immutable'); END;

CREATE TRIGGER export_fence_control_context_snapshots_insert BEFORE INSERT ON control_context_snapshots
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_context_snapshots_update BEFORE UPDATE ON control_context_snapshots
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_context_snapshots_delete BEFORE DELETE ON control_context_snapshots
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
