-- Domain capacity claims share final provider admission and atomic typed-state projection.
CREATE TABLE control_action_reservations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL, provider_receipt_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  namespace TEXT NOT NULL, kind TEXT NOT NULL, record_key TEXT NOT NULL,
  record_version INTEGER NOT NULL CHECK(record_version>0), field TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 1 AND 1000000000),
  status TEXT NOT NULL CHECK(status IN ('held','released','projected')),
  projection_commit_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(proposal_id,namespace,kind,record_key,field)
);
CREATE INDEX idx_action_resources_capacity ON control_action_reservations(scope_id,namespace,kind,record_key,field,status);
CREATE INDEX idx_action_resources_workspace ON control_action_reservations(workspace_id,agent_id,status);
CREATE TABLE control_action_projections (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE, provider_receipt_id TEXT NOT NULL UNIQUE,
  commit_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TRIGGER action_resource_admission BEFORE INSERT ON control_action_reservations
WHEN NEW.status!='held' OR NEW.projection_commit_id IS NOT NULL OR (SELECT COUNT(*) FROM control_action_reservations WHERE proposal_id=NEW.proposal_id)>=8
 OR NOT EXISTS (
  SELECT 1 FROM control_state_records r JOIN control_provider_operations o ON o.id=NEW.provider_receipt_id
  JOIN control_action_reviews review ON review.id=o.review_id
  JOIN json_each(review.binding_json,'$.reservations') claim
  WHERE r.scope_id=NEW.scope_id AND r.namespace=NEW.namespace AND r.kind=NEW.kind AND r.record_key=NEW.record_key
  AND r.version=NEW.record_version AND r.user_id=NEW.user_id AND r.workspace_id=NEW.workspace_id AND r.agent_id=NEW.agent_id
  AND o.proposal_id=NEW.proposal_id AND o.status='dispatching' AND o.user_id=NEW.user_id AND o.workspace_id=NEW.workspace_id AND o.agent_id=NEW.agent_id
  AND json_extract(review.binding_json,'$.stateScopeId')=NEW.scope_id
  AND json_extract(claim.value,'$.namespace')=NEW.namespace AND json_extract(claim.value,'$.kind')=NEW.kind
  AND json_extract(claim.value,'$.key')=NEW.record_key AND json_extract(claim.value,'$.version')=NEW.record_version
  AND json_extract(claim.value,'$.field')=NEW.field AND json_extract(claim.value,'$.amount')=NEW.amount
  AND json_type(r.data_json,'$.'||NEW.field)='integer'
  AND json_extract(r.data_json,'$.'||NEW.field) BETWEEN 0 AND 1000000000000
  AND json_extract(r.data_json,'$.'||NEW.field) >= NEW.amount + COALESCE((SELECT SUM(amount) FROM control_action_reservations c
    WHERE c.scope_id=NEW.scope_id AND c.namespace=NEW.namespace AND c.kind=NEW.kind AND c.record_key=NEW.record_key AND c.field=NEW.field AND c.status='held'),0)
  AND NOT EXISTS (SELECT 1 FROM control_state_schema_heads h WHERE h.scope_id=NEW.scope_id AND h.namespace=NEW.namespace AND h.kind=NEW.kind AND h.status!='active')
 )
BEGIN SELECT RAISE(ABORT,'action_resource_conflict'); END;
CREATE TRIGGER action_resource_immutable BEFORE UPDATE ON control_action_reservations
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.agent_id IS NOT OLD.agent_id
 OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.provider_receipt_id IS NOT OLD.provider_receipt_id OR NEW.scope_id IS NOT OLD.scope_id
 OR NEW.namespace IS NOT OLD.namespace OR NEW.kind IS NOT OLD.kind OR NEW.record_key IS NOT OLD.record_key OR NEW.record_version IS NOT OLD.record_version
 OR NEW.field IS NOT OLD.field OR NEW.amount IS NOT OLD.amount OR NEW.created_at IS NOT OLD.created_at OR OLD.status!='held'
 OR NOT ((NEW.status='released' AND NEW.projection_commit_id IS NULL AND EXISTS (SELECT 1 FROM control_provider_operations o WHERE o.id=OLD.provider_receipt_id AND o.status='failed'))
 OR (NEW.status='projected' AND EXISTS (SELECT 1 FROM control_action_projections p WHERE p.proposal_id=OLD.proposal_id AND p.commit_id=NEW.projection_commit_id)))
BEGIN SELECT RAISE(ABORT,'action_resource_immutable'); END;
CREATE TRIGGER action_projection_admission BEFORE INSERT ON control_action_projections
WHEN NOT EXISTS (SELECT 1 FROM control_state_commits c JOIN control_provider_operations o ON o.id=NEW.provider_receipt_id
 WHERE c.id=NEW.commit_id AND c.user_id=NEW.user_id AND c.workspace_id=NEW.workspace_id AND c.agent_id=NEW.agent_id
 AND o.proposal_id=NEW.proposal_id AND o.user_id=NEW.user_id AND o.workspace_id=NEW.workspace_id AND o.agent_id=NEW.agent_id AND o.status IN ('succeeded','failed'))
BEGIN SELECT RAISE(ABORT,'action_projection_conflict'); END;
CREATE TRIGGER action_projection_immutable BEFORE UPDATE ON control_action_projections
BEGIN SELECT RAISE(ABORT,'action_projection_immutable'); END;
CREATE TRIGGER action_resource_rejection AFTER UPDATE OF status ON control_provider_operations
WHEN NEW.status='failed'
BEGIN UPDATE control_action_reservations SET status='released',updated_at=NEW.updated_at WHERE provider_receipt_id=NEW.id AND status='held'; END;
CREATE TRIGGER action_resource_state_update BEFORE UPDATE ON control_state_records
WHEN EXISTS (SELECT 1 FROM control_action_reservations c WHERE c.scope_id=OLD.scope_id AND c.namespace=OLD.namespace AND c.kind=OLD.kind AND c.record_key=OLD.record_key AND c.status='held'
 AND (NEW.scope_id IS NOT OLD.scope_id OR NEW.namespace IS NOT OLD.namespace OR NEW.kind IS NOT OLD.kind OR NEW.record_key IS NOT OLD.record_key
 OR NEW.schema_version IS NOT OLD.schema_version OR json_type(NEW.data_json,'$.'||c.field) IS NOT 'integer'
 OR json_extract(NEW.data_json,'$.'||c.field)>1000000000000
 OR json_extract(NEW.data_json,'$.'||c.field)<(SELECT SUM(held.amount) FROM control_action_reservations held WHERE held.scope_id=c.scope_id AND held.namespace=c.namespace AND held.kind=c.kind AND held.record_key=c.record_key AND held.field=c.field AND held.status='held')))
BEGIN SELECT RAISE(ABORT,'action_resource_conflict'); END;
CREATE TRIGGER action_resource_state_delete BEFORE DELETE ON control_state_records
WHEN EXISTS (SELECT 1 FROM control_action_reservations c WHERE c.scope_id=OLD.scope_id AND c.namespace=OLD.namespace AND c.kind=OLD.kind AND c.record_key=OLD.record_key AND c.status='held')
BEGIN SELECT RAISE(ABORT,'action_resource_conflict'); END;
CREATE TRIGGER action_resource_upgrade BEFORE UPDATE OF runtime_revision ON agents
WHEN NEW.runtime_revision!=OLD.runtime_revision AND EXISTS (SELECT 1 FROM control_action_reservations WHERE agent_id=OLD.id AND workspace_id=OLD.workspace_id AND status='held')
BEGIN SELECT RAISE(ABORT,'action_resource_upgrade_blocked'); END;
CREATE TRIGGER action_resource_migration_insert BEFORE INSERT ON control_state_schema_heads
WHEN NEW.status='migrating' AND EXISTS (SELECT 1 FROM control_action_reservations WHERE scope_id=NEW.scope_id AND namespace=NEW.namespace AND kind=NEW.kind AND status='held')
BEGIN SELECT RAISE(ABORT,'action_resource_migration_blocked'); END;
CREATE TRIGGER action_resource_migration_update BEFORE UPDATE ON control_state_schema_heads
WHEN NEW.status='migrating' AND EXISTS (SELECT 1 FROM control_action_reservations WHERE scope_id=NEW.scope_id AND namespace=NEW.namespace AND kind=NEW.kind AND status='held')
BEGIN SELECT RAISE(ABORT,'action_resource_migration_blocked'); END;
CREATE TRIGGER export_fence_control_action_reservations_insert BEFORE INSERT ON control_action_reservations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=NEW.workspace_id
 AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_action_reservations_update BEFORE UPDATE ON control_action_reservations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=OLD.workspace_id
 AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_action_reservations_delete BEFORE DELETE ON control_action_reservations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=OLD.workspace_id
 AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER lifecycle_delete_control_action_reservations BEFORE DELETE ON control_action_reservations
WHEN NOT EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND status='purging')
BEGIN SELECT RAISE(ABORT,'action_resource_lifecycle_required'); END;
CREATE TRIGGER export_fence_control_action_projections_insert BEFORE INSERT ON control_action_projections
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=NEW.workspace_id
 AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_action_projections_update BEFORE UPDATE ON control_action_projections
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=OLD.workspace_id
 AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_action_projections_delete BEFORE DELETE ON control_action_projections
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=OLD.workspace_id
 AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER lifecycle_delete_control_action_projections BEFORE DELETE ON control_action_projections
WHEN NOT EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND status='purging')
BEGIN SELECT RAISE(ABORT,'action_resource_lifecycle_required'); END;
