-- Provider outcomes must survive a failed application projection without redispatch.
CREATE TABLE control_provider_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE, review_id TEXT NOT NULL,
  operation_id TEXT NOT NULL, operation_version TEXT NOT NULL,
  descriptor_json TEXT NOT NULL, request_hash TEXT NOT NULL,
  connection_record_id TEXT NOT NULL, vault_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('dispatching','succeeded','failed','outcome_unknown')),
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_provider_operations_scope ON control_provider_operations(user_id,workspace_id,agent_id,created_at);
CREATE TRIGGER provider_operation_immutable BEFORE UPDATE ON control_provider_operations
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.agent_id IS NOT OLD.agent_id OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.review_id IS NOT OLD.review_id
 OR NEW.operation_id IS NOT OLD.operation_id OR NEW.operation_version IS NOT OLD.operation_version
 OR NEW.descriptor_json IS NOT OLD.descriptor_json OR NEW.request_hash IS NOT OLD.request_hash
 OR NEW.connection_record_id IS NOT OLD.connection_record_id OR NEW.vault_version IS NOT OLD.vault_version
 OR NEW.created_at IS NOT OLD.created_at OR NEW.status='dispatching'
 OR (OLD.status IN ('succeeded','failed') AND NOT (
   NEW.status IS OLD.status AND NEW.updated_at IS OLD.updated_at
   AND COALESCE(json_type(NEW.result_json,'$.payloadPrunedAt')='text',0) AND (SELECT COUNT(*) FROM json_each(NEW.result_json))=1
   AND EXISTS (SELECT 1 FROM control_action_proposals p LEFT JOIN control_retention_policies policy ON policy.workspace_id=p.workspace_id
     WHERE p.id=OLD.proposal_id AND p.status IN ('executed','failed','reconciled','cancelled','expired')
     AND p.updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || COALESCE(policy.run_payload_retention_days,90) || ' days'))
 ))
BEGIN SELECT RAISE(ABORT,'provider_operation_immutable'); END;
CREATE TRIGGER export_fence_control_provider_operations_insert BEFORE INSERT ON control_provider_operations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=NEW.workspace_id
 AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_provider_operations_update BEFORE UPDATE ON control_provider_operations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=OLD.workspace_id
 AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_provider_operations_delete BEFORE DELETE ON control_provider_operations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=OLD.workspace_id
 AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
