-- Workspace-wide limits and durable dispatch receipts. Unknown usage remains charged.
CREATE TABLE control_budget_policies (
  workspace_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version > 0),
  limits_json TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE control_budget_changes (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  version INTEGER NOT NULL, limits_json TEXT NOT NULL, created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT budget_change_precondition CHECK(preconditions_met = 1),
  UNIQUE(workspace_id, user_id, idempotency_key)
);
CREATE TABLE control_resource_reservations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL, run_kind TEXT NOT NULL CHECK(run_kind IN ('workflow','chat')),
  budget_run_id TEXT NOT NULL, budget_run_kind TEXT NOT NULL CHECK(budget_run_kind IN ('workflow','chat')),
  agent_revision INTEGER NOT NULL, pack_id TEXT NOT NULL, operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('model','tool')),
  day TEXT NOT NULL, policy_version INTEGER NOT NULL,
  estimated_input_tokens INTEGER NOT NULL CHECK(estimated_input_tokens >= 0),
  reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens >= 0),
  input_tokens INTEGER CHECK(input_tokens >= 0), output_tokens INTEGER CHECK(output_tokens >= 0),
  usage_source TEXT NOT NULL DEFAULT 'unreported' CHECK(usage_source IN ('provider','fixture','unreported')),
  status TEXT NOT NULL CHECK(status IN ('reserved','settled','unknown')),
  result_json TEXT, result_hash TEXT, error_code TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, settled_at TEXT,
  preconditions_met INTEGER NOT NULL CONSTRAINT resource_reservation_precondition CHECK(preconditions_met = 1),
  UNIQUE(workspace_id,run_kind,run_id,kind,operation_key)
);
CREATE INDEX idx_resource_reservations_day ON control_resource_reservations(workspace_id,day);
CREATE INDEX idx_resource_reservations_run ON control_resource_reservations(workspace_id,budget_run_kind,budget_run_id);
CREATE TRIGGER immutable_budget_changes BEFORE UPDATE ON control_budget_changes
BEGIN SELECT RAISE(ABORT, 'budget_change_immutable'); END;
CREATE TRIGGER immutable_resource_reservation BEFORE UPDATE ON control_resource_reservations
WHEN OLD.status != 'reserved' OR NEW.status = 'reserved'
 OR OLD.id != NEW.id OR OLD.user_id != NEW.user_id OR OLD.workspace_id != NEW.workspace_id
 OR OLD.agent_id != NEW.agent_id OR OLD.run_id != NEW.run_id OR OLD.run_kind != NEW.run_kind
 OR OLD.budget_run_id != NEW.budget_run_id OR OLD.budget_run_kind != NEW.budget_run_kind
 OR OLD.agent_revision != NEW.agent_revision OR OLD.pack_id != NEW.pack_id
 OR OLD.operation_key != NEW.operation_key OR OLD.request_hash != NEW.request_hash
 OR OLD.kind != NEW.kind OR OLD.day != NEW.day OR OLD.policy_version != NEW.policy_version
 OR OLD.estimated_input_tokens != NEW.estimated_input_tokens OR OLD.reserved_tokens != NEW.reserved_tokens
 OR OLD.created_at != NEW.created_at OR OLD.expires_at != NEW.expires_at
BEGIN SELECT RAISE(ABORT, 'resource_reservation_immutable'); END;

CREATE TRIGGER export_fence_control_budget_policies_insert BEFORE INSERT ON control_budget_policies
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = NEW.workspace_id AND f.status = 'active'
 AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_budget_policies_update BEFORE UPDATE ON control_budget_policies
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = NEW.workspace_id AND f.status = 'active'
 AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_budget_policies_delete BEFORE DELETE ON control_budget_policies
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = OLD.workspace_id AND f.status = 'active'
 AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_budget_changes_insert BEFORE INSERT ON control_budget_changes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = NEW.workspace_id AND f.status = 'active'
 AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_budget_changes_update BEFORE UPDATE ON control_budget_changes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = NEW.workspace_id AND f.status = 'active'
 AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_budget_changes_delete BEFORE DELETE ON control_budget_changes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = OLD.workspace_id AND f.status = 'active'
 AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_resource_reservations_insert BEFORE INSERT ON control_resource_reservations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = NEW.workspace_id AND f.status = 'active'
 AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_resource_reservations_update BEFORE UPDATE ON control_resource_reservations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = NEW.workspace_id AND f.status = 'active'
 AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_resource_reservations_delete BEFORE DELETE ON control_resource_reservations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = OLD.workspace_id AND f.status = 'active'
 AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
