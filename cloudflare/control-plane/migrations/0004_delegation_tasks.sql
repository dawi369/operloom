CREATE TABLE control_delegation_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  root_run_id TEXT NOT NULL,
  requester_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_json TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired', 'cancelled')),
  depth INTEGER NOT NULL CHECK (depth >= 1),
  run_id TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT NOT NULL DEFAULT '{}',
  deadline_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (parent_run_id, idempotency_key)
);

CREATE INDEX idx_control_delegation_tasks_queue
  ON control_delegation_tasks (status, deadline_at, created_at);

CREATE INDEX idx_control_delegation_tasks_parent
  ON control_delegation_tasks (user_id, workspace_id, parent_run_id);

CREATE TRIGGER export_fence_control_delegation_tasks_insert
BEFORE INSERT ON control_delegation_tasks
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_delegation_tasks_update
BEFORE UPDATE ON control_delegation_tasks
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id) AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_delegation_tasks_delete
BEFORE DELETE ON control_delegation_tasks
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
