-- Lease and rotate existing execution rows for bounded engine reconciliation.
ALTER TABLE control_durable_executions ADD COLUMN recovery_next_at TEXT DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE control_durable_executions ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(recovery_attempts >= 0);
ALTER TABLE control_durable_executions ADD COLUMN recovery_lease_id TEXT;
ALTER TABLE control_durable_executions ADD COLUMN recovery_lease_expires_at TEXT;
ALTER TABLE control_durable_executions ADD COLUMN recovery_engine_status TEXT;
ALTER TABLE control_durable_executions ADD COLUMN recovery_error_code TEXT;
CREATE INDEX idx_durable_recovery_due ON control_durable_executions(recovery_next_at,run_id) WHERE recovery_next_at IS NOT NULL;

DROP TRIGGER immutable_durable_execution;
CREATE TRIGGER immutable_durable_execution BEFORE UPDATE ON control_durable_executions
WHEN NEW.run_id != OLD.run_id OR NEW.user_id != OLD.user_id OR NEW.workspace_id != OLD.workspace_id
 OR NEW.agent_id != OLD.agent_id OR NEW.workflow_intent_id != OLD.workflow_intent_id OR NEW.instance_id != OLD.instance_id
 OR NEW.submission_key != OLD.submission_key OR NEW.request_hash != OLD.request_hash OR NEW.pack_id != OLD.pack_id
 OR NEW.pack_version != OLD.pack_version OR NEW.runtime_version != OLD.runtime_version OR NEW.workflow_type != OLD.workflow_type
 OR NEW.workflow_version != OLD.workflow_version OR NEW.definition_hash != OLD.definition_hash
 OR NEW.agent_revision != OLD.agent_revision OR NEW.agent_data_json != OLD.agent_data_json
 OR NEW.configuration_hash != OLD.configuration_hash OR NEW.input_json != OLD.input_json
 OR NEW.max_steps != OLD.max_steps OR NEW.deadline != OLD.deadline OR NEW.created_at != OLD.created_at
 OR (OLD.status = 'closed' AND (NEW.status != OLD.status OR NEW.updated_at != OLD.updated_at OR NEW.preconditions_met != OLD.preconditions_met)) OR (OLD.status = 'started' AND NEW.status = 'pending')
BEGIN SELECT RAISE(ABORT,'durable_execution_immutable'); END;

DROP TRIGGER close_durable_execution_after_run_terminal;
CREATE TRIGGER close_durable_execution_after_run_terminal AFTER UPDATE OF status ON control_runs
WHEN NEW.status IN ('completed','failed','cancelled','blocked')
BEGIN
  UPDATE control_durable_executions SET status='closed',updated_at=NEW.updated_at,recovery_next_at=NEW.updated_at
  WHERE run_id=NEW.id AND user_id=NEW.user_id AND workspace_id=NEW.workspace_id
    AND agent_id=NEW.agent_id AND status!='closed';
END;
