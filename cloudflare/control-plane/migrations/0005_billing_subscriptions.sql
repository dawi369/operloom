-- Plans and entitlements: one subscription row per workspace, one usage report per day.
CREATE TABLE control_workspace_subscriptions (
  workspace_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'cancelled')),
  provider TEXT NOT NULL CHECK (provider IN ('manual', 'stripe')),
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  current_period_end TEXT,
  seats INTEGER NOT NULL DEFAULT 1 CHECK (seats >= 1),
  updated_by_user_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_control_workspace_subscriptions_provider
  ON control_workspace_subscriptions (provider, provider_subscription_id);

CREATE TABLE control_billing_usage_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_calls INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reported', 'skipped')),
  provider_reference TEXT,
  reported_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, day)
);

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

CREATE TRIGGER export_fence_control_billing_usage_reports_insert
BEFORE INSERT ON control_billing_usage_reports
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_billing_usage_reports_update
BEFORE UPDATE ON control_billing_usage_reports
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id) AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_billing_usage_reports_delete
BEFORE DELETE ON control_billing_usage_reports
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
