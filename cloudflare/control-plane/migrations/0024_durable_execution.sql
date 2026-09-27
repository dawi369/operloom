-- Canonical durable submission and step receipts; engine scheduling is a separate adapter.
CREATE TABLE control_durable_executions (
  run_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  workflow_intent_id TEXT NOT NULL UNIQUE, instance_id TEXT NOT NULL UNIQUE,
  submission_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, runtime_version TEXT NOT NULL,
  workflow_type TEXT NOT NULL, workflow_version TEXT NOT NULL, definition_hash TEXT NOT NULL,
  agent_revision INTEGER NOT NULL, agent_data_json TEXT NOT NULL, configuration_hash TEXT NOT NULL,
  input_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','started','closed')),
  max_steps INTEGER NOT NULL CHECK(max_steps BETWEEN 1 AND 128),
  deadline TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT durable_submission_precondition CHECK(preconditions_met = 1),
  UNIQUE(user_id,workspace_id,agent_id,submission_key)
);
CREATE INDEX idx_durable_execution_pending ON control_durable_executions(status,created_at);
CREATE INDEX idx_durable_execution_workspace ON control_durable_executions(workspace_id,run_id);
CREATE TABLE control_durable_steps (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL, step_key TEXT NOT NULL, step_version TEXT NOT NULL, request_hash TEXT NOT NULL,
  output_schema_json TEXT NOT NULL, replay_safe INTEGER NOT NULL CHECK(replay_safe IN (0,1)),
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 5),
  timeout_ms INTEGER NOT NULL CHECK(timeout_ms BETWEEN 1 AND 300000),
  attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 1 AND 5),
  active_attempt_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','outcome_unknown')),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(run_id,step_key)
);
CREATE INDEX idx_durable_step_scope ON control_durable_steps(workspace_id,run_id);
CREATE TABLE control_durable_step_attempts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL, step_id TEXT NOT NULL, attempt_index INTEGER NOT NULL CHECK(attempt_index BETWEEN 1 AND 5),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','outcome_unknown')),
  output_json TEXT, outcome_hash TEXT, error_code TEXT,
  started_at TEXT NOT NULL, finished_at TEXT,
  preconditions_met INTEGER NOT NULL CONSTRAINT durable_step_precondition CHECK(preconditions_met = 1),
  UNIQUE(step_id,attempt_index)
);
CREATE INDEX idx_durable_attempt_scope ON control_durable_step_attempts(workspace_id,run_id);
CREATE TABLE control_durable_step_outcomes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL, step_id TEXT NOT NULL, outcome_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed','failed','outcome_unknown')), created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT durable_outcome_precondition CHECK(preconditions_met = 1)
);
CREATE INDEX idx_durable_outcome_scope ON control_durable_step_outcomes(workspace_id,run_id);
CREATE TRIGGER immutable_durable_outcome BEFORE UPDATE ON control_durable_step_outcomes
BEGIN SELECT RAISE(ABORT,'durable_outcome_immutable'); END;
CREATE TRIGGER export_fence_control_durable_step_outcomes_insert BEFORE INSERT ON control_durable_step_outcomes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_step_outcomes_update BEFORE UPDATE ON control_durable_step_outcomes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_step_outcomes_delete BEFORE DELETE ON control_durable_step_outcomes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER immutable_durable_execution BEFORE UPDATE ON control_durable_executions
WHEN NEW.run_id != OLD.run_id OR NEW.user_id != OLD.user_id OR NEW.workspace_id != OLD.workspace_id
 OR NEW.agent_id != OLD.agent_id OR NEW.workflow_intent_id != OLD.workflow_intent_id OR NEW.instance_id != OLD.instance_id
 OR NEW.submission_key != OLD.submission_key OR NEW.request_hash != OLD.request_hash OR NEW.pack_id != OLD.pack_id
 OR NEW.pack_version != OLD.pack_version OR NEW.runtime_version != OLD.runtime_version OR NEW.workflow_type != OLD.workflow_type
 OR NEW.workflow_version != OLD.workflow_version OR NEW.definition_hash != OLD.definition_hash
 OR NEW.agent_revision != OLD.agent_revision OR NEW.agent_data_json != OLD.agent_data_json
 OR NEW.configuration_hash != OLD.configuration_hash OR NEW.input_json != OLD.input_json
 OR NEW.max_steps != OLD.max_steps OR NEW.deadline != OLD.deadline OR NEW.created_at != OLD.created_at
 OR OLD.status = 'closed' OR (OLD.status = 'started' AND NEW.status = 'pending')
BEGIN SELECT RAISE(ABORT,'durable_execution_immutable'); END;
CREATE TRIGGER immutable_durable_step BEFORE UPDATE ON control_durable_steps
WHEN NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.workspace_id != OLD.workspace_id OR NEW.agent_id != OLD.agent_id
 OR NEW.run_id != OLD.run_id OR NEW.step_key != OLD.step_key OR NEW.step_version != OLD.step_version
 OR NEW.request_hash != OLD.request_hash OR NEW.output_schema_json != OLD.output_schema_json OR NEW.replay_safe != OLD.replay_safe
 OR NEW.max_attempts != OLD.max_attempts OR NEW.timeout_ms != OLD.timeout_ms OR NEW.created_at != OLD.created_at
 OR OLD.status = 'completed' OR NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1
BEGIN SELECT RAISE(ABORT,'durable_step_immutable'); END;
CREATE TRIGGER immutable_durable_attempt BEFORE UPDATE ON control_durable_step_attempts
WHEN OLD.status != 'running' OR NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.workspace_id != OLD.workspace_id
 OR NEW.agent_id != OLD.agent_id OR NEW.run_id != OLD.run_id OR NEW.step_id != OLD.step_id
 OR NEW.attempt_index != OLD.attempt_index OR NEW.started_at != OLD.started_at OR NEW.status = 'running'
BEGIN SELECT RAISE(ABORT,'durable_attempt_immutable'); END;

CREATE TRIGGER export_fence_control_durable_executions_insert BEFORE INSERT ON control_durable_executions
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_executions_update BEFORE UPDATE ON control_durable_executions
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_executions_delete BEFORE DELETE ON control_durable_executions
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_steps_insert BEFORE INSERT ON control_durable_steps
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_steps_update BEFORE UPDATE ON control_durable_steps
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_steps_delete BEFORE DELETE ON control_durable_steps
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_step_attempts_insert BEFORE INSERT ON control_durable_step_attempts
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_step_attempts_update BEFORE UPDATE ON control_durable_step_attempts
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_step_attempts_delete BEFORE DELETE ON control_durable_step_attempts
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

-- Canonical terminal status also retires the startup intent, including cancellation.
CREATE TRIGGER close_durable_execution_after_run_terminal AFTER UPDATE OF status ON control_runs
WHEN NEW.status IN ('completed','failed','cancelled','blocked')
BEGIN
  UPDATE control_durable_executions SET status='closed',updated_at=NEW.updated_at
  WHERE run_id=NEW.id AND user_id=NEW.user_id AND workspace_id=NEW.workspace_id
    AND agent_id=NEW.agent_id AND status!='closed';
END;
