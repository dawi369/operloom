-- Durable, user-scoped memory the model recalls on every turn; inspectable and deletable by the user.
CREATE TABLE control_memory_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('goal', 'preference', 'watchlist', 'conclusion', 'note')),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'model', 'workflow')),
  status TEXT NOT NULL CHECK (status IN ('active', 'proposed', 'archived')),
  run_id TEXT,
  thread_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_control_memory_records_key
  ON control_memory_records (user_id, workspace_id, kind, key, COALESCE(agent_id, ''));

CREATE INDEX idx_control_memory_records_recall
  ON control_memory_records (user_id, workspace_id, status, kind, updated_at);

CREATE TRIGGER export_fence_control_memory_records_insert
BEFORE INSERT ON control_memory_records
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_memory_records_update
BEFORE UPDATE ON control_memory_records
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id) AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_memory_records_delete
BEFORE DELETE ON control_memory_records
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
