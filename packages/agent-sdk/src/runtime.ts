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
};

export type ActionExecutionResult = {
  proposalId: string;
  status: "executed" | "failed" | "outcome_unknown" | "reconciled";
  summary: string;
  externalReference?: string;
  output?: RuntimeRecord;
};

export type ActionPort = {
  propose(input: ActionProposal): Promise<{ proposalId: string; status: "proposed" }>;
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

export type AgentExecutionContext = {
  scope: Readonly<RuntimeScope>;
  pack: Readonly<{ id: string; version: string; runtimeVersion: string }>;
  run: Readonly<{
    id: string;
    workflowIntentId: string;
    executionMode: AgentPackExecutionMode;
    source: "user" | "trigger" | "retry";
  }>;
  /** Signed runner restrictions; network tools must enforce these on every hop. */
  networkPolicy?: Readonly<{
    egress: "none" | "public_web" | "broker_only";
    allowedSchemes: readonly string[];
    allowedHosts: readonly string[];
    deniedHosts: readonly string[];
  }>;
  signal: AbortSignal;
  connections: ConnectionPort;
  actions: ActionPort;
  tools: {
    invoke(toolId: string, input: RuntimeRecord): Promise<RuntimeResult>;
  };
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
    timeoutMs: number;
    execute: (
      proposal: ActionProposal,
      context: AgentExecutionContext,
    ) => Promise<ActionExecutionResult> | ActionExecutionResult;
    reconcile?: (
      proposal: ActionProposal,
      context: AgentExecutionContext,
    ) => Promise<ActionExecutionResult> | ActionExecutionResult;
  };
  execute?: (
    input: RuntimeRecord,
    context: AgentExecutionContext,
  ) => Promise<RuntimeResult> | RuntimeResult;
};

export type RuntimeWorkflowBinding = {
  type: string;
  engine: "cloudflare" | "langgraph";
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

export type ControlPlaneRuntimeModule = {
  apiVersion: 1;
  kind: "agent_control_plane_module";
  packId: string;
  runtimeVersion: string;
  compatiblePackVersions: string;
  tools: readonly RuntimeToolBinding[];
  workflows: readonly RuntimeWorkflowBinding[];
  health: readonly RuntimeHealthBinding[];
  evals: readonly RuntimeEvalBinding[];
};

export type RunnerRuntimeModule = {
  apiVersion: 1;
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
  apiVersion: 1;
  kind: "agent_web_module";
  packId: string;
  runtimeVersion: string;
  compatiblePackVersions: string;
  artifactRenderers: Readonly<Record<string, unknown>>;
  managedStateRenderers: Readonly<Record<string, unknown>>;
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
  apiVersion: 1,
  kind: "agent_control_plane_module",
  ...value,
});

export const defineRunnerModule = <
  const T extends Omit<RunnerRuntimeModule, "apiVersion" | "kind">,
>(
  value: T,
): T & Pick<RunnerRuntimeModule, "apiVersion" | "kind"> => ({
  apiVersion: 1,
  kind: "agent_runner_module",
  ...value,
});

export const defineWebModule = <const T extends Omit<WebRuntimeModule, "apiVersion" | "kind">>(
  value: T,
): T & Pick<WebRuntimeModule, "apiVersion" | "kind"> => ({
  apiVersion: 1,
  kind: "agent_web_module",
  ...value,
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
