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
  updated_at TEXT NOT NULL, runtime_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(runtime_revision) = 'integer' AND runtime_revision >= 0 AND runtime_revision <= 9007199254740991), upgrade_validation_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(upgrade_validation_revision) = 'integer' AND upgrade_validation_revision >= 0 AND upgrade_validation_revision <= 9007199254740991),
  effect_target TEXT NOT NULL DEFAULT 'simulation' CHECK (effect_target IN ('simulation','external')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  settings_version INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(settings_version) = 'integer' AND settings_version >= 0 AND settings_version <= 9007199254740991)
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
  effect_target TEXT NOT NULL DEFAULT 'external' CHECK(effect_target IN ('simulation','external')),
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

CREATE TABLE control_webhook_endpoints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  url TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  secret_version INTEGER NOT NULL DEFAULT 1,
  cursor_created_at TEXT NOT NULL,
  cursor_event_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_control_webhook_endpoints_scope
  ON control_webhook_endpoints (user_id, workspace_id, status);

CREATE TABLE control_webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_expires_at TEXT,
  last_status_code INTEGER,
  last_error_code TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (endpoint_id, event_id)
);

CREATE INDEX idx_control_webhook_deliveries_due
  ON control_webhook_deliveries (status, next_attempt_at);

CREATE INDEX idx_control_webhook_deliveries_endpoint
  ON control_webhook_deliveries (endpoint_id, created_at DESC);

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

CREATE TRIGGER export_fence_control_webhook_endpoints_insert
BEFORE INSERT ON control_webhook_endpoints
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_webhook_endpoints_update
BEFORE UPDATE ON control_webhook_endpoints
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id) AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_webhook_endpoints_delete
BEFORE DELETE ON control_webhook_endpoints
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_webhook_deliveries_insert
BEFORE INSERT ON control_webhook_deliveries
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_webhook_deliveries_update
BEFORE UPDATE ON control_webhook_deliveries
WHEN EXISTS (
  SELECT 1 FROM control_workspace_write_fences fence
  WHERE fence.workspace_id IN (OLD.workspace_id, NEW.workspace_id) AND fence.status = 'active'
    AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_webhook_deliveries_delete
BEFORE DELETE ON control_webhook_deliveries
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

CREATE TABLE control_state_records (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, namespace TEXT NOT NULL,
  kind TEXT NOT NULL, record_key TEXT NOT NULL, schema_version INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0), data_json TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(scope_id, namespace, kind, record_key)
);
CREATE INDEX idx_state_records_scope ON control_state_records(scope_id, namespace, kind, record_key);
CREATE TABLE control_state_commits (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT state_precondition CHECK(preconditions_met = 1),
  UNIQUE(scope_id, idempotency_key)
);
CREATE TABLE control_state_entries (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, entry_key TEXT NOT NULL,
  commit_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('decision', 'effect')),
  data_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(scope_id, entry_key)
);
CREATE TABLE control_state_outbox (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, event_key TEXT NOT NULL,
  commit_id TEXT NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, delivered_at TEXT, UNIQUE(scope_id, event_key)
);

CREATE TABLE control_state_indexes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, namespace TEXT NOT NULL,
  kind TEXT NOT NULL, record_key TEXT NOT NULL, index_name TEXT NOT NULL, value_json TEXT NOT NULL,
  UNIQUE(scope_id, namespace, kind, record_key, index_name)
);
CREATE INDEX idx_state_index_lookup ON control_state_indexes(scope_id, namespace, kind, index_name, value_json, record_key);

CREATE TRIGGER export_fence_control_state_records_insert
BEFORE INSERT ON control_state_records
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_records_update
BEFORE UPDATE ON control_state_records
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_records_delete
BEFORE DELETE ON control_state_records
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_commits_insert
BEFORE INSERT ON control_state_commits
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_commits_update
BEFORE UPDATE ON control_state_commits
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_commits_delete
BEFORE DELETE ON control_state_commits
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_entries_insert
BEFORE INSERT ON control_state_entries
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_entries_update
BEFORE UPDATE ON control_state_entries
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_entries_delete
BEFORE DELETE ON control_state_entries
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_outbox_insert
BEFORE INSERT ON control_state_outbox
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_outbox_update
BEFORE UPDATE ON control_state_outbox
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_outbox_delete
BEFORE DELETE ON control_state_outbox
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_indexes_insert
BEFORE INSERT ON control_state_indexes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_indexes_update
BEFORE UPDATE ON control_state_indexes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_indexes_delete
BEFORE DELETE ON control_state_indexes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

-- D1 remains the sole state authority. Durable migration cursors and receipts are
-- required because a request deadline cannot migrate an unbounded record set.
CREATE TABLE control_state_schema_heads (
  scope_id TEXT NOT NULL, namespace TEXT NOT NULL, kind TEXT NOT NULL,
  user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','migrating')),
  migration_id TEXT NOT NULL, PRIMARY KEY(scope_id, namespace, kind)
);
CREATE TABLE control_state_migrations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  scope_id TEXT NOT NULL, migration_key TEXT NOT NULL, plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
  namespace TEXT NOT NULL, kind TEXT NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed')), revision INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0, after_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT state_migration_precondition CHECK(preconditions_met = 1),
  UNIQUE(scope_id, migration_key)
);
CREATE TABLE control_state_migration_steps (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  migration_id TEXT NOT NULL, expected_revision INTEGER NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT state_migration_step_precondition CHECK(preconditions_met = 1),
  UNIQUE(migration_id, expected_revision)
);

