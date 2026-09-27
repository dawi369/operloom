-- D1 cannot atomically acknowledge native engine calls. Retain dispatch uncertainty
-- and confirmed deletion before allowing canonical identities to be purged.
ALTER TABLE control_durable_executions ADD COLUMN engine_deleted_at TEXT;
ALTER TABLE control_durable_executions ADD COLUMN engine_lifecycle_version INTEGER NOT NULL DEFAULT 0 CHECK(engine_lifecycle_version IN (0,1));
CREATE TABLE control_durable_engine_dispatches (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL, instance_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('dispatching','accepted','outcome_unknown')),
  created_at TEXT NOT NULL, settled_at TEXT,
  preconditions_met INTEGER NOT NULL CONSTRAINT durable_dispatch_precondition CHECK(preconditions_met = 1)
);
CREATE INDEX idx_durable_dispatch_scope ON control_durable_engine_dispatches(workspace_id,run_id);
CREATE UNIQUE INDEX idx_durable_dispatch_active ON control_durable_engine_dispatches(run_id) WHERE status='dispatching';
-- Historical dispatches have no acknowledged-call evidence. Do not infer it from run status.
INSERT INTO control_durable_engine_dispatches
 (id,user_id,workspace_id,agent_id,run_id,instance_id,status,created_at,settled_at,preconditions_met)
SELECT 'legacy:' || run_id,user_id,workspace_id,agent_id,run_id,instance_id,'outcome_unknown',
 created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1 FROM control_durable_executions;

-- Old Workers may still admit executions during a rolling deployment.
CREATE TRIGGER legacy_durable_engine_dispatch AFTER INSERT ON control_durable_executions
WHEN NEW.engine_lifecycle_version=0
BEGIN
 INSERT INTO control_durable_engine_dispatches
  (id,user_id,workspace_id,agent_id,run_id,instance_id,status,created_at,settled_at,preconditions_met)
 VALUES ('legacy:' || NEW.run_id,NEW.user_id,NEW.workspace_id,NEW.agent_id,NEW.run_id,NEW.instance_id,
  'outcome_unknown',NEW.created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1);
END;
CREATE TRIGGER immutable_durable_engine_lifecycle_version BEFORE UPDATE OF engine_lifecycle_version ON control_durable_executions
WHEN NEW.engine_lifecycle_version != OLD.engine_lifecycle_version
BEGIN SELECT RAISE(ABORT,'durable_lifecycle_version_immutable'); END;
CREATE TRIGGER immutable_durable_engine_dispatch BEFORE UPDATE ON control_durable_engine_dispatches
WHEN OLD.status != 'dispatching' OR NEW.status = 'dispatching' OR NEW.id != OLD.id
 OR NEW.user_id != OLD.user_id OR NEW.workspace_id != OLD.workspace_id OR NEW.agent_id != OLD.agent_id
 OR NEW.run_id != OLD.run_id OR NEW.instance_id != OLD.instance_id OR NEW.created_at != OLD.created_at
 OR NEW.preconditions_met != OLD.preconditions_met OR NEW.settled_at IS NULL
BEGIN SELECT RAISE(ABORT,'durable_dispatch_immutable'); END;
CREATE TRIGGER durable_engine_deletion_guard BEFORE UPDATE OF engine_deleted_at ON control_durable_executions
WHEN NEW.engine_deleted_at IS NOT OLD.engine_deleted_at AND (
 OLD.engine_deleted_at IS NOT NULL OR NEW.engine_deleted_at IS NULL
 OR NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=OLD.workspace_id AND w.status='purging')
 OR EXISTS (SELECT 1 FROM control_durable_engine_dispatches d
   WHERE d.workspace_id=OLD.workspace_id AND d.run_id=OLD.run_id AND d.status!='accepted'))
BEGIN SELECT RAISE(ABORT,'durable_engine_deletion_fenced'); END;
CREATE TRIGGER durable_engine_purge_guard BEFORE DELETE ON control_durable_executions
WHEN OLD.engine_deleted_at IS NULL
BEGIN SELECT RAISE(ABORT,'durable_engine_deletion_required'); END;
CREATE TRIGGER durable_dispatch_purge_guard BEFORE DELETE ON control_durable_engine_dispatches
WHEN NOT EXISTS (SELECT 1 FROM control_durable_executions e
 WHERE e.run_id=OLD.run_id AND e.workspace_id=OLD.workspace_id AND e.engine_deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'durable_engine_deletion_required'); END;
CREATE TRIGGER export_fence_control_durable_engine_dispatches_insert BEFORE INSERT ON control_durable_engine_dispatches
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_engine_dispatches_update BEFORE UPDATE ON control_durable_engine_dispatches
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_engine_dispatches_delete BEFORE DELETE ON control_durable_engine_dispatches
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
