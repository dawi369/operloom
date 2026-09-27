export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "interrupted"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type ExecutionMode = "ask" | "dry_run" | "execute";

export type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};

export type D1Result = {
  success?: boolean;
  meta?: {
    duration?: number;
    changes?: number;
    rows_read?: number;
    rows_written?: number;
  };
  results?: unknown[];
};

export type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
};

export type DurableObjectId = unknown;

export type DurableObjectStub = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
};

export type DurableObjectStorage = {
  setAlarm?(scheduledTime: number): Promise<void>;
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

export type DurableObjectState = {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
};

export type R2ObjectBody = {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

export type R2Bucket = {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
};

export type QueueMessage<T> = {
  body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

export type MessageBatch<T> = {
  messages: QueueMessage<T>[];
};

export type Queue<T> = {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
};

export type Env = {
  DURABLE_WORKFLOWS?: {
    create(options: { id: string; params: { runId: string } }): Promise<{ id: string }>;
    get(id: string): Promise<{
      status(): Promise<{ status: string }>;
      terminate(): Promise<void>;
      sendEvent?(event: { type: string; payload: { approvalId: string } }): Promise<void>;
    }>;
    deleteBatch?(ids: string[]): Promise<{
      deleted: { id: string }[];
      errors: { id: string; code: number; message: string }[];
    }>;
  };
  OPERLOOM_WORKOS_ISSUER?: string;
  OPERLOOM_WORKOS_JWKS_URL?: string;
  OPERLOOM_WORKOS_ALLOWED_CLIENT_IDS?: string;
  OPERLOOM_LOCAL_API_ENABLED?: string;
  OPERLOOM_LOCAL_API_USER_ID?: string;
  OPERLOOM_ENVIRONMENT?: string;
  DB: D1Database;
  ARTIFACTS?: R2Bucket;
  NOTIFICATIONS?: Queue<NotificationQueueMessage>;
  ThreadChatAgent?: DurableObjectNamespace;
  SessionAgent?: DurableObjectNamespace;
  OPERLOOM_LOCAL_API_TOKEN?: string;
  OPERLOOM_AGENT_CONNECTION_SECRET?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_NAME?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
  OPERLOOM_CALLBACK_SIGNING_SECRET?: string;
  OPERLOOM_CALLBACK_URL?: string;
  OPERLOOM_RUNNER_TRANSPORT?: "inline" | "fly";
  OPERLOOM_RUNNER_URL?: string;
  OPERLOOM_RUNNER_SIGNING_SECRET?: string;
  OPERLOOM_OPERATOR_ALERT_WEBHOOK_URL?: string;
  OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET?: string;
  OPERLOOM_E2E_MODE?: string;
  OPERLOOM_E2E_EXPORT_PAUSE_MS?: string;
  OPERLOOM_RELEASE_SHA?: string;
  OPERLOOM_DEPLOYMENT_ID?: string;
  OPERLOOM_CONFORMANCE_MODE?: string;
  OPERLOOM_RETAINED_DATA_ENABLED?: string;
  OPERLOOM_CONNECTIONS_ENABLED?: string;
  OPERLOOM_MUTATIONS_ENABLED?: string;
  OPERLOOM_PUSH_ENABLED?: string;
  OPERLOOM_DEMO_MODE?: string;
  OPERLOOM_DEMO_PACK_ALLOWLIST?: string;
  OPERLOOM_DEMO_CHAT_DAILY_LIMIT?: string;
  OPERLOOM_DEMO_WORKFLOW_DAILY_LIMIT?: string;
  OPERLOOM_DEMO_MODEL_BUDGET_USD?: string;
  OPERLOOM_DEMO_ARTIFACT_WORKSPACE_BYTES?: string;
  OPERLOOM_DEMO_RETENTION_DAYS?: string;
  OPERLOOM_VAULT_BACKEND?: "workos" | "memory";
  WORKOS_API_KEY?: string;
  WORKOS_VAULT_API_URL?: string;
  OPERLOOM_OAUTH_PROVIDERS_JSON?: string;
  ALLOWED_ORIGINS?: string;
};

export type NotificationQueueMessage = {
  deliveryId: string;
  phase: "send" | "receipt";
};

export type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export type WorkerScheduledController = {
  scheduledTime: number;
  cron: string;
};

export type TenantScope = {
  userId: string;
  workspaceId: string;
};

export type EffectTarget = "simulation" | "external";

export type AgentIdentity = {
  scope: TenantScope;
  agentId: string;
  /** Server-resolved execution generation; never accepted from client headers. */
  agentRevision?: number;
  /** Resolved from the same agent row as agentRevision; absent means simulation. */
  effectTarget?: EffectTarget;
  accountId?: string;
  accountSource?: string;
  authMode?: "access_token" | "local_api";
};

export type ControlRequestNonceRow = {
  nonce: string;
  signature_hash: string;
  source: string;
  created_at: string;
  expires_at: string;
};

export type UserRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  status: string;
  data_json: string;
  created_at: string;
  updated_at: string;
};

export type WorkspaceRow = {
  id: string;
  account_id: string;
  account_source: string;
  name: string;
  status: string;
  is_default: number;
  created_by_user_id: string;
  data_json: string;
  deletion_requested_by_user_id?: string | null;
  deletion_requested_at?: string | null;
  purge_after?: string | null;
  purged_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type ActiveWorkspacePreferenceRow = {
  user_id: string;
  account_id: string;
  workspace_id: string;
  data_json: string;
  created_at: string;
  updated_at: string;
};

export type ActiveAgentPreferenceRow = {
  user_id: string;
  workspace_id: string;
  agent_id: string;
  data_json: string;
  created_at: string;
  updated_at: string;
};

export type MembershipRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  role: string;
  status: string;
  roles_json: string;
  permissions_json: string;
  data_json: string;
  created_at: string;
  updated_at: string;
};

export type AgentRow = {
  id: string;
  /** Missing only in legacy fixtures; persisted agents start at revision zero. */
  runtime_revision?: number;
  /** Missing only in legacy fixtures; persisted agents start in simulation. */
  effect_target?: EffectTarget;
  workspace_id: string;
  name: string;
  description: string | null;
  status: string;
  is_default: number;
  created_by_user_id: string;
  data_json: string;
  created_at: string;
  updated_at: string;
};

export type ControlIntentRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  stage: string;
  type: string;
  execution_json: string;
  payload_json: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type ControlRunRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  workflow_intent_id: string;
  status: RunStatus;
  execution_json: string;
  stage: string | null;
  engine: string | null;
  heartbeat_at: string | null;
  last_event_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at?: string | null;
  data_json: string;
  created_at: string;
  updated_at: string;
};

export type ControlToolCallRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  workflow_intent_id: string;
  run_id: string;
  tool_id: string;
  status: string;
  input_summary: string | null;
  output_summary: string | null;
  artifact_refs_json: string;
  data_json: string;
  started_at: string;
  finished_at: string | null;
  created_at: string;
};