CREATE TRIGGER export_fence_control_state_schema_heads_insert
BEFORE INSERT ON control_state_schema_heads
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_schema_heads_update
BEFORE UPDATE ON control_state_schema_heads
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_schema_heads_delete
BEFORE DELETE ON control_state_schema_heads
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migrations_insert
BEFORE INSERT ON control_state_migrations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migrations_update
BEFORE UPDATE ON control_state_migrations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migrations_delete
BEFORE DELETE ON control_state_migrations
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migration_steps_insert
BEFORE INSERT ON control_state_migration_steps
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migration_steps_update
BEFORE UPDATE ON control_state_migration_steps
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migration_steps_delete
BEFORE DELETE ON control_state_migration_steps
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

-- Keep every reviewed replacement plan and receipt; editing a running job alone
-- would lose provenance and could repeat a repair after a lost response.
CREATE TABLE control_state_migration_repairs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  migration_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  previous_plan_json TEXT NOT NULL, replacement_plan_json TEXT NOT NULL,
  expected_revision INTEGER NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT state_migration_repair_precondition CHECK(preconditions_met = 1),
  UNIQUE(migration_id, idempotency_key)
);

CREATE TRIGGER export_fence_control_state_migration_repairs_insert
BEFORE INSERT ON control_state_migration_repairs
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migration_repairs_update
BEFORE UPDATE ON control_state_migration_repairs
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_state_migration_repairs_delete
BEFORE DELETE ON control_state_migration_repairs
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER agent_revision_control_run_insert
BEFORE INSERT ON control_runs
WHEN EXISTS (SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND a.workspace_id = NEW.workspace_id
  AND (COALESCE(json_extract(NEW.data_json, '$.agentRevision'), 0) IS NOT a.runtime_revision
    OR COALESCE(json_extract(NEW.data_json, '$.effectTarget'), 'simulation') IS NOT a.effect_target))
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_conflict'); END;

CREATE TRIGGER agent_revision_control_run_resume
BEFORE UPDATE ON control_runs
WHEN NEW.status IN ('queued', 'running', 'waiting', 'interrupted')
  AND EXISTS (SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND a.workspace_id = NEW.workspace_id
    AND (COALESCE(json_extract(NEW.data_json, '$.agentRevision'), 0) IS NOT a.runtime_revision))
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_conflict'); END;

CREATE TRIGGER agent_revision_chat_run_insert
BEFORE INSERT ON chat_runs
WHEN EXISTS (SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND a.workspace_id = NEW.workspace_id
  AND (COALESCE(json_extract(NEW.metadata_json, '$.agentRevision'), 0) IS NOT a.runtime_revision
    OR COALESCE(json_extract(NEW.metadata_json, '$.effectTarget'), 'simulation') IS NOT a.effect_target))
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_conflict'); END;

CREATE TRIGGER agent_revision_chat_run_resume
BEFORE UPDATE ON chat_runs
WHEN NEW.status = 'running'
  AND EXISTS (SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND a.workspace_id = NEW.workspace_id
    AND (COALESCE(json_extract(NEW.metadata_json, '$.agentRevision'), 0) IS NOT a.runtime_revision))
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_conflict'); END;

CREATE TRIGGER agent_revision_control_run_immutable
BEFORE UPDATE ON control_runs
WHEN NEW.agent_id IS NOT OLD.agent_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR COALESCE(json_extract(NEW.data_json, '$.agentRevision'), 0) IS NOT COALESCE(json_extract(OLD.data_json, '$.agentRevision'), 0)
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_conflict'); END;

CREATE TRIGGER agent_revision_chat_run_immutable
BEFORE UPDATE ON chat_runs
WHEN NEW.agent_id IS NOT OLD.agent_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR COALESCE(json_extract(NEW.metadata_json, '$.agentRevision'), 0) IS NOT COALESCE(json_extract(OLD.metadata_json, '$.agentRevision'), 0)
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_conflict'); END;

-- A future upgrade command must also archive snapshots, validate state/handler
-- compatibility and fence accepted-but-not-started commands. This is the atomic
-- execution barrier, not authorization to change a package snapshot directly.
CREATE TRIGGER agent_revision_monotonic
BEFORE UPDATE OF runtime_revision ON agents
WHEN NEW.runtime_revision != OLD.runtime_revision AND NEW.runtime_revision != OLD.runtime_revision + 1
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_invalid'); END;

-- The effect target belongs to the execution generation, so runs pinned to a revision keep one target.
CREATE TRIGGER agent_effect_target_revision
BEFORE UPDATE OF effect_target ON agents
WHEN NEW.effect_target IS NOT OLD.effect_target AND NEW.runtime_revision = OLD.runtime_revision
BEGIN SELECT RAISE(ABORT, 'agent_effect_target_revision_required'); END;

CREATE TRIGGER agent_revision_active_work
BEFORE UPDATE OF runtime_revision ON agents
WHEN NEW.runtime_revision != OLD.runtime_revision AND (
  EXISTS (SELECT 1 FROM control_runs r WHERE r.workspace_id = OLD.workspace_id AND r.agent_id = OLD.id
    AND r.status IN ('queued', 'running', 'waiting', 'interrupted'))
  OR EXISTS (SELECT 1 FROM chat_runs r WHERE r.workspace_id = OLD.workspace_id AND r.agent_id = OLD.id AND r.status = 'running')
  OR EXISTS (SELECT 1 FROM control_state_migrations m WHERE m.workspace_id = OLD.workspace_id AND m.agent_id = OLD.id AND m.status = 'running')
  OR EXISTS (SELECT 1 FROM control_action_proposals p WHERE p.workspace_id = OLD.workspace_id AND p.agent_id = OLD.id
    AND p.status IN ('proposed', 'approval_requested', 'approved', 'executing', 'outcome_unknown'))
)
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_busy'); END;

