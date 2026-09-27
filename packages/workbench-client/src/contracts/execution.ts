import type {
  ExecutionPolicy,
  Id,
  RunStatus,
  TenantScope,
  WorkflowStage,
} from "../core-contracts.js";

export type RunRelationSummary = {
  kind?: "root" | "child" | string;
  parentRunId?: Id;
  rootRunId?: Id;
  depth?: number;
  durableChild?: boolean;
};

/** Immutable human-review content; approval does not grant tool execution authority. */
export type WorkflowReviewDescriptor = {
  payload: Record<string, unknown>;
  requestHash: string;
  expiresAt: string;
};

export type ExecutionRunSnapshot = {
  scope: TenantScope;
  intent: {
    id?: Id;
    type?: string;
    stage?: WorkflowStage | string;
    execution?: Partial<ExecutionPolicy>;
    payload?: unknown;
  } | null;
  run: {
    id?: Id;
    agentId?: Id;
    status?: RunStatus | string;
    workflowIntentId?: Id;
    execution?: Partial<ExecutionPolicy>;
    stage?: WorkflowStage | string;
    relation?: RunRelationSummary;
    updatedAt?: string;
    data?: Record<string, unknown>;
  } | null;
  toolCalls: Array<{
    id: Id;
    toolId?: string;
    status?: string;
    inputSummary?: string;
    outputSummary?: string;
    relation?: RunRelationSummary;
  }>;
  childRuns?: Array<{
    id?: Id;
    workflowIntentId?: Id;
    agentId?: Id;
    status?: RunStatus | string;
    stage?: WorkflowStage | string;
    engine?: string;
    relation?: RunRelationSummary;
    updatedAt?: string;
    createdAt?: string;
  }>;
  artifacts: ArtifactSummary[];
  decisions: Array<{
    id: Id;
    title?: string;
    summary?: string;
    thesis?: string;
  }>;
  auditEvents: Array<{
    id: Id;
    action?: string;
    summary?: string;
    createdAt?: string;
  }>;
  interventions?: Array<{
    id: Id;
    kind: "approval" | string;
    status: string;
    state: "parked" | "resumable" | "decided" | string;
    requiredAction: "approve_or_deny" | "none" | string;
    runId: Id;
    workflowIntentId: Id;
    toolId: string;
    reason: string;
    title: string;
    review?: WorkflowReviewDescriptor;
    approvePath?: string;
    denyPath?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
};

export type ExecutionRunResponse = {
  ok?: boolean;
  snapshot?: ExecutionRunSnapshot | null;
  error?: string;
};

export type ControlPlaneEvent = {
  id: Id;
  type?: string;
  summary?: string;
  targetType?: string;
  targetId?: string;
  data?: Record<string, unknown>;
  createdAt?: string;
};

export type ControlPlaneEventsResponse = {
  ok?: boolean;
  events?: ControlPlaneEvent[];
  error?: string;
};

export type DynamicCapabilityContext = {
  stage: "observe" | "analyze" | "propose" | "execute" | "review";
  executionMode: "ask" | "dry_run" | "execute";
  surface: "admin_list" | "admin_run" | "admin_resume" | "model_exposure" | "model_tool_call";
  platform: "cloudflare-control-plane";
  featureFlags: string[];
};

export type DynamicCapabilityDecision = {
  capabilityId: string;
  kind: "tool";
  visible: boolean;
  decision: "allow" | "block";
  code?: string;
  reason?: string;
  policyReference?: string;
  permissionStatus?: "enabled" | "disabled" | "pending_review" | string;
  allowedExecutionModes?: Array<"ask" | "dry_run" | "execute">;
  approvalRequired?: boolean;
  adminVisible?: boolean;
  modelVisible?: boolean;
  policyEditable?: boolean;
  constraints?: ToolSummary["policyConstraints"];
  connectionAuth?: ConnectionAuthBrokerage;
};

export type ToolSummary = {
  name: string;
  description: string;
  kind: string;
  family: string;
  status: string;
  supportedExecutionModes: string[];
  adminVisible: boolean;
  modelVisible: boolean;
  reason: string;
  requiresSecrets: boolean;
  mutationRisk: "read_only" | "mutation_capable";
  mutationEnabled?: boolean;
  runner?: {
    transport?: "cloudflare_inline" | "fly";
    adapterVersion?: string;
    source?: "admin" | "approval" | "model" | "demo-compat" | "agent-pack";
    sandbox?: {
      lifecycle?: {
        template?: string;
        setup?: "per_invocation" | string;
        workspaceState?: "none" | "persistent" | string;
        filesystem?: "ephemeral" | "workspace_persistent" | string;
        artifactPromotion?: "metadata_only" | "explicit" | string;
      };
      network?: {
        egress?: "public_web" | string;
        allowedSchemes?: string[];
        allowedHosts?: string[];
        deniedHosts?: string[];
        privateNetwork?: "deny" | string;
        enforcement?: "control_plane_and_runner" | string;
      };
      limits?: {
        maxRuntimeMs?: number;
      };
    };
  };
  permissionStatus?: "enabled" | "disabled" | "pending_review";
  policyReference?: string;
  allowedExecutionModes?: string[];
  approvalRequired?: boolean;
  killSwitchReason?: string;
  policyEditable?: boolean;
  connectionAuth?: ConnectionAuthBrokerage;
  policyConstraints?: {
    limits?: {
      perUserPerHour?: number;
      perWorkspacePerHour?: number;
    };
    cooldownSeconds?: number;
    allowlist?: string[];
    denylist?: string[];
    maxRuntimeMs?: number;
    maxArtifactBytes?: number;
  };
  adminPolicy?: {
    decision?: "allow" | "block";
    code?: string;
    reason?: string;
    executionMode?: string;
    policyReference?: string;
    constraints?: ToolSummary["policyConstraints"];
  };
  modelExposurePolicy?: {
    decision?: "allow" | "block";
    code?: string;
    reason?: string;
    executionMode?: string;
    policyReference?: string;
    constraints?: ToolSummary["policyConstraints"];
  };
  capability?: DynamicCapabilityDecision;
  packScope?: {
    activePackId?: string;
    declared: boolean;
    invocation?: "user" | "agent" | "workflow" | string;
    required?: boolean;
    modelVisibleDefault?: boolean;
    executionModes?: string[];
    purpose?: string;
  };
  latestApprovalRequest?: {
    id?: Id;
    status?: string;
    reason?: string;
    createdAt?: string;
    updatedAt?: string;
    data?: Record<string, unknown>;
  };
};

export type ConnectionAuthBrokerage = {
  required?: boolean;
  status?: "not_required" | "authorization_required" | "authorized" | "refresh_required" | string;
  principal?: "none" | "app" | "user" | string;
  connectionName?: string;
  authorizationEventType?: "connection.authorization_required" | string;
  tokenRefresh?: "not_applicable" | "brokered" | string;
  toolFilter?: "not_required" | "connection_scoped" | string;
  approvalOrder?: "policy_before_connection" | "connection_before_policy" | string;
  reason?: string;
};

export type ToolCallSummary = {
  id: Id;
  scope?: TenantScope;
  agentId?: Id;
  workflowIntentId?: Id;
  runId?: Id;
  toolId?: string;
  status?: string;
  inputSummary?: string;
  outputSummary?: string;
  artifactRefs?: unknown[];
  relation?: RunRelationSummary;
  data?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
};

export type ArtifactSummary = {
  id: Id;
  scope?: TenantScope;
  kind?: string;
  uri?: string;
  title?: string;
  mimeType?: string;
  sizeBytes?: number;
  data?: Record<string, unknown>;
  createdAt?: string;
};

export type ExecutionHistoryRunSummary = {
  id: Id;
  scope?: TenantScope;
  agentId?: Id;
  workflowIntentId?: Id;
  status?: RunStatus | string;
  stage?: WorkflowStage | string;
  engine?: string;
  summary?: string;
  displayName?: string;
  workflowType?: string;
  artifactIds?: Id[];
  decisionIds?: Id[];
  toolCallCount?: number;
  heartbeatAt?: string;
  lastEventAt?: string;
  completedAt?: string;
  failedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  controls?: {
    canCancel: boolean;
    canRetry: boolean;
    canResume: boolean;
    resumeKind?: "approval";
  };
};

export type CloudflareExecutionHistoryResponse = {
  ok?: boolean;
  runs?: ExecutionHistoryRunSummary[];
  limit?: number;
  error?: string;
};

export type CloudflareExecutionHistoryRunResponse = {
  ok?: boolean;
  snapshot?: ExecutionRunSnapshot | null;
  error?: string;
};

export type CloudflareArtifactHistoryResponse = {
  ok?: boolean;
  artifacts?: ArtifactSummary[];
  limit?: number;
  error?: string;
};

export type ToolApprovalRequestSummary = {
  id?: Id;
  scope?: TenantScope;
  agentId?: Id;
  workflowIntentId?: Id;
  runId?: Id;
  toolId?: string;
  status?: string;
  reason?: string;
  review?: WorkflowReviewDescriptor;
  input?: {
    url?: string;
  };
  source?: string;
  executionMode?: string;
  policyDecisionId?: Id;
  decision?: {
    decidedAt?: string;
    decidedByUserId?: Id;
    denyReason?: string;
    policyDecisionId?: Id;
    error?: {
      code?: string;
      message?: string;
    };
  };
  currentPolicy?: {
    decision?: "allow" | "block";
    code?: string;
    reason?: string;
    executionMode?: string;
    policyReference?: string;
  };
  humanIntervention?: {
    id?: Id;
    kind?: "approval" | string;
    status?: string;
    state?: "parked" | "resumable" | "decided" | string;
    requiredAction?: "approve_or_deny" | "none" | string;
    resumeSurface?: "admin_resume" | string;
    runId?: Id;
    workflowIntentId?: Id;
    toolId?: string;
    reason?: string;
    title?: string;
    review?: WorkflowReviewDescriptor;
    approvePath?: string;
    denyPath?: string;
    currentPolicy?: {
      decision?: "allow" | "block";
      code?: string;
      reason?: string;
    };
    createdAt?: string;
    updatedAt?: string;
  };
  createdAt?: string;
  updatedAt?: string;
};

export type CloudflareToolsResponse = {
  ok?: boolean;
  capabilityContext?: DynamicCapabilityContext;
  capabilityDecisions?: DynamicCapabilityDecision[];
  tools?: ToolSummary[];
  latestToolCalls?: ToolCallSummary[];
  latestArtifacts?: ArtifactSummary[];
  error?: string;
};

export type CloudflareToolApprovalsResponse = {
  ok?: boolean;
  status?: "requested" | "decided" | "all" | string;
  approvals?: ToolApprovalRequestSummary[];
  error?: string;
  details?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    redacted?: boolean;
  };
};

