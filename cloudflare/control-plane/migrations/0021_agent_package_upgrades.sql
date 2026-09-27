-- Upgrade preflight must detect writes across every user and target state scope.
ALTER TABLE agents ADD COLUMN upgrade_validation_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(upgrade_validation_revision) = 'integer' AND upgrade_validation_revision >= 0 AND upgrade_validation_revision <= 9007199254740991);

CREATE TABLE control_agent_snapshots (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL, pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
  snapshot_json TEXT NOT NULL, created_by_user_id TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(workspace_id, agent_id, revision)
);
CREATE TABLE control_agent_upgrades (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT agent_upgrade_precondition CHECK(preconditions_met = 1),
  UNIQUE(workspace_id, agent_id, user_id, idempotency_key)
);
CREATE INDEX idx_agent_snapshot_history ON control_agent_snapshots(workspace_id, agent_id, revision);

CREATE TRIGGER upgrade_validation_control_state_records_insert AFTER INSERT ON control_state_records
BEGIN
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER upgrade_validation_control_state_records_update AFTER UPDATE ON control_state_records
BEGIN
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id;
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = OLD.agent_id AND workspace_id = OLD.workspace_id
      AND (OLD.agent_id IS NOT NEW.agent_id OR OLD.workspace_id IS NOT NEW.workspace_id);
END;

CREATE TRIGGER upgrade_validation_control_state_records_delete AFTER DELETE ON control_state_records
BEGIN
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = OLD.agent_id AND workspace_id = OLD.workspace_id;
END;

CREATE TRIGGER upgrade_validation_control_state_indexes_insert AFTER INSERT ON control_state_indexes
BEGIN
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER upgrade_validation_control_state_indexes_update AFTER UPDATE ON control_state_indexes
BEGIN
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id;
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = OLD.agent_id AND workspace_id = OLD.workspace_id
      AND (OLD.agent_id IS NOT NEW.agent_id OR OLD.workspace_id IS NOT NEW.workspace_id);
END;

CREATE TRIGGER upgrade_validation_control_state_indexes_delete AFTER DELETE ON control_state_indexes
BEGIN
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = OLD.agent_id AND workspace_id = OLD.workspace_id;
END;

CREATE TRIGGER upgrade_validation_control_state_schema_heads_insert AFTER INSERT ON control_state_schema_heads
BEGIN
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER upgrade_validation_control_state_schema_heads_update AFTER UPDATE ON control_state_schema_heads
BEGIN
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id;
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = OLD.agent_id AND workspace_id = OLD.workspace_id
      AND (OLD.agent_id IS NOT NEW.agent_id OR OLD.workspace_id IS NOT NEW.workspace_id);
END;

CREATE TRIGGER upgrade_validation_control_state_schema_heads_delete AFTER DELETE ON control_state_schema_heads
BEGIN
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = OLD.agent_id AND workspace_id = OLD.workspace_id;
END;

CREATE TRIGGER upgrade_validation_control_triggers_insert AFTER INSERT ON control_triggers
BEGIN
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER upgrade_validation_control_triggers_update AFTER UPDATE ON control_triggers
BEGIN
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id;
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = OLD.agent_id AND workspace_id = OLD.workspace_id
      AND (OLD.agent_id IS NOT NEW.agent_id OR OLD.workspace_id IS NOT NEW.workspace_id);
END;

CREATE TRIGGER upgrade_validation_control_triggers_delete AFTER DELETE ON control_triggers
BEGIN
  UPDATE agents SET upgrade_validation_revision = upgrade_validation_revision + 1
    WHERE id = OLD.agent_id AND workspace_id = OLD.workspace_id;
END;

CREATE TRIGGER immutable_control_agent_snapshots BEFORE UPDATE ON control_agent_snapshots
BEGIN SELECT RAISE(ABORT, 'agent_upgrade_history_immutable'); END;

CREATE TRIGGER export_fence_control_agent_snapshots_insert BEFORE INSERT ON control_agent_snapshots
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_agent_snapshots_update BEFORE UPDATE ON control_agent_snapshots
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_agent_snapshots_delete BEFORE DELETE ON control_agent_snapshots
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER immutable_control_agent_upgrades BEFORE UPDATE ON control_agent_upgrades
BEGIN SELECT RAISE(ABORT, 'agent_upgrade_history_immutable'); END;

CREATE TRIGGER export_fence_control_agent_upgrades_insert BEFORE INSERT ON control_agent_upgrades
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_agent_upgrades_update BEFORE UPDATE ON control_agent_upgrades
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_agent_upgrades_delete BEFORE DELETE ON control_agent_upgrades
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER agent_revision_pending_dispatches BEFORE UPDATE OF runtime_revision ON agents
WHEN NEW.runtime_revision != OLD.runtime_revision AND EXISTS (
  SELECT 1 FROM control_trigger_dispatches d WHERE d.workspace_id = OLD.workspace_id AND d.agent_id = OLD.id
    AND d.status NOT IN ('completed', 'failed', 'cancelled', 'skipped'))
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_busy'); END;