CREATE TABLE control_chat_commands (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  thread_id TEXT NOT NULL, instance_name TEXT NOT NULL, turn_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL, agent_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
  run_id TEXT UNIQUE, error_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, accepted_at TEXT, expires_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT chat_command_precondition CHECK (preconditions_met = 1),
  UNIQUE(user_id, workspace_id, thread_id, turn_id)
);
CREATE UNIQUE INDEX idx_chat_commands_active_thread ON control_chat_commands(user_id,workspace_id,thread_id) WHERE status IN ('pending','running');
CREATE INDEX idx_chat_commands_deadline ON control_chat_commands(status, expires_at, id);
CREATE INDEX idx_chat_commands_agent ON control_chat_commands(workspace_id, agent_id, status);
CREATE INDEX idx_chat_commands_instance ON control_chat_commands(instance_name, status);

CREATE TRIGGER export_fence_control_chat_commands_insert BEFORE INSERT ON control_chat_commands
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = NEW.workspace_id
 AND f.status = 'active' AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_chat_commands_update BEFORE UPDATE ON control_chat_commands
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = NEW.workspace_id
 AND f.status = 'active' AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_chat_commands_delete BEFORE DELETE ON control_chat_commands
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = OLD.workspace_id
 AND f.status = 'active' AND f.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER agent_revision_pending_chat_commands BEFORE UPDATE OF runtime_revision ON agents
WHEN NEW.runtime_revision != OLD.runtime_revision AND EXISTS (
 SELECT 1 FROM control_chat_commands c WHERE c.workspace_id = OLD.workspace_id AND c.agent_id = OLD.id
 AND c.status IN ('pending','running'))
BEGIN SELECT RAISE(ABORT, 'agent_runtime_revision_busy'); END;

CREATE TRIGGER chat_command_immutable BEFORE UPDATE ON control_chat_commands
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.agent_id IS NOT OLD.agent_id OR NEW.thread_id IS NOT OLD.thread_id
 OR NEW.instance_name IS NOT OLD.instance_name OR NEW.turn_id IS NOT OLD.turn_id
 OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.agent_revision IS NOT OLD.agent_revision
 OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT OLD.run_id)
 OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS NOT OLD.accepted_at)
 OR (OLD.status IN ('completed','failed','cancelled') AND NEW.status IS NOT OLD.status)
 OR (OLD.status = 'running' AND NEW.status = 'pending')
BEGIN SELECT RAISE(ABORT, 'chat_command_conflict'); END;

CREATE TRIGGER chat_command_run_admission BEFORE INSERT ON chat_runs
WHEN json_extract(NEW.metadata_json, '$.commandId') IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM control_chat_commands c WHERE c.id = json_extract(NEW.metadata_json, '$.commandId')
 AND c.user_id = NEW.user_id AND c.workspace_id = NEW.workspace_id AND c.agent_id = NEW.agent_id
 AND c.thread_id = NEW.thread_id AND c.agent_revision = COALESCE(json_extract(NEW.metadata_json, '$.agentRevision'),0)
 AND c.status = 'pending' AND c.accepted_at IS NOT NULL AND c.run_id IS NULL
 AND c.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND EXISTS (SELECT 1 FROM agents a JOIN workspaces w ON w.id = a.workspace_id
   JOIN memberships m ON m.workspace_id = w.id AND m.user_id = c.user_id
   JOIN users u ON u.id = m.user_id
   JOIN chat_threads t ON t.thread_id = c.thread_id AND t.user_id = c.user_id AND t.workspace_id = c.workspace_id AND t.agent_id = c.agent_id
   WHERE a.id = c.agent_id AND a.workspace_id = c.workspace_id AND a.runtime_revision = c.agent_revision
   AND a.status = 'active' AND w.status = 'active' AND m.status = 'active' AND u.status = 'active'
   AND t.status IN ('active','draft')))
BEGIN SELECT RAISE(ABORT, 'chat_command_conflict'); END;

CREATE TRIGGER chat_command_run_link AFTER INSERT ON chat_runs
WHEN json_extract(NEW.metadata_json, '$.commandId') IS NOT NULL
BEGIN UPDATE control_chat_commands SET status = 'running', run_id = NEW.id, updated_at = NEW.updated_at
 WHERE id = json_extract(NEW.metadata_json, '$.commandId'); END;

CREATE TRIGGER chat_command_run_pin BEFORE UPDATE ON chat_runs
WHEN json_extract(NEW.metadata_json, '$.commandId') IS NOT json_extract(OLD.metadata_json, '$.commandId')
BEGIN SELECT RAISE(ABORT, 'chat_command_conflict'); END;

CREATE TRIGGER chat_command_run_terminal AFTER UPDATE OF status ON chat_runs
WHEN NEW.status IN ('completed','failed','cancelled') AND NEW.status IS NOT OLD.status
BEGIN UPDATE control_chat_commands SET status = NEW.status, updated_at = NEW.updated_at,
 error_code = CASE WHEN NEW.status = 'failed' THEN COALESCE(json_extract(NEW.metadata_json, '$.errorCode'),'chat_execution_failed') ELSE error_code END
 WHERE run_id = NEW.id AND status IN ('pending','running'); END;