export type ToolPermissionStatus = "enabled" | "disabled" | "pending_review";

export type ToolPermissionRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  tool_id: string;
  status: ToolPermissionStatus;
  execution_json: string;
  data_json: string;
  created_at: string;
  updated_at: string;
};

export type ControlPolicyDecisionRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  tool_id: string;
  surface: string;
  decision: string;
  reason: string;
  execution_mode: ExecutionMode;
  policy_reference: string | null;
  data_json: string;
  created_at: string;
};

export type ControlApprovalRequestRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  workflow_intent_id: string;
  run_id: string;
  tool_id: string;
  status: string;
  reason: string;
  data_json: string;
  created_at: string;
  updated_at: string;
};

export type ControlArtifactRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  kind: string;
  uri: string;
  title: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  storage_provider: "external" | "r2";
  storage_key: string | null;
  content_sha256: string | null;
  retention_class: "standard" | "permanent";
  expires_at: string | null;
  deleted_at: string | null;
  data_json: string;
  created_at: string;
};

export type ControlRetentionPolicyRow = {
  user_id: string;
  workspace_id: string;
  artifact_retention_days: number;
  operational_event_retention_days: number;
  runtime_trace_retention_days: number;
  chat_message_retention_days: number;
  run_payload_retention_days: number;
  audit_action_retention_days: number;
  confirmed_at: string | null;
  confirmed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ControlDataJobRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  kind: "export" | "purge";
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "expired";
  cursor_json: string;
  result_json: string;
  error_json: string;
  storage_key: string | null;
  content_sha256: string | null;
  size_bytes: number | null;
  attempt_count: number;
  last_error_code: string | null;
  last_failed_at: string | null;
  manual_retry_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  expires_at: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type ControlConnectionRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  pack_id: string;
  connection_id: string;
  provider_id: string;
  principal: "app" | "user";
  credential_class: "oauth2" | "api_key";
  status: "authorization_required" | "authorized" | "refresh_required" | "unhealthy" | "revoked";
  scopes_json: string;
  vault_object_id: string | null;
  vault_version: string | null;
  token_expires_at: string | null;
  refresh_lease_owner: string | null;
  refresh_lease_expires_at: string | null;
  last_used_at: string | null;
  last_health_at: string | null;
  last_error_code: string | null;
  version: number;
  data_json: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

export type ControlActionProposalStatus =
  | "proposed"
  | "approval_requested"
  | "approved"
  | "executing"
  | "executed"
  | "failed"
  | "outcome_unknown"
  | "reconciled"
  | "cancelled"
  | "expired";

export type ControlActionProposalRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  workflow_intent_id: string;
  run_id: string;
  tool_call_id: string | null;
  pack_id: string;
  pack_version: string;
  runtime_version: string;
  binding_version: number;
  tool_id: string;
  action_type: string;
  connection_record_id: string | null;
  status: ControlActionProposalStatus;
  summary: string;
  idempotency_key: string;
  input_sha256: string;
  proposal_json: string;
  policy_decision_id: string | null;
  approval_request_id: string | null;
  external_reference: string | null;
  result_json: string;
  error_json: string;
  version: number;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
};

