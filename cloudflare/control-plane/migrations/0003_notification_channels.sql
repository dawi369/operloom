-- Deliveries carry a channel; push rows keep their device, email/SMS rows an address reference.
DROP TRIGGER IF EXISTS export_fence_control_notification_deliveries_insert;
DROP TRIGGER IF EXISTS export_fence_control_notification_deliveries_update;
DROP TRIGGER IF EXISTS export_fence_control_notification_deliveries_delete;
DROP INDEX IF EXISTS idx_control_notification_deliveries_pending;
DROP INDEX IF EXISTS idx_control_notification_deliveries_scope;
ALTER TABLE control_notification_deliveries RENAME TO control_notification_deliveries_legacy;

CREATE TABLE control_notification_deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'push' CHECK (channel IN ('push', 'email', 'sms')),
  device_id TEXT,
  address_ref TEXT,
  event_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  route TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'action' CHECK (severity IN ('info', 'action', 'alert')),
  title TEXT,
  body TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'expired')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provider_ticket_id TEXT,
  last_error_code TEXT,
  not_before TEXT,
  expires_at TEXT NOT NULL,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((channel = 'push') = (device_id IS NOT NULL))
);

INSERT INTO control_notification_deliveries (
  id, user_id, workspace_id, channel, device_id, event_type, target_type, target_id, route,
  severity, dedupe_key, status, attempt_count, provider_ticket_id, last_error_code, expires_at,
  delivered_at, created_at, updated_at
)
SELECT id, user_id, workspace_id, 'push', device_id, event_type, target_type, target_id, route,
  CASE WHEN route = 'approvals' THEN 'action' ELSE 'info' END,
  'push:' || device_id || ':' || event_type || ':' || target_type || ':' || target_id,
  status, attempt_count, provider_ticket_id, last_error_code, expires_at,
  delivered_at, created_at, updated_at
FROM control_notification_deliveries_legacy;

DROP TABLE control_notification_deliveries_legacy;

CREATE INDEX idx_control_notification_deliveries_pending
  ON control_notification_deliveries (status, expires_at, updated_at);

CREATE INDEX idx_control_notification_deliveries_scope
  ON control_notification_deliveries (user_id, workspace_id, created_at DESC);

CREATE TABLE control_notification_channel_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('push', 'email', 'sms')),
  event_type TEXT NOT NULL DEFAULT '*',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  quiet_start INTEGER CHECK (quiet_start IS NULL OR (quiet_start >= 0 AND quiet_start <= 23)),
  quiet_end INTEGER CHECK (quiet_end IS NULL OR (quiet_end >= 0 AND quiet_end <= 23)),
  digest_hour INTEGER CHECK (digest_hour IS NULL OR (digest_hour >= 0 AND digest_hour <= 23)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, workspace_id, channel, event_type)
);

CREATE TABLE control_notification_addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  vault_object_id TEXT NOT NULL,
  vault_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, workspace_id, channel)
);

CREATE TABLE control_notification_digest_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  event_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  folded_delivery_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, workspace_id, channel, event_type, target_type, target_id)
);

CREATE INDEX idx_control_notification_digest_items_open
  ON control_notification_digest_items (user_id, workspace_id, channel, folded_delivery_id, created_at);

CREATE TRIGGER export_fence_control_notification_deliveries_insert
BEFORE INSERT ON control_notification_deliveries
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_deliveries_update
BEFORE UPDATE ON control_notification_deliveries
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id) AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_deliveries_delete
BEFORE DELETE ON control_notification_deliveries
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_channel_preferences_insert
BEFORE INSERT ON control_notification_channel_preferences
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_channel_preferences_update
BEFORE UPDATE ON control_notification_channel_preferences
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id) AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_channel_preferences_delete
BEFORE DELETE ON control_notification_channel_preferences
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_addresses_insert
BEFORE INSERT ON control_notification_addresses
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_addresses_update
BEFORE UPDATE ON control_notification_addresses
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id) AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_addresses_delete
BEFORE DELETE ON control_notification_addresses
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_digest_items_insert
BEFORE INSERT ON control_notification_digest_items
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_digest_items_update
BEFORE UPDATE ON control_notification_digest_items
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id) AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_digest_items_delete
BEFORE DELETE ON control_notification_digest_items
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
