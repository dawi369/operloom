DROP TABLE IF EXISTS runtime_spans;
DROP TABLE IF EXISTS runtime_traces;
DROP TABLE IF EXISTS chat_runs;
DROP TABLE IF EXISTS chat_policy_decisions;
DROP TABLE IF EXISTS chat_intents;
DROP TABLE IF EXISTS chat_threads;
DROP TABLE IF EXISTS chat_sessions;
DROP TABLE IF EXISTS control_plane_events;
DROP TABLE IF EXISTS control_operator_alerts;
DROP TABLE IF EXISTS control_audit_events;
DROP TABLE IF EXISTS control_trigger_dispatches;
DROP TABLE IF EXISTS control_triggers;
DROP TABLE IF EXISTS control_managed_state;
DROP TABLE IF EXISTS control_decisions;
DROP TABLE IF EXISTS control_kill_switches;
DROP TABLE IF EXISTS control_action_ledger;
DROP TABLE IF EXISTS control_action_proposals;
DROP TABLE IF EXISTS control_connection_capabilities;
DROP TABLE IF EXISTS control_connection_oauth_states;
DROP TABLE IF EXISTS control_connections;
DROP TABLE IF EXISTS control_notification_deliveries;
DROP TABLE IF EXISTS control_notification_preferences;
DROP TABLE IF EXISTS control_client_devices;
DROP TABLE IF EXISTS control_deletion_receipts;
DROP TABLE IF EXISTS control_data_export_objects;
DROP TABLE IF EXISTS control_data_export_rows;
DROP TABLE IF EXISTS control_workspace_write_fences;
DROP TABLE IF EXISTS control_data_jobs;
DROP TABLE IF EXISTS control_retention_policies;
DROP TABLE IF EXISTS control_artifacts;
DROP TABLE IF EXISTS control_tool_calls;
DROP TABLE IF EXISTS control_demo_budget_alerts;
DROP TABLE IF EXISTS control_demo_daily_usage;
DROP TABLE IF EXISTS control_approval_requests;
DROP TABLE IF EXISTS control_runs;
DROP TABLE IF EXISTS control_workflow_intents;
DROP TABLE IF EXISTS control_policy_decisions;
DROP TABLE IF EXISTS control_request_nonces;
DROP TABLE IF EXISTS tool_permissions;
DROP TABLE IF EXISTS active_agent_preferences;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS active_workspace_preferences;
DROP TABLE IF EXISTS workspaces;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  account_source TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deletion_requested_by_user_id TEXT,
  deletion_requested_at TEXT,
  purge_after TEXT,
  purged_at TEXT
);

CREATE UNIQUE INDEX idx_workspaces_account_default
  ON workspaces (account_id, is_default)
  WHERE is_default = 1;

CREATE INDEX idx_workspaces_account
  ON workspaces (account_id, status, is_default DESC, created_at ASC);

CREATE INDEX idx_workspaces_purge_due
  ON workspaces (status, purge_after)
  WHERE status = 'quarantined' AND purge_after IS NOT NULL;

CREATE TABLE active_workspace_preferences (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, account_id)
);

CREATE INDEX idx_active_workspace_preferences_workspace
  ON active_workspace_preferences (workspace_id);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  roles_json TEXT NOT NULL DEFAULT '[]',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, workspace_id)
);

CREATE INDEX idx_memberships_scope
  ON memberships (user_id, workspace_id, status);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_agents_workspace_default
  ON agents (workspace_id, is_default)
  WHERE is_default = 1;

CREATE INDEX idx_agents_workspace_active
  ON agents (workspace_id, status, is_default DESC, created_at ASC);

CREATE TABLE active_agent_preferences (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

CREATE INDEX idx_active_agent_preferences_agent
  ON active_agent_preferences (agent_id);

CREATE TABLE tool_permissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  status TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, workspace_id, agent_id, tool_id)
);

CREATE INDEX idx_tool_permissions_scope
  ON tool_permissions (user_id, workspace_id, agent_id, status);

CREATE TABLE control_policy_decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  policy_reference TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_control_policy_decisions_scope_latest
  ON control_policy_decisions (user_id, workspace_id, created_at DESC);