CREATE TRIGGER chat_command_event AFTER UPDATE ON control_chat_commands
WHEN NEW.status IS NOT OLD.status OR (NEW.accepted_at IS NOT NULL AND OLD.accepted_at IS NULL)
BEGIN INSERT INTO control_plane_events
 (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
 VALUES ('chat-command:' || NEW.id || ':' || NEW.status, NEW.user_id,NEW.workspace_id,NEW.agent_id,
 'chat.command.updated','Chat command ' || NEW.status,'chat_command',NEW.id,
 json_object('commandId',NEW.id,'threadId',NEW.thread_id,'messageId',NEW.turn_id,'status',NEW.status,'runId',NEW.run_id,'errorCode',NEW.error_code),NEW.updated_at)
 ON CONFLICT(id) DO NOTHING; END;

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

-- Context snapshots are canonical evidence, not executable handlers or model reasoning.
CREATE TABLE control_context_snapshots (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL, run_kind TEXT NOT NULL CHECK(run_kind IN ('workflow','chat')),
  agent_revision INTEGER NOT NULL, pack_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ready','blocked')), created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT context_snapshot_precondition CHECK(preconditions_met = 1),
  UNIQUE(user_id,workspace_id,agent_id,run_kind,run_id)
);
CREATE INDEX idx_context_snapshot_scope ON control_context_snapshots(user_id,workspace_id,agent_id,id);
CREATE TRIGGER immutable_control_context_snapshots BEFORE UPDATE ON control_context_snapshots
BEGIN SELECT RAISE(ABORT, 'context_snapshot_immutable'); END;

CREATE TRIGGER export_fence_control_context_snapshots_insert BEFORE INSERT ON control_context_snapshots
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_context_snapshots_update BEFORE UPDATE ON control_context_snapshots
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_context_snapshots_delete BEFORE DELETE ON control_context_snapshots
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

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

-- Canonical durable submission and step receipts; engine scheduling is a separate adapter.
CREATE TABLE control_durable_executions (
  run_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  workflow_intent_id TEXT NOT NULL UNIQUE, instance_id TEXT NOT NULL UNIQUE,
  submission_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, runtime_version TEXT NOT NULL,
  workflow_type TEXT NOT NULL, workflow_version TEXT NOT NULL, definition_hash TEXT NOT NULL,
  agent_revision INTEGER NOT NULL,
  effect_target TEXT NOT NULL DEFAULT 'simulation' CHECK(effect_target IN ('simulation','external')),
  agent_data_json TEXT NOT NULL, configuration_hash TEXT NOT NULL,
  input_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','started','closed')),
  max_steps INTEGER NOT NULL CHECK(max_steps BETWEEN 1 AND 128),
  deadline TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT durable_submission_precondition CHECK(preconditions_met = 1),
  UNIQUE(user_id,workspace_id,agent_id,submission_key)
);
CREATE INDEX idx_durable_execution_pending ON control_durable_executions(status,created_at);
CREATE INDEX idx_durable_execution_workspace ON control_durable_executions(workspace_id,run_id);
CREATE TABLE control_durable_steps (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL, step_key TEXT NOT NULL, step_version TEXT NOT NULL, request_hash TEXT NOT NULL,
  output_schema_json TEXT NOT NULL, replay_safe INTEGER NOT NULL CHECK(replay_safe IN (0,1)),
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 5),
  timeout_ms INTEGER NOT NULL CHECK(timeout_ms BETWEEN 1 AND 300000),
  attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 1 AND 5),
  active_attempt_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','outcome_unknown')),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(run_id,step_key)
);
CREATE INDEX idx_durable_step_scope ON control_durable_steps(workspace_id,run_id);
CREATE TABLE control_durable_step_attempts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL, step_id TEXT NOT NULL, attempt_index INTEGER NOT NULL CHECK(attempt_index BETWEEN 1 AND 5),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','outcome_unknown')),
  output_json TEXT, outcome_hash TEXT, error_code TEXT,
  started_at TEXT NOT NULL, finished_at TEXT,
  preconditions_met INTEGER NOT NULL CONSTRAINT durable_step_precondition CHECK(preconditions_met = 1),
  UNIQUE(step_id,attempt_index)
);
CREATE INDEX idx_durable_attempt_scope ON control_durable_step_attempts(workspace_id,run_id);
CREATE TABLE control_durable_step_outcomes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL, step_id TEXT NOT NULL, outcome_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed','failed','outcome_unknown')), created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT durable_outcome_precondition CHECK(preconditions_met = 1)
);
CREATE INDEX idx_durable_outcome_scope ON control_durable_step_outcomes(workspace_id,run_id);
CREATE TRIGGER immutable_durable_outcome BEFORE UPDATE ON control_durable_step_outcomes
BEGIN SELECT RAISE(ABORT,'durable_outcome_immutable'); END;
CREATE TRIGGER export_fence_control_durable_step_outcomes_insert BEFORE INSERT ON control_durable_step_outcomes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_step_outcomes_update BEFORE UPDATE ON control_durable_step_outcomes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_step_outcomes_delete BEFORE DELETE ON control_durable_step_outcomes
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER immutable_durable_execution BEFORE UPDATE ON control_durable_executions
WHEN NEW.run_id != OLD.run_id OR NEW.user_id != OLD.user_id OR NEW.workspace_id != OLD.workspace_id
 OR NEW.agent_id != OLD.agent_id OR NEW.workflow_intent_id != OLD.workflow_intent_id OR NEW.instance_id != OLD.instance_id
 OR NEW.submission_key != OLD.submission_key OR NEW.request_hash != OLD.request_hash OR NEW.pack_id != OLD.pack_id
 OR NEW.pack_version != OLD.pack_version OR NEW.runtime_version != OLD.runtime_version OR NEW.workflow_type != OLD.workflow_type
 OR NEW.workflow_version != OLD.workflow_version OR NEW.definition_hash != OLD.definition_hash
 OR NEW.agent_revision != OLD.agent_revision OR NEW.agent_data_json != OLD.agent_data_json
 OR NEW.configuration_hash != OLD.configuration_hash OR NEW.input_json != OLD.input_json
 OR NEW.max_steps != OLD.max_steps OR NEW.deadline != OLD.deadline OR NEW.created_at != OLD.created_at
 OR OLD.status = 'closed' OR (OLD.status = 'started' AND NEW.status = 'pending')
