-- Canonical approval and durable wake intent share D1; engine events carry no authority.
CREATE TABLE control_durable_approvals (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
 run_id TEXT NOT NULL, workflow_intent_id TEXT NOT NULL,
 step_key TEXT NOT NULL, step_version TEXT NOT NULL, request_hash TEXT NOT NULL,
 summary TEXT NOT NULL, payload_json TEXT NOT NULL, expires_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('requested','approved','denied','expired','cancelled')),
 decided_at TEXT, decided_by_user_id TEXT, decision_reason TEXT, consumed_at TEXT,
 wake_next_at TEXT, wake_attempts INTEGER NOT NULL DEFAULT 0,
 wake_lease_id TEXT, wake_lease_expires_at TEXT, wake_error_code TEXT,
 created_at TEXT NOT NULL,
 preconditions_met INTEGER NOT NULL CONSTRAINT durable_approval_precondition CHECK(preconditions_met=1),
 UNIQUE(run_id,step_key)
);
CREATE INDEX idx_durable_approval_scope ON control_durable_approvals(workspace_id,run_id);
CREATE INDEX idx_durable_approval_wake ON control_durable_approvals(wake_next_at,id) WHERE wake_next_at IS NOT NULL;
CREATE TRIGGER immutable_durable_approval BEFORE UPDATE ON control_durable_approvals
WHEN NEW.id!=OLD.id OR NEW.user_id!=OLD.user_id OR NEW.workspace_id!=OLD.workspace_id
 OR NEW.agent_id!=OLD.agent_id OR NEW.run_id!=OLD.run_id OR NEW.workflow_intent_id!=OLD.workflow_intent_id
 OR NEW.step_key!=OLD.step_key OR NEW.step_version!=OLD.step_version OR NEW.request_hash!=OLD.request_hash
 OR NEW.summary!=OLD.summary OR NEW.payload_json!=OLD.payload_json OR NEW.expires_at!=OLD.expires_at
 OR NEW.created_at!=OLD.created_at OR NEW.preconditions_met!=OLD.preconditions_met
 OR (OLD.status!='requested' AND (NEW.status!=OLD.status OR NEW.decided_at IS NOT OLD.decided_at
   OR NEW.decided_by_user_id IS NOT OLD.decided_by_user_id OR NEW.decision_reason IS NOT OLD.decision_reason))
 OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
BEGIN SELECT RAISE(ABORT,'durable_approval_immutable'); END;
CREATE TRIGGER project_durable_approval_request AFTER INSERT ON control_durable_approvals
BEGIN
 INSERT INTO control_approval_requests
  (id,user_id,workspace_id,agent_id,workflow_intent_id,run_id,tool_id,status,reason,data_json,created_at,updated_at)
 VALUES (NEW.id,NEW.user_id,NEW.workspace_id,NEW.agent_id,NEW.workflow_intent_id,NEW.run_id,
  'workflow.review','requested',NEW.summary,
  json_object('kind','durable_workflow','requestHash',NEW.request_hash,'payload',json(NEW.payload_json),
   'expiresAt',NEW.expires_at,'stepKey',NEW.step_key,'stepVersion',NEW.step_version),NEW.created_at,NEW.created_at);
 UPDATE control_runs SET status='waiting',updated_at=NEW.created_at,last_event_at=NEW.created_at
  WHERE id=NEW.run_id AND workspace_id=NEW.workspace_id;
 UPDATE control_workflow_intents SET status='waiting',updated_at=NEW.created_at
  WHERE id=NEW.workflow_intent_id AND workspace_id=NEW.workspace_id;
 INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
 VALUES (NEW.id||':requested',NEW.user_id,NEW.workspace_id,NEW.agent_id,'approval.requested',NEW.summary,
  'approvalRequest',NEW.id,json_object('runId',NEW.run_id,'requestHash',NEW.request_hash,'expiresAt',NEW.expires_at),NEW.created_at);