export type CloudflareToolRunResponse = {
  ok?: boolean;
  run?: {
    id?: Id;
    workflowIntentId?: Id;
    status?: string;
    execution?: Partial<ExecutionPolicy>;
    policyDecisionId?: Id;
    relation?: RunRelationSummary;
  };
  approvalRequest?: ToolApprovalRequestSummary;
  toolCall?: ToolCallSummary | null;
  artifact?: ArtifactSummary | null;
  error?:
    | string
    | {
        code?: string;
        message?: string;
        retryable?: boolean;
        redacted?: boolean;
      };
  details?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    redacted?: boolean;
  };
  policyDecisionId?: Id;
};

export type CloudflareToolPolicyUpdateResponse = {
  ok?: boolean;
  toolName?: string;
  status?: "enabled" | "disabled";
  requiresApproval?: boolean;
  mutationEnabled?: boolean;
  modelVisible?: boolean;
  policyConstraints?: ToolSummary["policyConstraints"];
  permissionId?: Id;
  policyDecisionId?: Id;
  tool?: ToolSummary;
  error?: string;
  details?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    redacted?: boolean;
  };
};

export type CloudflareToolApprovalActionResponse = CloudflareToolRunResponse;

export type RuntimeTraceStatus = "running" | "completed" | "failed" | "blocked";