CREATE TABLE control_request_nonces (
  nonce TEXT PRIMARY KEY,
  signature_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_control_request_nonces_expires
  ON control_request_nonces (expires_at);

CREATE TABLE control_workflow_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  type TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE control_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  workflow_intent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  stage TEXT,
  engine TEXT,
  heartbeat_at TEXT,
  last_event_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  cancelled_at TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_control_runs_scope_latest
  ON control_runs (user_id, workspace_id, updated_at DESC, created_at DESC);

CREATE TABLE control_approval_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  workflow_intent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_control_approval_requests_scope_latest
  ON control_approval_requests (user_id, workspace_id, updated_at DESC, created_at DESC);

CREATE INDEX idx_control_approval_requests_run
  ON control_approval_requests (user_id, workspace_id, run_id, created_at ASC);

CREATE TABLE control_tool_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  workflow_intent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  data_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_control_tool_calls_run
  ON control_tool_calls (user_id, workspace_id, run_id, created_at ASC);

CREATE TABLE control_artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  title TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
, storage_provider TEXT NOT NULL DEFAULT 'external', storage_key TEXT, content_sha256 TEXT, retention_class TEXT NOT NULL DEFAULT 'standard', expires_at TEXT, deleted_at TEXT);

CREATE INDEX idx_control_artifacts_expiry
  ON control_artifacts (expires_at, created_at)
  WHERE deleted_at IS NULL AND expires_at IS NOT NULL;

CREATE TABLE control_retention_policies (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  artifact_retention_days INTEGER NOT NULL DEFAULT 90
    CHECK (artifact_retention_days BETWEEN 1 AND 3650),
  operational_event_retention_days INTEGER NOT NULL DEFAULT 30
    CHECK (operational_event_retention_days BETWEEN 1 AND 3650),
  runtime_trace_retention_days INTEGER NOT NULL DEFAULT 14
    CHECK (runtime_trace_retention_days BETWEEN 1 AND 3650),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  chat_message_retention_days INTEGER NOT NULL DEFAULT 90
    CHECK (chat_message_retention_days BETWEEN 1 AND 3650),
  run_payload_retention_days INTEGER NOT NULL DEFAULT 90
    CHECK (run_payload_retention_days BETWEEN 1 AND 3650),
  audit_action_retention_days INTEGER NOT NULL DEFAULT 365
    CHECK (audit_action_retention_days BETWEEN 365 AND 3650),
  confirmed_at TEXT,
  confirmed_by_user_id TEXT,
  PRIMARY KEY (user_id, workspace_id)
);

CREATE UNIQUE INDEX idx_control_retention_policies_workspace
  ON control_retention_policies (workspace_id);

CREATE TRIGGER control_artifacts_default_expiry
AFTER INSERT ON control_artifacts
WHEN NEW.retention_class = 'standard' AND NEW.expires_at IS NULL
BEGIN
  UPDATE control_artifacts
  SET expires_at = strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    NEW.created_at,
    '+' || COALESCE(
      (
        SELECT artifact_retention_days
        FROM control_retention_policies
        WHERE workspace_id = NEW.workspace_id
      ),
      90
    ) || ' days'
  )
  WHERE id = NEW.id;
END;

CREATE TABLE control_data_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('export', 'purge')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'expired')),
  cursor_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT NOT NULL DEFAULT '{}',
  storage_key TEXT,
  content_sha256 TEXT,
  size_bytes INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  expires_at TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  last_error_code TEXT,
  last_failed_at TEXT,
  manual_retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_control_data_jobs_scope_latest
  ON control_data_jobs (user_id, workspace_id, created_at DESC);

CREATE INDEX idx_control_data_jobs_runnable
  ON control_data_jobs (status, lease_expires_at, created_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX idx_control_data_jobs_failed_purge
  ON control_data_jobs (workspace_id, kind, status, updated_at DESC)
  WHERE kind = 'purge' AND status = 'failed';

CREATE TABLE control_workspace_write_fences (
  workspace_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'releasing')),
  lease_owner TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_control_workspace_write_fences_lease
  ON control_workspace_write_fences (status, lease_expires_at);

CREATE TABLE control_data_export_rows (
  job_id TEXT NOT NULL,
  collection_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, collection_name, row_key)
);

CREATE INDEX idx_control_data_export_rows_page
  ON control_data_export_rows (job_id, collection_name, row_key);

