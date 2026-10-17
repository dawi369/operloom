-- Billing providers now include Polar; SQLite cannot alter a CHECK, so the table is rebuilt.
DROP TRIGGER IF EXISTS export_fence_control_workspace_subscriptions_insert;
DROP TRIGGER IF EXISTS export_fence_control_workspace_subscriptions_update;
DROP TRIGGER IF EXISTS export_fence_control_workspace_subscriptions_delete;
DROP INDEX IF EXISTS idx_control_workspace_subscriptions_provider;
ALTER TABLE control_workspace_subscriptions RENAME TO control_workspace_subscriptions_legacy;

CREATE TABLE control_workspace_subscriptions (
  workspace_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'cancelled')),
  provider TEXT NOT NULL CHECK (provider IN ('manual', 'stripe', 'polar')),
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  current_period_end TEXT,
  seats INTEGER NOT NULL DEFAULT 1 CHECK (seats >= 1),
  updated_by_user_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_control_workspace_subscriptions_provider
  ON control_workspace_subscriptions (provider, provider_subscription_id);

INSERT INTO control_workspace_subscriptions
SELECT workspace_id, plan_id, status, provider, provider_customer_id, provider_subscription_id,
       current_period_end, seats, updated_by_user_id, updated_at
FROM control_workspace_subscriptions_legacy;

DROP TABLE control_workspace_subscriptions_legacy;

CREATE TRIGGER export_fence_control_workspace_subscriptions_insert
BEFORE INSERT ON control_workspace_subscriptions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_workspace_subscriptions_update
BEFORE UPDATE ON control_workspace_subscriptions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id) AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_workspace_subscriptions_delete
BEFORE DELETE ON control_workspace_subscriptions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