BEGIN SELECT RAISE(ABORT,'durable_execution_immutable'); END;
CREATE TRIGGER immutable_durable_step BEFORE UPDATE ON control_durable_steps
WHEN NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.workspace_id != OLD.workspace_id OR NEW.agent_id != OLD.agent_id
 OR NEW.run_id != OLD.run_id OR NEW.step_key != OLD.step_key OR NEW.step_version != OLD.step_version
 OR NEW.request_hash != OLD.request_hash OR NEW.output_schema_json != OLD.output_schema_json OR NEW.replay_safe != OLD.replay_safe
 OR NEW.max_attempts != OLD.max_attempts OR NEW.timeout_ms != OLD.timeout_ms OR NEW.created_at != OLD.created_at
 OR OLD.status = 'completed' OR NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1
BEGIN SELECT RAISE(ABORT,'durable_step_immutable'); END;
CREATE TRIGGER immutable_durable_attempt BEFORE UPDATE ON control_durable_step_attempts
WHEN OLD.status != 'running' OR NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.workspace_id != OLD.workspace_id
 OR NEW.agent_id != OLD.agent_id OR NEW.run_id != OLD.run_id OR NEW.step_id != OLD.step_id
 OR NEW.attempt_index != OLD.attempt_index OR NEW.started_at != OLD.started_at OR NEW.status = 'running'
BEGIN SELECT RAISE(ABORT,'durable_attempt_immutable'); END;

CREATE TRIGGER export_fence_control_durable_executions_insert BEFORE INSERT ON control_durable_executions
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_executions_update BEFORE UPDATE ON control_durable_executions
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_executions_delete BEFORE DELETE ON control_durable_executions
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_steps_insert BEFORE INSERT ON control_durable_steps
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_steps_update BEFORE UPDATE ON control_durable_steps
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_steps_delete BEFORE DELETE ON control_durable_steps
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_step_attempts_insert BEFORE INSERT ON control_durable_step_attempts
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_step_attempts_update BEFORE UPDATE ON control_durable_step_attempts
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_durable_step_attempts_delete BEFORE DELETE ON control_durable_step_attempts
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

-- Canonical terminal status also retires the startup intent, including cancellation.
CREATE TRIGGER close_durable_execution_after_run_terminal AFTER UPDATE OF status ON control_runs
WHEN NEW.status IN ('completed','failed','cancelled','blocked')
BEGIN
  UPDATE control_durable_executions SET status='closed',updated_at=NEW.updated_at
  WHERE run_id=NEW.id AND user_id=NEW.user_id AND workspace_id=NEW.workspace_id
    AND agent_id=NEW.agent_id AND status!='closed';
END;

ALTER TABLE control_durable_executions ADD COLUMN recovery_next_at TEXT DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE control_durable_executions ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(recovery_attempts >= 0);
ALTER TABLE control_durable_executions ADD COLUMN recovery_lease_id TEXT;
ALTER TABLE control_durable_executions ADD COLUMN recovery_lease_expires_at TEXT;
ALTER TABLE control_durable_executions ADD COLUMN recovery_engine_status TEXT;
ALTER TABLE control_durable_executions ADD COLUMN recovery_error_code TEXT;
CREATE INDEX idx_durable_recovery_due ON control_durable_executions(recovery_next_at,run_id) WHERE recovery_next_at IS NOT NULL;

DROP TRIGGER immutable_durable_execution;
CREATE TRIGGER immutable_durable_execution BEFORE UPDATE ON control_durable_executions
WHEN NEW.run_id != OLD.run_id OR NEW.user_id != OLD.user_id OR NEW.workspace_id != OLD.workspace_id
 OR NEW.agent_id != OLD.agent_id OR NEW.workflow_intent_id != OLD.workflow_intent_id OR NEW.instance_id != OLD.instance_id
 OR NEW.submission_key != OLD.submission_key OR NEW.request_hash != OLD.request_hash OR NEW.pack_id != OLD.pack_id
 OR NEW.pack_version != OLD.pack_version OR NEW.runtime_version != OLD.runtime_version OR NEW.workflow_type != OLD.workflow_type
 OR NEW.workflow_version != OLD.workflow_version OR NEW.definition_hash != OLD.definition_hash
 OR NEW.agent_revision != OLD.agent_revision OR NEW.agent_data_json != OLD.agent_data_json
 OR NEW.configuration_hash != OLD.configuration_hash OR NEW.input_json != OLD.input_json
 OR NEW.max_steps != OLD.max_steps OR NEW.deadline != OLD.deadline OR NEW.created_at != OLD.created_at
 OR (OLD.status = 'closed' AND (NEW.status != OLD.status OR NEW.updated_at != OLD.updated_at OR NEW.preconditions_met != OLD.preconditions_met)) OR (OLD.status = 'started' AND NEW.status = 'pending')
BEGIN SELECT RAISE(ABORT,'durable_execution_immutable'); END;