CREATE TABLE control_data_export_objects (
  job_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  size_bytes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pinned', 'verified')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, artifact_id)
);

CREATE INDEX idx_control_data_export_objects_storage
  ON control_data_export_objects (storage_key, status);

CREATE TABLE control_deletion_receipts (
  receipt_sha256 TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);

CREATE INDEX idx_control_deletion_receipts_completed
  ON control_deletion_receipts (completed_at DESC);

CREATE TABLE control_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  principal TEXT NOT NULL CHECK (principal IN ('app', 'user')),
  credential_class TEXT NOT NULL CHECK (credential_class IN ('oauth2', 'api_key')),
  status TEXT NOT NULL CHECK (status IN ('authorization_required', 'authorized', 'refresh_required', 'unhealthy', 'revoked')),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  vault_object_id TEXT,
  vault_version TEXT,
  token_expires_at TEXT,
  refresh_lease_owner TEXT,
  refresh_lease_expires_at TEXT,
  last_used_at TEXT,
  last_health_at TEXT,
  last_error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (user_id, workspace_id, agent_id, pack_id, connection_id)
);

CREATE INDEX idx_control_connections_scope
  ON control_connections (user_id, workspace_id, agent_id, status, updated_at DESC);

CREATE TABLE control_connection_oauth_states (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  connection_record_id TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  pkce_verifier_vault_object_id TEXT NOT NULL,
  pkce_verifier_vault_version TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_control_connection_oauth_states_expiry
  ON control_connection_oauth_states (expires_at, used_at);

CREATE TABLE control_action_proposals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  workflow_intent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_call_id TEXT,
  pack_id TEXT NOT NULL,
  pack_version TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  binding_version INTEGER NOT NULL,
  tool_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  connection_record_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approval_requested', 'approved', 'executing', 'executed', 'failed', 'outcome_unknown', 'reconciled', 'cancelled', 'expired')),
  summary TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  policy_decision_id TEXT,
  approval_request_id TEXT,
  external_reference TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE (user_id, workspace_id, tool_id, idempotency_key)
);

CREATE INDEX idx_control_action_proposals_scope_latest
  ON control_action_proposals (user_id, workspace_id, status, created_at DESC);

CREATE TABLE control_action_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'blocked', 'executing', 'executed', 'failed', 'outcome_unknown', 'reconciled', 'cancelled', 'reviewed')),
  summary TEXT NOT NULL,
  request_sha256 TEXT,
  response_sha256 TEXT,
  external_reference TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (proposal_id, sequence)
);

CREATE INDEX idx_control_action_ledger_scope_latest
  ON control_action_ledger (user_id, workspace_id, created_at DESC);

CREATE TABLE control_kill_switches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'pack', 'tool', 'connection')),
  scope_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  reason TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, workspace_id, scope_kind, scope_id)
);

CREATE INDEX idx_control_kill_switches_scope
  ON control_kill_switches (user_id, workspace_id, enabled, scope_kind, scope_id);

CREATE TABLE control_client_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  provider TEXT NOT NULL CHECK (provider = 'expo'),
  vault_object_id TEXT NOT NULL,
  vault_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  last_seen_at TEXT NOT NULL,
  app_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (user_id, workspace_id, installation_id)
);

CREATE INDEX idx_control_client_devices_scope
  ON control_client_devices (user_id, workspace_id, status, updated_at DESC);

CREATE TABLE control_notification_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  approval_required INTEGER NOT NULL DEFAULT 1 CHECK (approval_required IN (0, 1)),
  terminal_outcomes INTEGER NOT NULL DEFAULT 1 CHECK (terminal_outcomes IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, workspace_id)
);

CREATE TABLE control_notification_deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  route TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'expired')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provider_ticket_id TEXT,
  last_error_code TEXT,
  expires_at TEXT NOT NULL,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (device_id, event_type, target_type, target_id)
);

CREATE INDEX idx_control_notification_deliveries_pending
  ON control_notification_deliveries (status, expires_at, updated_at);

CREATE INDEX idx_control_notification_deliveries_scope
  ON control_notification_deliveries (user_id, workspace_id, created_at DESC);