END;
CREATE TRIGGER project_durable_approval_decision AFTER UPDATE OF status ON control_durable_approvals
WHEN NEW.status!=OLD.status
BEGIN
 UPDATE control_approval_requests SET status=CASE WHEN NEW.status='expired' THEN 'cancelled' ELSE NEW.status END,
  updated_at=NEW.decided_at,data_json=json_set(data_json,'$.decidedAt',NEW.decided_at,
   '$.decidedByUserId',NEW.decided_by_user_id,'$.decisionReason',NEW.decision_reason)
  WHERE id=NEW.id AND workspace_id=NEW.workspace_id;
 INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
 VALUES (NEW.id||':'||NEW.status,NEW.user_id,NEW.workspace_id,NEW.agent_id,'approval.'||NEW.status,
  'Durable workflow review '||NEW.status||'.','approvalRequest',NEW.id,
  json_object('runId',NEW.run_id,'requestHash',NEW.request_hash,'decidedByUserId',NEW.decided_by_user_id),NEW.decided_at);
 INSERT INTO control_audit_events (id,user_id,workspace_id,action,summary,target_type,target_id,data_json,created_at)
 VALUES (NEW.id||':'||NEW.status,NEW.user_id,NEW.workspace_id,'approval.'||NEW.status,
  'Durable workflow review '||NEW.status||'.','approvalRequest',NEW.id,
  json_object('runId',NEW.run_id,'requestHash',NEW.request_hash,'decidedByUserId',NEW.decided_by_user_id),NEW.decided_at);
 UPDATE control_runs SET status=CASE WHEN NEW.status='denied' THEN 'cancelled' ELSE 'blocked' END,
  updated_at=NEW.decided_at,last_event_at=NEW.decided_at,
  data_json=json_set(data_json,'$.approvalOutcome',NEW.status)
  WHERE id=NEW.run_id AND workspace_id=NEW.workspace_id AND status='waiting' AND NEW.status IN ('denied','expired');
 UPDATE control_workflow_intents SET status=CASE WHEN NEW.status='denied' THEN 'cancelled' ELSE 'blocked' END,
  updated_at=NEW.decided_at WHERE id=NEW.workflow_intent_id AND workspace_id=NEW.workspace_id
  AND status='waiting' AND NEW.status IN ('denied','expired');
END;
CREATE TRIGGER consume_durable_approval AFTER UPDATE OF consumed_at ON control_durable_approvals
WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
BEGIN
 UPDATE control_runs SET status='running',updated_at=NEW.consumed_at,last_event_at=NEW.consumed_at
  WHERE id=NEW.run_id AND workspace_id=NEW.workspace_id AND status='waiting';
 UPDATE control_workflow_intents SET status='running',updated_at=NEW.consumed_at
  WHERE id=NEW.workflow_intent_id AND workspace_id=NEW.workspace_id AND status='waiting';
 INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
 VALUES (NEW.id||':consumed',NEW.user_id,NEW.workspace_id,NEW.agent_id,'run.resumed','Durable review consumed.',
  'run',NEW.run_id,json_object('approvalRequestId',NEW.id,'requestHash',NEW.request_hash),NEW.consumed_at);
END;
CREATE TRIGGER cancel_durable_approvals AFTER UPDATE OF status ON control_runs
WHEN NEW.status IN ('completed','failed','cancelled','blocked')
BEGIN
 UPDATE control_workflow_intents SET status=NEW.status,updated_at=NEW.updated_at
  WHERE id=NEW.workflow_intent_id AND workspace_id=NEW.workspace_id AND status='waiting'
   AND EXISTS (SELECT 1 FROM control_durable_approvals p WHERE p.run_id=NEW.id);
 UPDATE control_durable_approvals SET status='cancelled',decided_at=NEW.updated_at,wake_next_at=NULL
  WHERE run_id=NEW.id AND workspace_id=NEW.workspace_id AND status='requested';
 UPDATE control_durable_approvals SET wake_next_at=NULL
  WHERE run_id=NEW.id AND workspace_id=NEW.workspace_id;
END;
CREATE TRIGGER export_fence_control_durable_approvals_insert BEFORE INSERT ON control_durable_approvals
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id=NEW.workspace_id AND fence.status='active'
 AND fence.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_approvals_update BEFORE UPDATE ON control_durable_approvals
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id=NEW.workspace_id AND fence.status='active'
 AND fence.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_approvals_delete BEFORE DELETE ON control_durable_approvals
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id=OLD.workspace_id AND fence.status='active'
 AND fence.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