DROP TRIGGER close_durable_execution_after_run_terminal;
CREATE TRIGGER close_durable_execution_after_run_terminal AFTER UPDATE OF status ON control_runs
WHEN NEW.status IN ('completed','failed','cancelled','blocked')
BEGIN
  UPDATE control_durable_executions SET status='closed',updated_at=NEW.updated_at,recovery_next_at=NEW.updated_at
  WHERE run_id=NEW.id AND user_id=NEW.user_id AND workspace_id=NEW.workspace_id
    AND agent_id=NEW.agent_id AND status!='closed';
END;

-- Preserve historical snapshot identities while supporting bounded durable-step evidence revisions.
CREATE TABLE control_context_snapshots_v2 (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL, run_kind TEXT NOT NULL CHECK(run_kind IN ('workflow','chat')),
  agent_revision INTEGER NOT NULL, pack_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ready','blocked')), created_at TEXT NOT NULL,
  preconditions_met INTEGER NOT NULL CONSTRAINT context_snapshot_precondition CHECK(preconditions_met = 1),
  capture_key TEXT NOT NULL DEFAULT 'run', step_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 128),
  UNIQUE(user_id,workspace_id,agent_id,run_kind,run_id,capture_key),
  UNIQUE(user_id,workspace_id,agent_id,run_kind,run_id,revision)
);
INSERT INTO control_context_snapshots_v2
  (id,user_id,workspace_id,agent_id,run_id,run_kind,agent_revision,pack_id,request_hash,snapshot_json,status,created_at,preconditions_met)
SELECT id,user_id,workspace_id,agent_id,run_id,run_kind,agent_revision,pack_id,request_hash,snapshot_json,status,created_at,preconditions_met
FROM control_context_snapshots;
DROP TABLE control_context_snapshots;
ALTER TABLE control_context_snapshots_v2 RENAME TO control_context_snapshots;
CREATE INDEX idx_context_snapshot_scope ON control_context_snapshots(user_id,workspace_id,agent_id,id);
CREATE TRIGGER immutable_control_context_snapshots BEFORE UPDATE ON control_context_snapshots
BEGIN SELECT RAISE(ABORT, 'context_snapshot_immutable'); END;

CREATE TRIGGER export_fence_control_context_snapshots_insert BEFORE INSERT ON control_context_snapshots
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_context_snapshots_update BEFORE UPDATE ON control_context_snapshots
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

CREATE TRIGGER export_fence_control_context_snapshots_delete BEFORE DELETE ON control_context_snapshots
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'workspace_export_in_progress'); END;

-- D1 cannot atomically acknowledge native engine calls. Retain dispatch uncertainty
-- and confirmed deletion before allowing canonical identities to be purged.
ALTER TABLE control_durable_executions ADD COLUMN engine_deleted_at TEXT;
ALTER TABLE control_durable_executions ADD COLUMN engine_lifecycle_version INTEGER NOT NULL DEFAULT 0 CHECK(engine_lifecycle_version IN (0,1));
CREATE TABLE control_durable_engine_dispatches (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL, instance_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('dispatching','accepted','outcome_unknown')),
  created_at TEXT NOT NULL, settled_at TEXT,
  preconditions_met INTEGER NOT NULL CONSTRAINT durable_dispatch_precondition CHECK(preconditions_met = 1)
);
CREATE INDEX idx_durable_dispatch_scope ON control_durable_engine_dispatches(workspace_id,run_id);
CREATE UNIQUE INDEX idx_durable_dispatch_active ON control_durable_engine_dispatches(run_id) WHERE status='dispatching';
-- Historical dispatches have no acknowledged-call evidence. Do not infer it from run status.
INSERT INTO control_durable_engine_dispatches
 (id,user_id,workspace_id,agent_id,run_id,instance_id,status,created_at,settled_at,preconditions_met)
SELECT 'legacy:' || run_id,user_id,workspace_id,agent_id,run_id,instance_id,'outcome_unknown',
 created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1 FROM control_durable_executions;

-- Old Workers may still admit executions during a rolling deployment.
CREATE TRIGGER legacy_durable_engine_dispatch AFTER INSERT ON control_durable_executions
WHEN NEW.engine_lifecycle_version=0
BEGIN
 INSERT INTO control_durable_engine_dispatches
  (id,user_id,workspace_id,agent_id,run_id,instance_id,status,created_at,settled_at,preconditions_met)
 VALUES ('legacy:' || NEW.run_id,NEW.user_id,NEW.workspace_id,NEW.agent_id,NEW.run_id,NEW.instance_id,
  'outcome_unknown',NEW.created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1);
END;
CREATE TRIGGER immutable_durable_engine_lifecycle_version BEFORE UPDATE OF engine_lifecycle_version ON control_durable_executions
WHEN NEW.engine_lifecycle_version != OLD.engine_lifecycle_version
BEGIN SELECT RAISE(ABORT,'durable_lifecycle_version_immutable'); END;
CREATE TRIGGER immutable_durable_engine_dispatch BEFORE UPDATE ON control_durable_engine_dispatches
WHEN OLD.status != 'dispatching' OR NEW.status = 'dispatching' OR NEW.id != OLD.id
 OR NEW.user_id != OLD.user_id OR NEW.workspace_id != OLD.workspace_id OR NEW.agent_id != OLD.agent_id
 OR NEW.run_id != OLD.run_id OR NEW.instance_id != OLD.instance_id OR NEW.created_at != OLD.created_at
 OR NEW.preconditions_met != OLD.preconditions_met OR NEW.settled_at IS NULL