CREATE TABLE control_connection_capabilities (
  id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  connection_record_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workflow_intent_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  allowed_url TEXT NOT NULL,
  allowed_method TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_control_connection_capabilities_expiry
  ON control_connection_capabilities (expires_at, consumed_at);

CREATE INDEX idx_control_connection_capabilities_scope
  ON control_connection_capabilities (user_id, workspace_id, run_id, tool_call_id);

CREATE TABLE control_operator_alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  summary TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  dedup_key TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  last_delivery_at TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, workspace_id, dedup_key)
);

CREATE INDEX idx_control_operator_alerts_delivery
  ON control_operator_alerts (delivery_status, delivery_attempts, created_at)
  WHERE status = 'open';

CREATE INDEX idx_control_operator_alerts_scope
  ON control_operator_alerts (user_id, workspace_id, status, created_at DESC);

CREATE TABLE control_decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  thesis TEXT NOT NULL,
  status TEXT NOT NULL,
  provenance_refs_json TEXT NOT NULL DEFAULT '[]',
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE control_managed_state (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  state_type TEXT NOT NULL,
  state_key TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, workspace_id, agent_id, namespace, state_type, state_key)
);

CREATE INDEX idx_control_managed_state_scope_latest
  ON control_managed_state (
    user_id, workspace_id, agent_id, namespace, state_type, updated_at DESC
  );

CREATE TABLE control_triggers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  pack_trigger_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  status TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  config_json TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  max_concurrent_runs INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  next_trigger_at TEXT,
  last_triggered_at TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  public_id TEXT,
  secret_hash TEXT,
  UNIQUE (user_id, workspace_id, agent_id, pack_id, pack_trigger_id)
);

CREATE UNIQUE INDEX idx_control_triggers_public_id
  ON control_triggers (public_id)
  WHERE public_id IS NOT NULL;

CREATE INDEX idx_control_triggers_scope_latest
  ON control_triggers (user_id, workspace_id, agent_id, updated_at DESC);

CREATE INDEX idx_control_triggers_due
  ON control_triggers (status, next_trigger_at);

CREATE TABLE control_trigger_dispatches (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  previous_run_id TEXT,
  scheduled_for TEXT,
  received_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (trigger_id, idempotency_key),
  UNIQUE (run_id)
);

CREATE INDEX idx_control_trigger_dispatches_scope_latest
  ON control_trigger_dispatches (user_id, workspace_id, agent_id, created_at DESC);

CREATE INDEX idx_control_trigger_dispatches_recovery
  ON control_trigger_dispatches (status, lease_expires_at);

CREATE TABLE control_audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_control_audit_scope_time
  ON control_audit_events (user_id, workspace_id, created_at ASC);

CREATE TABLE control_plane_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_control_plane_events_scope_latest
  ON control_plane_events (user_id, workspace_id, created_at DESC, id DESC);

