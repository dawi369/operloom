/** Shared serializable workbench domain and core-tool contracts. */

export type Id = string;

export type TenantScope = {
  userId: Id;
  workspaceId: Id;
};

export type WorkflowStage = "observe" | "analyze" | "propose" | "execute" | "review";

export type ExecutionMode = "ask" | "dry_run" | "execute";

export type ExecutionPolicy = {
  mode: ExecutionMode;
  policy?: string;
};

export type PolicyDecision = {
  allowed: boolean;
  execution: ExecutionPolicy;
  reason?: string;
  approvalRequired?: boolean;
  auditSummary?: string;
  data?: Record<string, unknown>;
};

export type ArtifactRef = {
  id: Id;
  kind: "file" | "log" | "report" | "screenshot" | "trace" | "other";
  uri: string;
  title?: string;
  mimeType?: string;
};

export type ProvenanceRef = {
  id: Id;
  kind:
    | "user_note"
    | "tool_result"
    | "workflow_output"
    | "external_trigger"
    | "manual_override"
    | "artifact"
    | "run"
    | "other";
  title?: string;
  uri?: string;
  capturedAt?: string;
};

export type DecisionRecord = {
  id: Id;
  scope: TenantScope;
  title: string;
  summary: string;
  thesis: string;
  provenance?: ProvenanceRef[];
  artifacts?: ArtifactRef[];
  createdAt: string;
  updatedAt: string;
  data?: Record<string, unknown>;
};

export type WorkflowIntent<Payload = unknown> = {
  id: Id;
  scope: TenantScope;
  stage: WorkflowStage;
  type: string;
  execution: ExecutionPolicy;
  payload: Payload;
  relatedDecisionIds?: Id[];
  createdAt: string;
};

export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "interrupted"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type RunRelation = {
  parentRunId?: Id;
  rootRunId?: Id;
  depth?: number;
  durableChild?: boolean;
};

export type LifecycleEventName =
  | "intent.created"
  | "run.queued"
  | "run.started"
  | "run.interrupted"
  | "run.child.blocked"
  | "approval.requested"
  | "tool.requested"
  | "tool.started"
  | "tool.finished"
  | "artifact.created"
  | "decision.created"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export type LifecycleEvent = {
  name: LifecycleEventName;
  scope: TenantScope;
  runId?: Id;
  workflowIntentId?: Id;
  toolName?: string;
  summary?: string;
  occurredAt: string;
  data?: Record<string, unknown>;
};

export type ContextTier = "stable" | "scoped" | "retrieved" | "volatile";

export type ContextBlock = {
  tier: ContextTier;
  title: string;
  content: string;
  provenance?: ProvenanceRef[];
  tokenEstimate?: number;
  data?: Record<string, unknown>;
};

export type ContextPack = {
  scope: TenantScope;
  agentId: Id;
  threadId?: Id;
  runId?: Id;
  builtAt: string;
  blocks: ContextBlock[];
  data?: Record<string, unknown>;
};

/**
 * Runtime-only tool definition.
 *
 * This is the in-process shape a tool runner can execute. It is not the
 * durable tool registry shape because it contains functions.
 */
export type ToolDefinition<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  kind?: string;
  timeoutMs?: number;
  isAvailable?: (scope: TenantScope) => boolean | Promise<boolean>;
  execute: (input: Input, context: ToolExecutionContext) => Promise<ToolResult<Output>>;
};

export type ToolExecutionContext = {
  scope: TenantScope;
  execution: ExecutionPolicy;
  workflowIntentId?: Id;
  signal?: AbortSignal;
};

export type ToolResult<Output = unknown> =
  | {
      ok: true;
      output: Output;
      artifacts?: ArtifactRef[];
      auditSummary?: string;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryable?: boolean;
      };
      artifacts?: ArtifactRef[];
      auditSummary?: string;
    };

export type ToolExposureContext<Payload = unknown> = {
  scope: TenantScope;
  agentId: Id;
  threadId?: Id;
  runId?: Id;
  workflowIntent?: WorkflowIntent<Payload>;
  execution: ExecutionPolicy;
  stage?: WorkflowStage;
  relation?: RunRelation;
  platform?: string;
};

export type ToolExposureDecision<Input = unknown, Output = unknown> = {
  tool: ToolDefinition<Input, Output>;
  visible: boolean;
  reason?: string;
  data?: Record<string, unknown>;
};

export type ToolExposureResolver = (
  tools: ToolDefinition[],
  context: ToolExposureContext,
) => Promise<ToolExposureDecision[]> | ToolExposureDecision[];
