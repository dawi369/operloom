-- Existing request records cannot bind a delayed approval to its original authority.
CREATE TABLE control_action_reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL, binding_json TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT action_review_precondition CHECK(preconditions_met=1)
);
CREATE INDEX idx_action_reviews_expiry ON control_action_reviews(workspace_id,expires_at,id);
CREATE TRIGGER action_review_immutable BEFORE UPDATE ON control_action_reviews
WHEN NOT (
 NEW.id IS OLD.id AND NEW.user_id IS OLD.user_id AND NEW.workspace_id IS OLD.workspace_id AND NEW.agent_id IS OLD.agent_id
 AND NEW.proposal_id IS OLD.proposal_id AND NEW.request_hash IS OLD.request_hash AND NEW.expires_at IS OLD.expires_at
 AND NEW.created_at IS OLD.created_at AND NEW.preconditions_met IS OLD.preconditions_met
 AND COALESCE(json_type(NEW.binding_json,'$.payloadPrunedAt')='text',0) AND (SELECT COUNT(*) FROM json_each(NEW.binding_json))=1
 AND EXISTS (SELECT 1 FROM control_action_proposals p LEFT JOIN control_retention_policies policy ON policy.workspace_id=p.workspace_id
   WHERE p.id=OLD.proposal_id AND p.status IN ('executed','failed','reconciled','cancelled','expired')
   AND p.updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || COALESCE(policy.run_payload_retention_days,90) || ' days'))
)
BEGIN SELECT RAISE(ABORT,'action_review_immutable'); END;
ALTER TABLE control_action_ledger ADD COLUMN transition_key TEXT;
ALTER TABLE control_action_ledger ADD COLUMN preconditions_met INTEGER NOT NULL DEFAULT 1
  CONSTRAINT action_transition_precondition CHECK(preconditions_met=1);
CREATE UNIQUE INDEX idx_action_transition_identity ON control_action_ledger(proposal_id,transition_key)
  WHERE transition_key IS NOT NULL;
CREATE TRIGGER action_proposal_payload_immutable BEFORE UPDATE ON control_action_proposals
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.agent_id IS NOT OLD.agent_id OR NEW.pack_id IS NOT OLD.pack_id
 OR NEW.pack_version IS NOT OLD.pack_version OR NEW.runtime_version IS NOT OLD.runtime_version
 OR NEW.binding_version IS NOT OLD.binding_version OR NEW.tool_id IS NOT OLD.tool_id
 OR NEW.action_type IS NOT OLD.action_type OR NEW.connection_record_id IS NOT OLD.connection_record_id
 OR NEW.summary IS NOT OLD.summary OR NEW.idempotency_key IS NOT OLD.idempotency_key
 OR NEW.input_sha256 IS NOT OLD.input_sha256
 OR (NEW.proposal_json IS NOT OLD.proposal_json AND NOT (
   OLD.status IN ('executed','failed','reconciled','cancelled','expired')
   AND COALESCE(json_type(NEW.proposal_json,'$.payloadPrunedAt')='text',0) AND (SELECT COUNT(*) FROM json_each(NEW.proposal_json))=1
   AND OLD.updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || COALESCE((SELECT run_payload_retention_days FROM control_retention_policies WHERE workspace_id=OLD.workspace_id),90) || ' days')))
 OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'action_proposal_payload_immutable'); END;
CREATE TRIGGER action_proposal_review_link_immutable BEFORE UPDATE ON control_action_proposals
WHEN OLD.approval_request_id IS NOT NULL AND (NEW.approval_request_id IS NOT OLD.approval_request_id
 OR NEW.run_id IS NOT OLD.run_id OR NEW.workflow_intent_id IS NOT OLD.workflow_intent_id)
BEGIN SELECT RAISE(ABORT,'action_proposal_review_link_immutable'); END;
CREATE TRIGGER action_approval_payload_immutable BEFORE UPDATE ON control_approval_requests
WHEN json_extract(OLD.data_json,'$.source')='action_authority' AND (
 NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.agent_id IS NOT OLD.agent_id OR NEW.run_id IS NOT OLD.run_id
 OR NEW.workflow_intent_id IS NOT OLD.workflow_intent_id OR NEW.tool_id IS NOT OLD.tool_id
 OR json_remove(NEW.data_json,'$.decidedByUserId','$.denyReason','$.decidedAt')
   IS NOT json_remove(OLD.data_json,'$.decidedByUserId','$.denyReason','$.decidedAt'))
BEGIN SELECT RAISE(ABORT,'action_approval_payload_immutable'); END;
CREATE TRIGGER export_fence_control_action_reviews_insert BEFORE INSERT ON control_action_reviews
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=NEW.workspace_id
 AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_action_reviews_delete BEFORE DELETE ON control_action_reviews
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=OLD.workspace_id
 AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_action_reviews_update BEFORE UPDATE ON control_action_reviews
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=OLD.workspace_id
 AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