BEGIN SELECT RAISE(ABORT,'durable_dispatch_immutable'); END;
CREATE TRIGGER durable_engine_deletion_guard BEFORE UPDATE OF engine_deleted_at ON control_durable_executions
WHEN NEW.engine_deleted_at IS NOT OLD.engine_deleted_at AND (
 OLD.engine_deleted_at IS NOT NULL OR NEW.engine_deleted_at IS NULL
 OR NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=OLD.workspace_id AND w.status='purging')
 OR EXISTS (SELECT 1 FROM control_durable_engine_dispatches d
   WHERE d.workspace_id=OLD.workspace_id AND d.run_id=OLD.run_id AND d.status!='accepted'))
BEGIN SELECT RAISE(ABORT,'durable_engine_deletion_fenced'); END;
CREATE TRIGGER durable_engine_purge_guard BEFORE DELETE ON control_durable_executions
WHEN OLD.engine_deleted_at IS NULL
BEGIN SELECT RAISE(ABORT,'durable_engine_deletion_required'); END;
CREATE TRIGGER durable_dispatch_purge_guard BEFORE DELETE ON control_durable_engine_dispatches
WHEN NOT EXISTS (SELECT 1 FROM control_durable_executions e
 WHERE e.run_id=OLD.run_id AND e.workspace_id=OLD.workspace_id AND e.engine_deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'durable_engine_deletion_required'); END;
CREATE TRIGGER export_fence_control_durable_engine_dispatches_insert BEFORE INSERT ON control_durable_engine_dispatches
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_engine_dispatches_update BEFORE UPDATE ON control_durable_engine_dispatches
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = NEW.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_engine_dispatches_delete BEFORE DELETE ON control_durable_engine_dispatches
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences fence
 WHERE fence.workspace_id = OLD.workspace_id AND fence.status = 'active'
 AND fence.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

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

-- Transfers a leased trigger dispatch into durable execution in the admission batch.
CREATE TABLE control_durable_trigger_links (
 run_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL UNIQUE, trigger_id TEXT NOT NULL,
 user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
 workflow_type TEXT NOT NULL, pack_id TEXT NOT NULL,
 execution_json TEXT NOT NULL, input_json TEXT NOT NULL, config_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 preconditions_met INTEGER NOT NULL CHECK(preconditions_met=1)
);
CREATE INDEX idx_durable_trigger_links_scope ON control_durable_trigger_links(workspace_id,trigger_id);

-- Repeated observations keep one pending dispatch while an earlier run is active.
CREATE TRIGGER durable_trigger_coalesce BEFORE INSERT ON control_trigger_dispatches
WHEN NEW.status='pending' AND NEW.source IN ('schedule','monitor')
 AND EXISTS (SELECT 1 FROM control_triggers WHERE id=NEW.trigger_id AND json_extract(execution_json,'$.runtime')='durable')
 AND EXISTS (SELECT 1 FROM control_trigger_dispatches WHERE trigger_id=NEW.trigger_id AND status='pending' AND source=NEW.source)
BEGIN
 UPDATE control_trigger_dispatches SET scheduled_for=NEW.scheduled_for,updated_at=NEW.updated_at,
   payload_json=json_set(payload_json,'$.coalescedOccurrences',COALESCE(json_extract(payload_json,'$.coalescedOccurrences'),0)+1,
     '$.latestScheduledFor',NEW.scheduled_for)
 WHERE trigger_id=NEW.trigger_id AND status='pending' AND source=NEW.source
   AND scheduled_for < NEW.scheduled_for;
 SELECT RAISE(IGNORE);
END;
CREATE TRIGGER durable_trigger_link_immutable BEFORE UPDATE ON control_durable_trigger_links
BEGIN SELECT RAISE(ABORT,'durable_trigger_link_immutable'); END;

CREATE TRIGGER durable_trigger_link_admitted AFTER INSERT ON control_durable_trigger_links
BEGIN
 UPDATE control_trigger_dispatches SET status='running',run_id=NEW.run_id,
   lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NEW.created_at,updated_at=NEW.created_at
 WHERE id=NEW.dispatch_id AND user_id=NEW.user_id AND workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
 INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
 VALUES (NEW.dispatch_id||':durable-started',NEW.user_id,NEW.workspace_id,NEW.agent_id,
   'trigger.dispatch.started','Trigger dispatch accepted by the durable runtime.','triggerDispatch',NEW.dispatch_id,
   json_object('runId',NEW.run_id,'triggerId',NEW.trigger_id,'logicalEventId',NEW.dispatch_id),NEW.created_at);
END;

CREATE TRIGGER durable_trigger_run_terminal AFTER UPDATE OF status ON control_runs
WHEN NEW.status IN ('completed','failed','blocked','cancelled') AND OLD.status!=NEW.status
BEGIN
 UPDATE control_trigger_dispatches SET status = CASE NEW.status WHEN 'blocked' THEN 'failed' ELSE NEW.status END,
   lease_owner=NULL,lease_expires_at=NULL,updated_at=NEW.updated_at,
   error_json = CASE WHEN NEW.status IN ('failed','blocked') THEN json_object('code','durable_run_stopped') ELSE '{}' END
 WHERE id IN (SELECT dispatch_id FROM control_durable_trigger_links WHERE run_id=NEW.id)
   AND run_id=NEW.id AND user_id=NEW.user_id AND workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
END;

-- Pause and material configuration changes revoke current runs, including approval waits.
CREATE TRIGGER durable_trigger_authority_changed AFTER UPDATE ON control_triggers
WHEN NEW.status!='enabled' OR NEW.workflow_type!=OLD.workflow_type OR NEW.pack_id!=OLD.pack_id
 OR NEW.execution_json!=OLD.execution_json OR NEW.input_json!=OLD.input_json OR NEW.config_json!=OLD.config_json
