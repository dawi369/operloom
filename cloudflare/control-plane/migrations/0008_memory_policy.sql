-- Memory records gain expiry, a subject target, workspace sharing and content flags.
ALTER TABLE control_memory_records ADD COLUMN expires_at TEXT;
ALTER TABLE control_memory_records ADD COLUMN target_type TEXT;
ALTER TABLE control_memory_records ADD COLUMN target_id TEXT;
ALTER TABLE control_memory_records ADD COLUMN shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1));
ALTER TABLE control_memory_records ADD COLUMN flags_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX idx_control_memory_records_expiry
  ON control_memory_records (expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX idx_control_memory_records_target
  ON control_memory_records (workspace_id, target_type, target_id) WHERE target_id IS NOT NULL;

-- Shared records are unique per workspace regardless of author.
CREATE UNIQUE INDEX idx_control_memory_records_shared_key
  ON control_memory_records (workspace_id, kind, key, COALESCE(agent_id, '')) WHERE shared = 1;