export type ControlOperatorAlertRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string | null;
  severity: "warning" | "critical";
  code: string;
  summary: string;
  target_type: string | null;
  target_id: string | null;
  status: "open" | "acknowledged" | "resolved";
  dedup_key: string;
  delivery_status: "pending" | "delivered" | "failed";
  delivery_attempts: number;
  last_delivery_at: string | null;
  data_json: string;
  created_at: string;
  updated_at: string;
};

export type ControlDecisionRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  title: string;
  summary: string;
  thesis: string;
  status: string;
  provenance_refs_json: string;
  artifact_refs_json: string;
  created_at: string;
  updated_at: string;
};

export type ControlManagedStateRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  namespace: string;
  state_type: string;
  state_key: string;
  status: string;
  summary: string | null;
  version: number;
  artifact_refs_json: string;
  data_json: string;
  created_at: string;
  updated_at: string;
};

export type ControlTriggerRow = {
  id: string;
  public_id: string | null;
  secret_hash: string | null;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  pack_id: string;
  pack_trigger_id: string;
  kind: "schedule" | "monitor" | "webhook";
  workflow_type: string;
  status: "enabled" | "paused" | "disabled";
  execution_json: string;
  config_json: string;
  input_json: string;
  max_concurrent_runs: number;
  version: number;
  next_trigger_at: string | null;
  last_triggered_at: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
};

export type ControlTriggerDispatchRow = {
  id: string;
  trigger_id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  idempotency_key: string;
  source: "manual" | "schedule" | "monitor" | "webhook" | "replay";
  status: "pending" | "leased" | "running" | "completed" | "failed" | "cancelled";
  attempt_count: number;
  run_id: string | null;
  previous_run_id: string | null;
  scheduled_for: string | null;
  received_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  payload_json: string;
  error_json: string;
  created_at: string;
  updated_at: string;
};

export type ControlAuditRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  action: string;
  summary: string;
  target_type: string | null;
  target_id: string | null;
  data_json: string;
  created_at: string;
};

export type ControlPlaneEventRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  type: string;
  summary: string;
  target_type: string | null;
  target_id: string | null;
  data_json: string;
  created_at: string;
};

export type RuntimeTraceRow = {
  trace_id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  kind: string;
  status: string;
  root_name: string;
  summary: string | null;
  bottleneck_span_id: string | null;
  data_json: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
};

export type RuntimeSpanRow = {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  name: string;
  layer: string;
  status: string;
  data_json: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
};

export type ChatSessionRow = {
  session_id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  status: string;
  active_thread_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
};

export type ChatThreadRow = {
  thread_id: string;
  session_id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  status: string;
  upstream_json: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
};

export type ChatIntentRow = {
  id: string;
  session_id: string;
  thread_id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  type: string;
  execution_mode: ExecutionMode;
  status: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
};

export type ChatPolicyDecisionRow = {
  id: string;
  intent_id: string;
  thread_id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  decision: string;
  reason: string;
  execution_mode: ExecutionMode;
  limits_json: string;
  created_at: string;
};

export type ChatRunRow = {
  id: string;
  intent_id: string;
  policy_decision_id: string;
  thread_id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  upstream_run_id: string | null;
  status: string;
  metadata_json: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  failed_at: string | null;
  updated_at: string;
};

export const allowedStatuses = new Set<RunStatus>([
  "queued",
  "running",
  "waiting",
  "interrupted",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

export const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export const toJson = (value: unknown) => JSON.stringify(value ?? {});

export const effectTargetOf = (identity: AgentIdentity): EffectTarget =>
  identity.effectTarget ?? "simulation";