BEGIN
 UPDATE control_runs SET status='cancelled',cancelled_at=NEW.updated_at,last_event_at=NEW.updated_at,
   updated_at=NEW.updated_at,data_json=json_set(data_json,'$.triggerOutcome','authority_changed')
 WHERE id IN (SELECT run_id FROM control_durable_trigger_links WHERE trigger_id=NEW.id)
   AND status IN ('queued','running','waiting','interrupted');
 UPDATE control_workflow_intents SET status='cancelled',updated_at=NEW.updated_at
 WHERE id IN (SELECT workflow_intent_id FROM control_runs WHERE id IN (
   SELECT run_id FROM control_durable_trigger_links WHERE trigger_id=NEW.id) AND status='cancelled')
   AND status IN ('queued','running','waiting','interrupted');
END;

CREATE TRIGGER export_fence_control_durable_trigger_links_insert BEFORE INSERT ON control_durable_trigger_links
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences WHERE workspace_id=NEW.workspace_id
 AND status='active' AND lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_trigger_links_update BEFORE UPDATE ON control_durable_trigger_links
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences WHERE workspace_id=NEW.workspace_id
 AND status='active' AND lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;
CREATE TRIGGER export_fence_control_durable_trigger_links_delete BEFORE DELETE ON control_durable_trigger_links
WHEN EXISTS (SELECT 1 FROM control_workspace_write_fences WHERE workspace_id=OLD.workspace_id
 AND status='active' AND lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'workspace_export_in_progress'); END;

-- Platform deployment metadata, containing no tenant payloads. A non-expiring
-- admission fence closes the scan/deploy race, including old Worker admissions.
-- Existing executions and exact submission replays remain usable while fenced.
CREATE TABLE control_durable_deployment_fence (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 deployment_id TEXT NOT NULL,
 artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64),
 acquired_at TEXT NOT NULL,
 activate_on_release INTEGER NOT NULL DEFAULT 0 CHECK(activate_on_release IN (0,1))
);
ALTER TABLE control_durable_executions ADD COLUMN deployment_id TEXT NOT NULL DEFAULT '';
CREATE TABLE control_durable_deployment_generation (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 deployment_id TEXT NOT NULL,
 artifact_sha256 TEXT NOT NULL
);
-- Activation and releasing admissions are one atomic database statement.
CREATE TRIGGER durable_deployment_activate AFTER UPDATE OF activate_on_release ON control_durable_deployment_fence
WHEN NEW.activate_on_release=1
BEGIN
 INSERT OR REPLACE INTO control_durable_deployment_generation (singleton,deployment_id,artifact_sha256)
 VALUES (1,NEW.deployment_id,NEW.artifact_sha256);
 DELETE FROM control_durable_deployment_fence WHERE singleton=1 AND deployment_id=NEW.deployment_id;
END;
CREATE TRIGGER durable_deployment_admission_fence BEFORE INSERT ON control_durable_executions
WHEN EXISTS (SELECT 1 FROM control_durable_deployment_fence WHERE singleton=1)
BEGIN SELECT RAISE(ABORT,'durable_deployment_in_progress'); END;
CREATE TRIGGER durable_deployment_stale_worker BEFORE INSERT ON control_durable_executions
WHEN EXISTS (SELECT 1 FROM control_durable_deployment_generation WHERE singleton=1 AND deployment_id!=NEW.deployment_id)
BEGIN SELECT RAISE(ABORT,'durable_deployment_changed'); END;
CREATE TRIGGER durable_deployment_pin_immutable BEFORE UPDATE OF deployment_id ON control_durable_executions
WHEN NEW.deployment_id!=OLD.deployment_id
BEGIN SELECT RAISE(ABORT,'durable_deployment_pin_immutable'); END;

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
 OR NEW.effect_target IS NOT OLD.effect_target
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

-- Provider outcomes must survive a failed application projection without redispatch.
CREATE TABLE control_provider_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE, review_id TEXT NOT NULL,
  operation_id TEXT NOT NULL, operation_version TEXT NOT NULL,
  descriptor_json TEXT NOT NULL, request_hash TEXT NOT NULL,
  connection_record_id TEXT NOT NULL, vault_version TEXT NOT NULL,
  effect_target TEXT NOT NULL DEFAULT 'external' CHECK(effect_target IN ('simulation','external')),
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
 OR NEW.effect_target IS NOT OLD.effect_target
 OR NEW.created_at IS NOT OLD.created_at OR NEW.status='dispatching'
 OR (OLD.status IN ('succeeded','failed') AND NOT (
   NEW.status IS OLD.status AND NEW.updated_at IS OLD.updated_at
   AND COALESCE(json_type(NEW.result_json,'$.payloadPrunedAt')='text',0) AND (SELECT COUNT(*) FROM json_each(NEW.result_json))=1
   AND EXISTS (SELECT 1 FROM control_action_proposals p LEFT JOIN control_retention_policies policy ON policy.workspace_id=p.workspace_id
     WHERE p.id=OLD.proposal_id AND p.status IN ('executed','failed','reconciled','cancelled','expired')
     AND p.updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || COALESCE(policy.run_payload_retention_days,90) || ' days'))
 ))
BEGIN SELECT RAISE(ABORT,'provider_operation_immutable'); END;
CREATE TRIGGER provider_operation_effect_target BEFORE INSERT ON control_provider_operations
WHEN NOT EXISTS (SELECT 1 FROM control_action_proposals p WHERE p.id=NEW.proposal_id AND p.effect_target=NEW.effect_target)
BEGIN SELECT RAISE(ABORT,'provider_operation_effect_target_mismatch'); END;
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
