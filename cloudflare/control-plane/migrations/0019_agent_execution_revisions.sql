-- Execution generations are independent of mutable profile timestamps. Legacy
-- callers omit the pin and therefore belong to generation zero only.
ALTER TABLE agents ADD COLUMN runtime_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(runtime_revision) = 'integer' AND runtime_revision >= 0 AND runtime_revision <= 9007199254740991);

CREATE TRIGGER agent_revision_control_run_insert
BEFORE INSERT ON control_runs
WHEN EXISTS (SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND a.workspace_id = NEW.workspace_id
  AND (COALESCE(json_extract(NEW.data_json, '$.agentRevision'), 0) IS NOT a.runtime_revision))
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_conflict'); END;

CREATE TRIGGER agent_revision_control_run_resume
BEFORE UPDATE ON control_runs
WHEN NEW.status IN ('queued', 'running', 'waiting', 'interrupted')
  AND EXISTS (SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND a.workspace_id = NEW.workspace_id
    AND (COALESCE(json_extract(NEW.data_json, '$.agentRevision'), 0) IS NOT a.runtime_revision))
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_conflict'); END;

CREATE TRIGGER agent_revision_chat_run_insert
BEFORE INSERT ON chat_runs
WHEN EXISTS (SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND a.workspace_id = NEW.workspace_id
  AND (COALESCE(json_extract(NEW.metadata_json, '$.agentRevision'), 0) IS NOT a.runtime_revision))
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_conflict'); END;

CREATE TRIGGER agent_revision_chat_run_resume
BEFORE UPDATE ON chat_runs
WHEN NEW.status = 'running'
  AND EXISTS (SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND a.workspace_id = NEW.workspace_id
    AND (COALESCE(json_extract(NEW.metadata_json, '$.agentRevision'), 0) IS NOT a.runtime_revision))
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_conflict'); END;

CREATE TRIGGER agent_revision_control_run_immutable
BEFORE UPDATE ON control_runs
WHEN NEW.agent_id IS NOT OLD.agent_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR COALESCE(json_extract(NEW.data_json, '$.agentRevision'), 0) IS NOT COALESCE(json_extract(OLD.data_json, '$.agentRevision'), 0)
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_conflict'); END;

CREATE TRIGGER agent_revision_chat_run_immutable
BEFORE UPDATE ON chat_runs
WHEN NEW.agent_id IS NOT OLD.agent_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR COALESCE(json_extract(NEW.metadata_json, '$.agentRevision'), 0) IS NOT COALESCE(json_extract(OLD.metadata_json, '$.agentRevision'), 0)
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_conflict'); END;

-- A future upgrade command must also archive snapshots, validate state/handler
-- compatibility and fence accepted-but-not-started commands. This is the atomic
-- execution barrier, not authorization to change a package snapshot directly.
CREATE TRIGGER agent_revision_monotonic
BEFORE UPDATE OF runtime_revision ON agents
WHEN NEW.runtime_revision != OLD.runtime_revision AND NEW.runtime_revision != OLD.runtime_revision + 1
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_invalid'); END;

CREATE TRIGGER agent_revision_active_work
BEFORE UPDATE OF runtime_revision ON agents
WHEN NEW.runtime_revision != OLD.runtime_revision AND (
  EXISTS (SELECT 1 FROM control_runs r WHERE r.workspace_id = OLD.workspace_id AND r.agent_id = OLD.id
    AND r.status IN ('queued', 'running', 'waiting', 'interrupted'))
  OR EXISTS (SELECT 1 FROM chat_runs r WHERE r.workspace_id = OLD.workspace_id AND r.agent_id = OLD.id AND r.status = 'running')
  OR EXISTS (SELECT 1 FROM control_state_migrations m WHERE m.workspace_id = OLD.workspace_id AND m.agent_id = OLD.id AND m.status = 'running')
  OR EXISTS (SELECT 1 FROM control_action_proposals p WHERE p.workspace_id = OLD.workspace_id AND p.agent_id = OLD.id
    AND p.status IN ('proposed', 'approval_requested', 'approved', 'executing', 'outcome_unknown'))
)
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_busy'); END;
