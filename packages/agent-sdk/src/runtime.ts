import type {
  AgentPackConnectionDescriptor,
  AgentPackExecutionMode,
  LocalAgentPackManifest,
} from "./manifest.js";

export type JsonSchema = Readonly<Record<string, unknown>>;
export type RuntimeRecord = Record<string, unknown>;

export type RuntimeError = {
  code: string;
  message: string;
  retryable?: boolean;
  redacted?: boolean;
  data?: RuntimeRecord;
};

export type RuntimeArtifact = {
  kind: string;
  title: string;
  mimeType: string;
  data: RuntimeRecord;
};

export type RuntimeResult<T extends RuntimeRecord = RuntimeRecord> =
  | {
      ok: true;
      output: T;
      summary: string;
      artifacts?: RuntimeArtifact[];
    }
  | {
      ok: false;
      error: RuntimeError;
      summary: string;
      artifacts?: RuntimeArtifact[];
    };

export type RuntimeScope = {
  userId: string;
  workspaceId: string;
  agentId: string;
};

export type ConnectionStatus =
  | "not_required"
  | "authorization_required"
  | "authorized"
  | "refresh_required"
  | "unhealthy";

export type ConnectionCapability = {
  id: string;
  status: ConnectionStatus;
  reason: string;
  request?: (input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
};

export type ConnectionPort = {
  resolve(connectionId: string, toolId: string): Promise<ConnectionCapability>;
};

export type ActionProposal = {
  toolId: string;
  type: string;
  summary: string;
  idempotencyKey: string;
  preview: RuntimeRecord;
  /** Exact external-state versions relevant to the proposed effect; absence is version zero. */
  preconditions?: readonly import("./state.js").RuntimeStateRead[];
  /** Capacity held at provider admission until rejection or an atomic state projection. */
  reservations?: readonly (import("./state.js").RuntimeStateRead & {
    field: string;
    amount: number;
  })[];
  /** Optional earlier deadline. The platform also bounds approval validity. */
  expiresAt?: string;
};

export type ActionExecutionResult = {
  proposalId: string;
  status: "executed" | "failed" | "outcome_unknown" | "reconciled";
  summary: string;
  externalReference?: string;
  output?: RuntimeRecord;
};

/**
 * A bound under which a `policy_controlled` action dispatches without a human.
 * Counts and amounts are measured over the agent's auto-dispatched proposals for
 * the same tool in the period; allowlists read the operator's agent settings.
 */
export type ApprovalLimit =
  | { kind: "count"; per: "hour" | "day"; max: number }
  | { kind: "amount"; field: string; max: number; per?: "hour" | "day" }
  | { kind: "allowlist"; field: string; settingsKey: string };

export type ActionApprovalDecision = "auto" | "review";

export type ActionPort = {
  inspect?(proposalId: string): Promise<{
    proposal: ActionProposal | null;
    provider: {
      status: "dispatching" | "succeeded" | "failed" | "outcome_unknown";
      output: RuntimeRecord;
    } | null;
    projection: { commitId: string; createdAt: string } | null;
  }>;
  /**
   * `status` stays `proposed` while a human review is needed. A
   * `policy_controlled` action inside its limits dispatches before returning and
   * reports the dispatch status with `approval: "auto"`.
   */
  propose(input: ActionProposal): Promise<{
    proposalId: string;
    status: "proposed" | ActionExecutionResult["status"];
    approval?: ActionApprovalDecision;
  }>;
  execute(proposalId: string): Promise<ActionExecutionResult>;
  reconcile?(proposalId: string): Promise<ActionExecutionResult>;
};

export type ManagedStateWrite = {
  namespace: string;
  stateType: string;
  stateKey: string;
  status: string;
  summary?: string;
  data?: RuntimeRecord;
  expectedVersion?: number;
};

export type RuntimeRunTrigger = Readonly<{
  /** Installed trigger identity. */
  id: string;
  /** The trigger id declared by the package. */
  packTriggerId: string;
  /** One dispatch per occurrence; stable across retries of that occurrence. */
  dispatchId: string;
  source: "manual" | "schedule" | "monitor" | "webhook" | "replay";
  scheduledFor: string | null;
  attempt: number;
}>;

export type NotificationChannel = "push" | "email" | "sms";
export type NotificationSeverity = "info" | "action" | "alert";

/**
 * A user-facing event the package wants delivered. The type must be declared in
 * the manifest's `notifications`; the platform records it as a control-plane
 * event and routes it by the user's channel preferences. `info` folds into the
 * next digest, `action` honours quiet hours, `alert` goes out at once.
 */
export type RuntimeNotificationEvent = {
  type: string;
  title: string;
  body: string;
  target: { type: string; id: string };
  severity: NotificationSeverity;
};

export type RuntimeNotificationPort = {
  emit(event: RuntimeNotificationEvent): Promise<{ eventId: string; queued: number }>;
};

/** Present on a run that another agent's run delegated. */
export type RuntimeRunDelegation = Readonly<{
  taskId: string;
  parentRunId: string;
  requesterAgentId: string;
  deadlineAt: string;
  depth: number;
}>;

export type RuntimeDelegationTask = {
  taskId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "expired" | "cancelled";
  targetAgentId: string;
  workflowType: string;
  runId: string | null;
  /** The child workflow's output when `succeeded`. */
  result: RuntimeRecord | null;
  error: { code: string; message: string } | null;
  deadlineAt: string;
};

/**
 * Hands a bounded workflow run to another agent in the workspace. The task is
 * dispatched by the scheduler on a later tick; the requesting run reads the
 * outcome with `result` on a later run of its own. Requires `tasks.delegate`.
 */
export type RuntimeTaskPort = {
  delegate(input: {
    agentId: string;
    workflowType: string;
    input: RuntimeRecord;
    deadlineMs: number;
    idempotencyKey: string;
  }): Promise<{ taskId: string; status: RuntimeDelegationTask["status"]; created: boolean }>;
  result(taskId: string): Promise<RuntimeDelegationTask>;
};

export type RuntimeTriggerPort = {
  /**
   * Installs one of the package's declared schedule or monitor triggers, enabled, for the
   * current agent. An installed trigger is returned unchanged, so an operator's pause or
   * disable stands. Requires owner/admin membership.
   */
  ensure(packTriggerId: string): Promise<{
    id: string;
    status: "enabled" | "paused" | "disabled";
    created: boolean;
  }>;
};

export type AgentExecutionContext = {
  scope: Readonly<RuntimeScope>;
  pack: Readonly<{ id: string; version: string; runtimeVersion: string }>;
  run: Readonly<{
    id: string;
    workflowIntentId: string;
    executionMode: AgentPackExecutionMode;
    source: "user" | "trigger" | "retry";
    /** Present when a schedule, monitor, webhook, manual or replay dispatch admitted the run. */
    trigger?: RuntimeRunTrigger;
    /** Present when another agent's run delegated this one. */
    delegation?: RuntimeRunDelegation;
  }>;
  /** Signed runner restrictions; network tools must enforce these on every hop. */
  networkPolicy?: Readonly<{
    egress: "none" | "public_web" | "broker_only";
    allowedSchemes: readonly string[];
    allowedHosts: readonly string[];
    deniedHosts: readonly string[];
  }>;
  /** Operator settings pinned when the run was admitted. */
  settings: import("./settings.js").RuntimeSettings;
  signal: AbortSignal;
  connections: ConnectionPort;
  actions: ActionPort;
  tools: {
    invoke(toolId: string, input: RuntimeRecord): Promise<RuntimeResult>;
  };
  state?: import("./state.js").RuntimeStatePort;
  context?: import("./context.js").RuntimeContextPort;
  models?: import("./models.js").RuntimeModelPort;
  /** Present when the package requires `search.web`. */
  search?: import("./search.js").RuntimeSearchPort;
  /** Present when the package requires `triggers.ensure`. */
  triggers?: RuntimeTriggerPort;
  /** Present when the package requires `notifications.emit`. */
  notifications?: RuntimeNotificationPort;
  /** Present when the package requires `tasks.delegate`. */
  tasks?: RuntimeTaskPort;
  /** Present only inside the signed runner (`runner.ts` tools). */
  recipes?: import("./recipes.js").RunnerRecipes;
  managedState: {
    upsert(input: ManagedStateWrite): Promise<{ id: string; version: number }>;
  };
  events: {
    append(type: string, summary: string, data?: RuntimeRecord): Promise<void>;
  };
};

export type WorkflowFormField = {
  name: string;
  label: string;
  description: string;
  kind: "text" | "number" | "checkbox" | "select";
  placeholder?: string;
  min?: number;
  max?: number;
  options?: readonly { value: string; label: string }[];
};

export type RuntimeToolBinding = {
  id: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  executionModes: readonly AgentPackExecutionMode[];
  transport: "cloudflare_inline" | "fly";
  adapterVersion: string;
  timeoutMs: number;
  maxArtifactBytes: number;
  sandbox?: RuntimeRecord;
  policy: {
    reference: string;
    adminVisible: boolean;
    modelVisible: boolean;
    requiresApproval: boolean;
    policyEditable: boolean;
    mutationRisk: "read_only" | "mutation_capable";
  };
  action?: {
    connectionId?: string;
    proposalSchema: JsonSchema;
    resultSchema: JsonSchema;
    idempotency: "required";
    approval: "required" | "policy_controlled";
    /** Required for `policy_controlled`; needs the `actions.policy_controlled` capability. */
    policy?: { limits: readonly ApprovalLimit[] };
    timeoutMs: number;
    /**
     * Runs instead of the provider, connection or runner when the agent's effect
     * target is simulation. Output must match resultSchema.
     */
    simulate?: (
      proposal: ActionProposal,
      context: import("./simulation.js").RuntimeSimulationContext,
    ) => Promise<RuntimeRecord> | RuntimeRecord;
  } & (
    | {
        /** References an entry in the module's `providerOperations`. Input is the approved proposal preview. */
        providerOperation: { id: string; version: string };
        execute?: never;
        reconcile?: never;
      }
    | {
        providerOperation?: never;
        execute: (
          proposal: ActionProposal,
          context: AgentExecutionContext,
        ) => Promise<ActionExecutionResult> | ActionExecutionResult;
        reconcile?: (
          proposal: ActionProposal,
          context: AgentExecutionContext,
        ) => Promise<ActionExecutionResult> | ActionExecutionResult;
      }
  );
  execute?: (
    input: RuntimeRecord,
    context: AgentExecutionContext,
  ) => Promise<RuntimeResult> | RuntimeResult;
};

export type RuntimeWorkflowBinding = {
  type: string;
  label: string;
  runDisplayName?: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  conformanceInput?: RuntimeRecord;
  form: readonly WorkflowFormField[];
  toolIds: readonly string[];
  cancellation: {
    adapter: "none" | "external";
    physicalAbort: "unsupported" | "best_effort";
  };
  smokeCommand?: string;
  durable?: import("./durable.js").RuntimeDurableWorkflow;
  normalizeInput?: (input: RuntimeRecord) => RuntimeRecord;
  execute?: (
    input: RuntimeRecord,
    context: AgentExecutionContext,
  ) => Promise<RuntimeResult> | RuntimeResult;
};

export type RuntimeHealthBinding = {
  id: string;
  required: boolean;
  check: () => Promise<{ ok: boolean; summary: string }> | { ok: boolean; summary: string };
};

export type RuntimeEvalBinding = {
  id: string;
  required: boolean;
  run: () => Promise<{ ok: boolean; summary: string }> | { ok: boolean; summary: string };
};

/**
 * A provider request the platform broker performs on behalf of an approved
 * action. The module declares the contract; the environment binds `providerId`
 * to a configured connection provider that supplies the endpoint, host
 * allowlist and credential. Modules never see credentials.
 */
export type RuntimeProviderOperation = {
  id: string;
  version: string;
  providerId: string;
  /** Request authentication: `bearer` sends the stored key; `hmac-sha256` signs the canonical request. */
  auth: "bearer" | "hmac-sha256";
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Required suffix of the provider's configured action endpoint path. */
  path: string;
  inputSchema: JsonSchema;
  /** Object schema with `additionalProperties: false`; its properties are the response projection allowlist. */
  outputSchema: JsonSchema;
  timeoutMs: number;
  maxResponseBytes: number;
  /** How the projected response maps to a receipt. */
  receipt: {
    /** Output field that must echo the platform request id. */
    requestIdField: string;
    /** Output field used as the external reference, if any. */
    referenceField?: string;
    /** Output field whose value decides success; any `rejectedValues` entry fails the action. */
    statusField: string;
    rejectedValues: readonly string[];
  };
};

export type ControlPlaneRuntimeModule = {
  apiVersion: 2;
  kind: "agent_control_plane_module";
  packId: string;
  runtimeVersion: string;
  compatiblePackVersions: string;
  requirements: import("./capabilities.js").RuntimeRequirements;
  tools: readonly RuntimeToolBinding[];
  workflows: readonly RuntimeWorkflowBinding[];
  /** Requires the `actions.provider_operations` capability. */
  providerOperations?: readonly RuntimeProviderOperation[];
  health: readonly RuntimeHealthBinding[];
  evals: readonly RuntimeEvalBinding[];
  context?: readonly import("./context.js").RuntimeContextBinding[];
  state?: readonly import("./state.js").RuntimeStateDefinition[];
  stateMigrations?: readonly import("./state.js").RuntimeStateMigration[];
  settings?: import("./settings.js").RuntimeSettingsDefinition;
  queries?: readonly import("./queries.js").RuntimeQueryBinding[];
};

export type RunnerRuntimeModule = {
  apiVersion: 2;
  kind: "agent_runner_module";
  packId: string;
  runtimeVersion: string;
  compatiblePackVersions: string;
  tools: readonly RuntimeToolBinding[];
};

export type ArtifactRendererProps = {
  artifact: {
    id: string;
    kind: string;
    title?: string;
    mimeType?: string;
    data?: RuntimeRecord;
    content?: unknown;
  };
};

/**
 * Props for a package-owned chat renderer of one tool call. Values are the
 * message's own data, sanitized and size-bounded by the host; the component
 * must not fetch.
 */
export type ToolResultRendererProps = {
  toolId: string;
  status: "running" | "complete" | "incomplete" | "requires-action";
  input: RuntimeRecord;
  output?: unknown;
  artifactRefs: readonly { id: string; kind: string; title?: string }[];
};

export type ManagedStateRendererProps = {
  state: {
    id: string;
    namespace: string;
    stateType: string;
    stateKey: string;
    status: string;
    summary?: string;
    data?: RuntimeRecord;
  };
};

export type WebRuntimeModule = {
  apiVersion: 2;
  kind: "agent_web_module";
  packId: string;
  runtimeVersion: string;
  compatiblePackVersions: string;
  artifactRenderers: Readonly<Record<string, unknown>>;
  managedStateRenderers: Readonly<Record<string, unknown>>;
  /** Components keyed by tool id; each must be declared in the manifest's `toolResultRenderers`. */
  toolResultRenderers?: Readonly<Record<string, unknown>>;
};

export type AgentModulePackage = {
  manifest: LocalAgentPackManifest;
  controlPlane?: ControlPlaneRuntimeModule;
  runner?: RunnerRuntimeModule;
  web?: WebRuntimeModule;
};

export const defineControlPlaneModule = <
  const T extends Omit<ControlPlaneRuntimeModule, "apiVersion" | "kind">,
>(
  value: T,
): T & Pick<ControlPlaneRuntimeModule, "apiVersion" | "kind"> => ({
  ...value,
  apiVersion: 2,
  kind: "agent_control_plane_module",
});

export const defineRunnerModule = <
  const T extends Omit<RunnerRuntimeModule, "apiVersion" | "kind">,
>(
  value: T,
): T & Pick<RunnerRuntimeModule, "apiVersion" | "kind"> => ({
  ...value,
  apiVersion: 2,
  kind: "agent_runner_module",
});

export const defineWebModule = <const T extends Omit<WebRuntimeModule, "apiVersion" | "kind">>(
  value: T,
): T & Pick<WebRuntimeModule, "apiVersion" | "kind"> => ({
  ...value,
  apiVersion: 2,
  kind: "agent_web_module",
});

export const defaultConnectionPort = (
  connections: readonly AgentPackConnectionDescriptor[],
): ConnectionPort => ({
  async resolve(connectionId, toolId) {
    const connection = connections.find(
      (candidate) => candidate.id === connectionId && candidate.toolIds.includes(toolId),
    );
    if (!connection || connection.credentialClass === "none") {
      return {
        id: connectionId,
        status: "not_required",
        reason: `${toolId} does not require an external connection.`,
      };
    }
    return {
      id: connectionId,
      status: "authorization_required",
      reason: `${toolId} requires authorization for ${connectionId}.`,
    };
  },
});

export const defaultActionPort: ActionPort = {
  async propose(input) {
    return {
      proposalId: `proposal-${input.idempotencyKey}`,
      status: "proposed",
    };
  },
  async execute() {
    throw Object.assign(new Error("External mutation is disabled."), {
      code: "mutation_disabled",
    });
  },
};
