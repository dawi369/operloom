export const agentPackProfiles = ["default", "analyst", "operator"] as const;
export type AgentPackProfile = (typeof agentPackProfiles)[number];

export const agentPackExecutionModes = ["ask", "dry_run", "execute"] as const;
export type AgentPackExecutionMode = (typeof agentPackExecutionModes)[number];

export const agentPackToolInvocations = ["user", "agent", "workflow"] as const;
export type AgentPackToolInvocation = (typeof agentPackToolInvocations)[number];

export type AgentPackCapabilityLevel = "template" | "single_agent_app";

export type AgentPackContextSource = {
  id: string;
  trust: "trusted" | "retrieved" | "untrusted";
  description: string;
  required: boolean;
  runtimeBinding: string;
};

export type AgentPackManagedStateDescriptor = {
  namespace: string;
  schemaVersion: number;
  description: string;
  recordKinds: readonly string[];
  views: readonly {
    id: string;
    title: string;
    recordKind: string;
  }[];
};

export type AgentPackTrigger =
  | {
      id: string;
      kind: "schedule";
      description: string;
      workflowType: string;
      enabledByDefault: false;
      cron: string;
      timezone: string;
    }
  | {
      id: string;
      kind: "webhook";
      description: string;
      workflowType: string;
      enabledByDefault: false;
      eventType: string;
    }
  | {
      id: string;
      kind: "monitor";
      description: string;
      workflowType: string;
      enabledByDefault: false;
      intervalSeconds: number;
    };

export type AgentPackArtifactRenderer = {
  artifactKind: string;
  /** `module`: the web module supplies a component; the generic kinds render data as-is. */
  renderer: "json" | "markdown" | "table" | "module";
  title: string;
  version: number;
  /** Serialized payload bound for a `module` renderer; larger payloads use the JSON fallback. Default 65536. */
  maxBytes?: number;
};

/** A tool whose chat result the web module renders with its own component. */
export type AgentPackToolResultRenderer = {
  toolId: string;
  version: number;
  /** Serialized result bound; larger results use the generic tool fallback. Default 65536. */
  maxBytes?: number;
};

export type AgentPackHealthCheck = {
  id: string;
  target: { kind: "tool"; id: string } | { kind: "workflow"; type: string };
  description: string;
  required: boolean;
};

export type AgentPackEval = {
  id: string;
  kind: "static_smoke" | "deterministic_runtime";
  scenarioId: string;
  description: string;
  required: boolean;
};

export type AgentPackCompatibility = {
  packApi: 2;
  minimumWorkbenchVersion: string;
  maximumWorkbenchVersion?: string;
};

export type AgentPackResourceLimits = {
  maxRunSeconds: number;
  maxToolCallsPerRun: number;
  maxConcurrentRuns: number;
  maxArtifactBytes: number;
  /** Longest chain of delegated runs this package's workflows may sit at the end of. Default 2. */
  maxDelegationDepth?: number;
  /** Tasks one run may delegate. Default 4. */
  maxDelegationFanOut?: number;
};

export type AgentPackDeclaredTool = {
  id: string;
  invocation: AgentPackToolInvocation;
  required: boolean;
  executionModes: readonly AgentPackExecutionMode[];
  modelVisibleDefault: boolean;
  purpose: string;
};

export type AgentPackWorkflow = {
  type: string;
  status: "declared";
  userInvocable: boolean;
  /** Another agent's run may delegate this workflow; user-invocable workflows always may. */
  delegable?: boolean;
  description: string;
};

export type AgentPackStarter = {
  id: string;
  title: string;
  description: string;
  action: { kind: "message"; prompt: string } | { kind: "workflow"; workflowType: string };
};

export type AgentPackUiHints = {
  primarySurface: "chat" | "workbench" | "admin";
  inspectorSections: readonly string[];
  configurationMode: "code" | "ui_future";
  welcome: {
    title: string;
    description: string;
    starters: readonly AgentPackStarter[];
  };
};

export type AgentPackRisk = {
  financialData: boolean;
  externalMutation: boolean;
  requiresSecrets: boolean;
  productionGate: "none" | "mutation_gate" | string;
};

export type AgentPackConnectionDescriptor = {
  id: string;
  provider: string;
  principal: "none" | "app" | "user";
  credentialClass: "none" | "oauth2" | "api_key";
  custody: "none" | "external_broker";
  required: boolean;
  toolIds: readonly string[];
  scopes: readonly string[];
};

/** A notification type the package may emit and the channels it reaches when the user has not chosen. */
export type AgentPackNotification = {
  type: string;
  description: string;
  defaultChannels: readonly ("push" | "email" | "sms")[];
};

export type AgentPackMemoryKind = "goal" | "preference" | "watchlist" | "conclusion" | "note";

/**
 * How the platform treats memory this package's model and workflows write. Absent fields
 * take platform defaults; packages with `risk.financialData` default to activating nothing.
 */
export type AgentPackMemoryPolicy = {
  /** Kinds a model or workflow write activates without the user's confirmation. */
  autoActivate?: readonly AgentPackMemoryKind[];
  /** Days until a non-user record expires, per kind; omitted kinds use platform defaults. */
  ttlDays?: Partial<Record<AgentPackMemoryKind, number | null>>;
  /** JSON schema the platform validates `content` against before a write lands, per kind. */
  contentSchema?: Partial<Record<AgentPackMemoryKind, Readonly<Record<string, unknown>>>>;
};

export type LocalAgentPackManifest = {
  apiVersion: 2;
  kind: "agent_pack";
  id: string;
  templateId: `pack-${string}`;
  name: string;
  description: string;
  profile: AgentPackProfile;
  version: string;
  capabilityLevel: AgentPackCapabilityLevel;
  format: "xml";
  folderPath: string;
  codePath: string;
  promptPath: string;
  tools: readonly AgentPackDeclaredTool[];
  workflows: readonly AgentPackWorkflow[];
  ui: AgentPackUiHints;
  risk: AgentPackRisk;
  connections: readonly AgentPackConnectionDescriptor[];
  context: readonly AgentPackContextSource[];
  managedState: readonly AgentPackManagedStateDescriptor[];
  triggers: readonly AgentPackTrigger[];
  notifications?: readonly AgentPackNotification[];
  memory?: AgentPackMemoryPolicy;
  artifactRenderers: readonly AgentPackArtifactRenderer[];
  toolResultRenderers?: readonly AgentPackToolResultRenderer[];
  healthChecks: readonly AgentPackHealthCheck[];
  evals: readonly AgentPackEval[];
  compatibility: AgentPackCompatibility;
  resourceLimits: AgentPackResourceLimits;
  smokeScenarios: readonly {
    id: string;
    prompt: string;
  }[];
  prompt: string;
};

export type AgentPackDefinition = Omit<
  LocalAgentPackManifest,
  "apiVersion" | "kind" | "templateId"
>;

export const defineAgentPack = <const T extends AgentPackDefinition>(
  definition: T,
): T & Pick<LocalAgentPackManifest, "apiVersion" | "kind" | "templateId"> => ({
  apiVersion: 2,
  kind: "agent_pack",
  templateId: `pack-${definition.id}`,
  ...definition,
});
