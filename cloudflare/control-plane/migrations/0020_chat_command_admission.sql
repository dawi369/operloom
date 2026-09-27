CREATE TABLE control_chat_commands (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  thread_id TEXT NOT NULL, instance_name TEXT NOT NULL, turn_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL, agent_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
  run_id TEXT UNIQUE, error_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, accepted_at TEXT, expires_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT chat_command_precondition CHECK (preconditions_met = 1),
  UNIQUE(user_id, workspace_id, thread_id, turn_id)
);
CREATE UNIQUE INDEX idx_chat_commands_active_thread ON control_chat_commands(user_id,workspace_id,thread_id) WHERE status IN ('pending','running');
CREATE INDEX idx_chat_commands_deadline ON control_chat_commands(status, expires_at, id);
CREATE INDEX idx_chat_commands_agent ON control_chat_commands(workspace_id, agent_id, status);
CREATE INDEX idx_chat_commands_instance ON control_chat_commands(instance_name, status);

CREATE TRIGGER export_fence_control_chat_commands_insert BEFORE INSERT ON control_chat_commands
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = NEW.workspace_id
 AND f.status = 'active' AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_chat_commands_update BEFORE UPDATE ON control_chat_commands
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = NEW.workspace_id
 AND f.status = 'active' AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_chat_commands_delete BEFORE DELETE ON control_chat_commands
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = OLD.workspace_id
 AND f.status = 'active' AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER agent_revision_pending_chat_commands BEFORE UPDATE OF runtime_revision ON agents
WHEN NEW.runtime_revision != OLD.runtime_revision AND EXISTS (
 SELECT 1 FROM control_chat_commands c WHERE c.workspace_id = OLD.workspace_id AND c.agent_id = OLD.id
 AND c.status IN ('pending','running'))
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_busy'); END;

CREATE TRIGGER chat_command_immutable BEFORE UPDATE ON control_chat_commands
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.agent_id IS NOT OLD.agent_id OR NEW.thread_id IS NOT OLD.thread_id
 OR NEW.instance_name IS NOT OLD.instance_name OR NEW.turn_id IS NOT OLD.turn_id
 OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.agent_revision IS NOT OLD.agent_revision
 OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT OLD.run_id)
 OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS NOT OLD.accepted_at)
 OR (OLD.status IN ('completed','failed','cancelled') AND NEW.status IS NOT OLD.status)
 OR (OLD.status = 'running' AND NEW.status = 'pending')
BEGIN SELECT RAISE(ABORT, 'chat_command_conflict'); END;

CREATE TRIGGER chat_command_run_admission BEFORE INSERT ON chat_runs
WHEN json_extract(NEW.metadata_json, '$.commandId') IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM control_chat_commands c WHERE c.id = json_extract(NEW.metadata_json, '$.commandId')
 AND c.user_id = NEW.user_id AND c.workspace_id = NEW.workspace_id AND c.agent_id = NEW.agent_id
 AND c.thread_id = NEW.thread_id AND c.agent_revision = COALESCE(json_extract(NEW.metadata_json, '$.agentRevision'),0)
 AND c.status = 'pending' AND c.accepted_at IS NOT NULL AND c.run_id IS NULL
 AND c.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND EXISTS (SELECT 1 FROM agents a JOIN workspaces w ON w.id = a.workspace_id
   JOIN memberships m ON m.workspace_id = w.id AND m.user_id = c.user_id
   JOIN users u ON u.id = m.user_id
   JOIN chat_threads t ON t.thread_id = c.thread_id AND t.user_id = c.user_id AND t.workspace_id = c.workspace_id AND t.agent_id = c.agent_id
   WHERE a.id = c.agent_id AND a.workspace_id = c.workspace_id AND a.runtime_revision = c.agent_revision
   AND a.status = 'active' AND w.status = 'active' AND m.status = 'active' AND u.status = 'active'
   AND t.status IN ('active','draft')))
BEGIN SELECT RAISE(ABORT, 'chat_command_conflict'); END;

CREATE TRIGGER chat_command_run_link AFTER INSERT ON chat_runs
WHEN json_extract(NEW.metadata_json, '$.commandId') IS NOT NULL
BEGIN UPDATE control_chat_commands SET status = 'running', run_id = NEW.id, updated_at = NEW.updated_at
 WHERE id = json_extract(NEW.metadata_json, '$.commandId'); END;

CREATE TRIGGER chat_command_run_pin BEFORE UPDATE ON chat_runs
WHEN json_extract(NEW.metadata_json, '$.commandId') IS NOT json_extract(OLD.metadata_json, '$.commandId')
BEGIN SELECT RAISE(ABORT, 'chat_command_conflict'); END;

CREATE TRIGGER chat_command_run_terminal AFTER UPDATE OF status ON chat_runs
WHEN NEW.status IN ('completed','failed','cancelled') AND NEW.status IS NOT OLD.status
BEGIN UPDATE control_chat_commands SET status = NEW.status, updated_at = NEW.updated_at,
 error_code = CASE WHEN NEW.status = 'failed' THEN COALESCE(json_extract(NEW.metadata_json, '$.errorCode'),'chat_execution_failed') ELSE error_code END
 WHERE run_id = NEW.id AND status IN ('pending','running'); END;

CREATE TRIGGER chat_command_event AFTER UPDATE ON control_chat_commands
WHEN NEW.status IS NOT OLD.status OR (NEW.accepted_at IS NOT NULL AND OLD.accepted_at IS NULL)
BEGIN INSERT INTO control_plane_events
 (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
 VALUES ('chat-command:' || NEW.id || ':' || NEW.status, NEW.user_id,NEW.workspace_id,NEW.agent_id,
 'chat.command.updated','Chat command ' || NEW.status,'chat_command',NEW.id,
 json_object('commandId',NEW.id,'threadId',NEW.thread_id,'messageId',NEW.turn_id,'status',NEW.status,'runId',NEW.run_id,'errorCode',NEW.error_code),NEW.updated_at)
 ON CONFLICT(id) DO NOTHING; END;
