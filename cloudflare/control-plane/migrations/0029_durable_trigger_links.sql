-- Transfers a leased trigger dispatch into durable execution in the admission batch.
CREATE TABLE control_durable_trigger_links (
 run_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL UNIQUE, trigger_id TEXT NOT NULL,
 user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
 workflow_type TEXT NOT NULL, pack_id TEXT NOT NULL,
 execution_json TEXT NOT NULL, input_json TEXT NOT NULL, config_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 preconditions_met INTEGER NOT NULL CHECK(preconditions_met=1)
);
CREATE INDEX idx_durable_trigger_links_scope ON control_durable_trigger_links(workspace_id,trigger_id);

-- Repeated observations keep one pending dispatch while an earlier run is active.
CREATE TRIGGER durable_trigger_coalesce BEFORE INSERT ON control_trigger_dispatches
WHEN NEW.status='pending' AND NEW.source IN ('schedule','monitor')
 AND EXISTS (SELECT 1 FROM control_triggers WHERE id=NEW.trigger_id AND json_extract(execution_json,'$.runtime')='durable')
 AND EXISTS (SELECT 1 FROM control_trigger_dispatches WHERE trigger_id=NEW.trigger_id AND status='pending' AND source=NEW.source)
BEGIN
 UPDATE control_trigger_dispatches SET scheduled_for=NEW.scheduled_for,updated_at=NEW.updated_at,
   payload_json=json_set(payload_json,'$.coalescedOccurrences',COALESCE(json_extract(payload_json,'$.coalescedOccurrences'),0)+1,
     '$.latestScheduledFor',NEW.scheduled_for)
 WHERE trigger_id=NEW.trigger_id AND status='pending' AND source=NEW.source
   AND scheduled_for < NEW.scheduled_for;
 SELECT RAISE(IGNORE);
END;
CREATE TRIGGER durable_trigger_link_immutable BEFORE UPDATE ON control_durable_trigger_links
BEGIN SELECT RAISE(ABORT,'durable_trigger_link_immutable'); END;

CREATE TRIGGER durable_trigger_link_admitted AFTER INSERT ON control_durable_trigger_links
BEGIN
 UPDATE control_trigger_dispatches SET status='running',run_id=NEW.run_id,
   lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NEW.created_at,updated_at=NEW.created_at
 WHERE id=NEW.dispatch_id AND user_id=NEW.user_id AND workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
 INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
 VALUES (NEW.dispatch_id||':durable-started',NEW.user_id,NEW.workspace_id,NEW.agent_id,
   'trigger.dispatch.started','Trigger dispatch accepted by the durable runtime.','triggerDispatch',NEW.dispatch_id,
   json_object('runId',NEW.run_id,'triggerId',NEW.trigger_id,'logicalEventId',NEW.dispatch_id),NEW.created_at);
END;

CREATE TRIGGER durable_trigger_run_terminal AFTER UPDATE OF status ON control_runs
WHEN NEW.status IN ('completed','failed','blocked','cancelled') AND OLD.status!=NEW.status
BEGIN
 UPDATE control_trigger_dispatches SET status = CASE NEW.status WHEN 'blocked' THEN 'failed' ELSE NEW.status END,
   lease_owner=NULL,lease_expires_at=NULL,updated_at=NEW.updated_at,
   error_json = CASE WHEN NEW.status IN ('failed','blocked') THEN json_object('code','durable_run_stopped') ELSE '{}' END
 WHERE id IN (SELECT dispatch_id FROM control_durable_trigger_links WHERE run_id=NEW.id)
   AND run_id=NEW.id AND user_id=NEW.user_id AND workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
END;

-- Pause and material configuration changes revoke current runs, including approval waits.
CREATE TRIGGER durable_trigger_authority_changed AFTER UPDATE ON control_triggers
WHEN NEW.status!='enabled' OR NEW.workflow_type!=OLD.workflow_type OR NEW.pack_id!=OLD.pack_id
 OR NEW.execution_json!=OLD.execution_json OR NEW.input_json!=OLD.input_json OR NEW.config_json!=OLD.config_json
BEGIN
 UPDATE control_runs SET status='cancelled',cancelled_at=NEW.updated_at,last_event_at=NEW.updated_at,
   updated_at=NEW.updated_at,data_json=json_set(data_json,'$.triggerOutcome','authority_changed')
 WHERE id IN (SELECT run_id FROM control_durable_trigger_links WHERE trigger_id=NEW.id)
   AND status IN ('queued','running','waiting','interrupted');
 UPDATE control_workflow_intents SET status='cancelled',updated_at=NEW.updated_at
 WHERE id IN (SELECT workflow_intent_id FROM control_runs WHERE id IN (
   SELECT run_id FROM control_durable_trigger_links WHERE trigger_id=NEW.id) AND status='cancelled')
   AND status IN ('queued','running','waiting','interrupted');
END;

CREATE TRIGGER export_fence_control_durable_trigger_links_insert BEFORE INSERT ON control_durable_trigger_links
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences WHERE workspace_id=NEW.workspace_id
 AND status='active' AND lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_trigger_links_update BEFORE UPDATE ON control_durable_trigger_links
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences WHERE workspace_id=NEW.workspace_id
 AND status='active' AND lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_trigger_links_delete BEFORE DELETE ON control_durable_trigger_links
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences WHERE workspace_id=OLD.workspace_id
 AND status='active' AND lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