CREATE TABLE runtime_traces (
  trace_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  root_name TEXT NOT NULL,
  summary TEXT,
  bottleneck_span_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_runtime_traces_scope_latest
  ON runtime_traces (user_id, workspace_id, updated_at DESC, started_at DESC);

CREATE TABLE runtime_spans (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  layer TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_runtime_spans_trace_time
  ON runtime_spans (user_id, workspace_id, trace_id, started_at ASC, created_at ASC);

CREATE TABLE chat_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  active_thread_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX idx_chat_sessions_scope_latest
  ON chat_sessions (user_id, workspace_id, updated_at DESC, created_at DESC);

CREATE TABLE chat_threads (
  thread_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  upstream_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX idx_chat_threads_scope_latest
  ON chat_threads (user_id, workspace_id, updated_at DESC, created_at DESC);

CREATE INDEX idx_chat_threads_session_latest
  ON chat_threads (user_id, workspace_id, session_id, updated_at DESC, created_at DESC);

CREATE TABLE chat_intents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_chat_intents_thread_latest
  ON chat_intents (user_id, workspace_id, thread_id, updated_at DESC, created_at DESC);

CREATE TABLE chat_policy_decisions (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  limits_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_chat_policy_decisions_thread_latest
  ON chat_policy_decisions (user_id, workspace_id, thread_id, created_at DESC);

CREATE TABLE chat_runs (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  policy_decision_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  upstream_run_id TEXT,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_chat_runs_thread_latest
  ON chat_runs (user_id, workspace_id, thread_id, updated_at DESC, started_at DESC);

CREATE UNIQUE INDEX idx_chat_runs_one_running_per_thread
  ON chat_runs (user_id, workspace_id, thread_id)
  WHERE status = 'running';

CREATE TRIGGER export_fence_users_update
BEFORE UPDATE ON users
WHEN EXISTS (
  SELECT 1 FROM memberships membership
  JOIN control_workspace_write_fences fence
    ON fence.workspace_id = membership.workspace_id
  WHERE membership.user_id = OLD.id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_users_delete
BEFORE DELETE ON users
WHEN EXISTS (
  SELECT 1 FROM memberships membership
  JOIN control_workspace_write_fences fence
    ON fence.workspace_id = membership.workspace_id
  WHERE membership.user_id = OLD.id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_workspaces_update
BEFORE UPDATE ON workspaces
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_workspaces_delete
BEFORE DELETE ON workspaces
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_active_workspace_preferences_insert
BEFORE INSERT ON active_workspace_preferences
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_active_workspace_preferences_update
BEFORE UPDATE ON active_workspace_preferences
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_active_workspace_preferences_delete
BEFORE DELETE ON active_workspace_preferences
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_memberships_insert
BEFORE INSERT ON memberships
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_memberships_update
BEFORE UPDATE ON memberships
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_memberships_delete
BEFORE DELETE ON memberships
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_agents_insert
BEFORE INSERT ON agents
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_agents_update
BEFORE UPDATE ON agents
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_agents_delete
BEFORE DELETE ON agents
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_active_agent_preferences_insert
BEFORE INSERT ON active_agent_preferences
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_active_agent_preferences_update
BEFORE UPDATE ON active_agent_preferences
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_active_agent_preferences_delete
BEFORE DELETE ON active_agent_preferences
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_tool_permissions_insert
BEFORE INSERT ON tool_permissions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_tool_permissions_update
BEFORE UPDATE ON tool_permissions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_tool_permissions_delete
BEFORE DELETE ON tool_permissions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_policy_decisions_insert
BEFORE INSERT ON control_policy_decisions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_policy_decisions_update
BEFORE UPDATE ON control_policy_decisions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_policy_decisions_delete
BEFORE DELETE ON control_policy_decisions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_workflow_intents_insert
BEFORE INSERT ON control_workflow_intents
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_workflow_intents_update
BEFORE UPDATE ON control_workflow_intents
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_workflow_intents_delete
BEFORE DELETE ON control_workflow_intents
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_runs_insert
BEFORE INSERT ON control_runs
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_runs_update
BEFORE UPDATE ON control_runs
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_runs_delete
BEFORE DELETE ON control_runs
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_approval_requests_insert
BEFORE INSERT ON control_approval_requests
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_approval_requests_update
BEFORE UPDATE ON control_approval_requests
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_approval_requests_delete
BEFORE DELETE ON control_approval_requests
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_tool_calls_insert
BEFORE INSERT ON control_tool_calls
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_tool_calls_update
BEFORE UPDATE ON control_tool_calls
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_tool_calls_delete
BEFORE DELETE ON control_tool_calls
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_artifacts_insert
BEFORE INSERT ON control_artifacts
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_artifacts_update
BEFORE UPDATE ON control_artifacts
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_artifacts_delete
BEFORE DELETE ON control_artifacts
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_retention_policies_insert
BEFORE INSERT ON control_retention_policies
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_retention_policies_update
BEFORE UPDATE ON control_retention_policies
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_retention_policies_delete
BEFORE DELETE ON control_retention_policies
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_connections_insert
BEFORE INSERT ON control_connections
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_connections_update
BEFORE UPDATE ON control_connections
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_connections_delete
BEFORE DELETE ON control_connections
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_action_proposals_insert
BEFORE INSERT ON control_action_proposals
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_action_proposals_update
BEFORE UPDATE ON control_action_proposals
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_action_proposals_delete
BEFORE DELETE ON control_action_proposals
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_action_ledger_insert
BEFORE INSERT ON control_action_ledger
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_action_ledger_update
BEFORE UPDATE ON control_action_ledger
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_action_ledger_delete
BEFORE DELETE ON control_action_ledger
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_kill_switches_insert
BEFORE INSERT ON control_kill_switches
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_kill_switches_update
BEFORE UPDATE ON control_kill_switches
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_kill_switches_delete
BEFORE DELETE ON control_kill_switches
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_operator_alerts_insert
BEFORE INSERT ON control_operator_alerts
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_operator_alerts_update
BEFORE UPDATE ON control_operator_alerts
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_operator_alerts_delete
BEFORE DELETE ON control_operator_alerts
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_decisions_insert
BEFORE INSERT ON control_decisions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_decisions_update
BEFORE UPDATE ON control_decisions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_decisions_delete
BEFORE DELETE ON control_decisions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_managed_state_insert
BEFORE INSERT ON control_managed_state
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_managed_state_update
BEFORE UPDATE ON control_managed_state
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_managed_state_delete
BEFORE DELETE ON control_managed_state
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_triggers_insert
BEFORE INSERT ON control_triggers
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_triggers_update
BEFORE UPDATE ON control_triggers
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_triggers_delete
BEFORE DELETE ON control_triggers
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_trigger_dispatches_insert
BEFORE INSERT ON control_trigger_dispatches
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_trigger_dispatches_update
BEFORE UPDATE ON control_trigger_dispatches
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_trigger_dispatches_delete
BEFORE DELETE ON control_trigger_dispatches
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_audit_events_insert
BEFORE INSERT ON control_audit_events
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_audit_events_update
BEFORE UPDATE ON control_audit_events
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_audit_events_delete
BEFORE DELETE ON control_audit_events
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_control_plane_events_insert
BEFORE INSERT ON control_plane_events
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_plane_events_update
BEFORE UPDATE ON control_plane_events
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_plane_events_delete
BEFORE DELETE ON control_plane_events
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_runtime_traces_insert
BEFORE INSERT ON runtime_traces
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_runtime_traces_update
BEFORE UPDATE ON runtime_traces
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_runtime_traces_delete
BEFORE DELETE ON runtime_traces
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_runtime_spans_insert
BEFORE INSERT ON runtime_spans
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_runtime_spans_update
BEFORE UPDATE ON runtime_spans
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_runtime_spans_delete
BEFORE DELETE ON runtime_spans
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_chat_sessions_insert
BEFORE INSERT ON chat_sessions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_chat_sessions_update
BEFORE UPDATE ON chat_sessions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_chat_sessions_delete
BEFORE DELETE ON chat_sessions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_chat_threads_insert
BEFORE INSERT ON chat_threads
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_chat_threads_update
BEFORE UPDATE ON chat_threads
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_chat_threads_delete
BEFORE DELETE ON chat_threads
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_chat_intents_insert
BEFORE INSERT ON chat_intents
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_chat_intents_update
BEFORE UPDATE ON chat_intents
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_chat_intents_delete
BEFORE DELETE ON chat_intents
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_chat_policy_decisions_insert
BEFORE INSERT ON chat_policy_decisions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_chat_policy_decisions_update
BEFORE UPDATE ON chat_policy_decisions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_chat_policy_decisions_delete
BEFORE DELETE ON chat_policy_decisions
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;


CREATE TRIGGER export_fence_chat_runs_insert
BEFORE INSERT ON chat_runs
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_chat_runs_update
BEFORE UPDATE ON chat_runs
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id)
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_chat_runs_delete
BEFORE DELETE ON chat_runs
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id
    AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_export_in_progress');
END;

CREATE TRIGGER export_fence_control_client_devices_insert
BEFORE INSERT ON control_client_devices
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_client_devices_update
BEFORE UPDATE ON control_client_devices
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id) AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_client_devices_delete
BEFORE DELETE ON control_client_devices
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_preferences_insert
BEFORE INSERT ON control_notification_preferences
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_preferences_update
BEFORE UPDATE ON control_notification_preferences
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id) AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_notification_preferences_delete
BEFORE DELETE ON control_notification_preferences
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

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

CREATE TABLE control_demo_daily_usage (
  user_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  chat_count INTEGER NOT NULL DEFAULT 0,
  workflow_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, usage_date)
);

CREATE TABLE control_demo_budget_alerts (
  usage_month TEXT NOT NULL,
  threshold_percent INTEGER NOT NULL,
  usage_usd REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (usage_month, threshold_percent)
);