export type RuntimeTraceLayer =
  | "browser"
  | "vercel"
  | "cloudflare"
  | "durable_object"
  | "d1"
  | "provider"
  | "executor"
  | "tool";

export type RuntimeTrace = {
  traceId: Id;
  scope?: TenantScope;
  agentId?: Id;
  kind:
    | "chat.thread.create"
    | "chat.run.stream"
    | "chat.agent.stream"
    | "tool.url.inspect"
    | "tool.repo.snapshot"
    | "tool.diagnostic.ping"
    | "tool.runner.echo"
    | "tool.artifact.metadata.test"
    | "diagnostic.execution";
  status: RuntimeTraceStatus;
  rootName: string;
  summary?: string;
  bottleneckSpanId?: Id;
  bottleneckConfidence?: "exact" | "fallback";
  bottleneckReason?: string;
  data?: Record<string, unknown>;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type RuntimeSpan = {
  spanId: Id;
  traceId: Id;
  parentSpanId?: Id;
  scope?: TenantScope;
  agentId?: Id;
  name: string;
  layer: RuntimeTraceLayer;
  status: RuntimeTraceStatus;
  spanType?: "operation" | "phase" | "event";
  isAggregate?: boolean;
  bottleneckCandidate?: boolean;
  offsetMs?: number;
  data?: Record<string, unknown>;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type CloudflareRuntimeTracesResponse = {
  ok?: boolean;
  latestTrace?: RuntimeTrace | null;
  recentTraces?: RuntimeTrace[];
  traceWaterfall?: RuntimeSpan[];
  error?: string;
};

export type CloudflareRuntimeTraceResponse = {
  ok?: boolean;
  trace?: RuntimeTrace | null;
  spans?: RuntimeSpan[];
  error?: string;
};
