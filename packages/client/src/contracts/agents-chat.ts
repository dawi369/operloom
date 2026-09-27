import type { Id } from "../core-contracts.js";
import type { ControlPlaneEvent } from "./execution.js";

export type AgentRuntimeConfig = {
  provider: "openrouter";
  model: string;
  temperature: number;
  maxTokens: number;
  source: "agent" | "system-default";
};

export type AgentBehaviorConfig = {
  profile: "default" | "analyst" | "operator";
  source: "server-preset" | "template-snapshot";
  version: string;
  instructionId: string;
  format?: "xml";
  templateId?: string;
  authoring?: AgentBehaviorAuthoringMetadata;
  pack?: AgentPackTemplateMetadata;
  preview?: string;
};

export type AgentBehaviorAuthoringMetadata = {
  kind?: "built_in_template" | "local_agent_pack" | string;
  format?: "xml" | string;
  source?: "cloudflare-control-plane" | "agent-pack" | string;
  editable?: boolean;
  snapshotOnCreate?: boolean;
  packId?: string;
  packVersion?: string;
  folderPath?: string;
  codePath?: string;
  promptPath?: string;
};

export type AgentPackTemplateMetadata = {
  apiVersion?: 2;
  id: string;
  name?: string;
  description?: string;
  version?: string;
  capabilityLevel: "template" | "single_agent_app" | string;
  folderPath: string;
  codePath: string;
  promptPath: string;
  tools: Array<{
    id: string;
    invocation?: "user" | "agent" | "workflow" | string;
    required?: boolean;
    executionModes?: string[];
    modelVisibleDefault?: boolean;
    purpose?: string;
  }>;
  workflows: Array<{
    type: string;
    status?: "declared" | string;
    userInvocable?: boolean;
    description?: string;
  }>;
  ui: {
    primarySurface?: "chat" | "workbench" | "admin" | string;
    inspectorSections?: string[];
    configurationMode?: "code" | "ui_future" | string;
    welcome?: {
      title: string;
      description: string;
      starters: Array<{
        id: string;
        title: string;
        description: string;
        action: { kind: "message"; prompt: string } | { kind: "workflow"; workflowType: string };
      }>;
    };
  };
  risk: {
    financialData?: boolean;
    externalMutation?: boolean;
    requiresSecrets?: boolean;
    productionGate?: string;
  };
  context: Array<
    | string
    | {
        id: string;
        trust: "trusted" | "retrieved" | "untrusted";
        description: string;
        required: boolean;
        runtimeBinding: string;
      }
  >;
  managedState?: Array<{
    namespace: string;
    schemaVersion: number;
    description: string;
    recordKinds: string[];
    views: Array<{ id: string; title: string; recordKind: string }>;
  }>;
  triggers?: Array<{
    id: string;
    kind: "schedule" | "webhook" | "monitor";
    description: string;
    workflowType: string;
    enabledByDefault: false;
  }>;
  artifactRenderers?: Array<{
    artifactKind: string;
    renderer: "json" | "markdown" | "table";
    title: string;
    version: number;
  }>;
  healthChecks?: Array<{
    id: string;
    target: { kind: "tool"; id: string } | { kind: "workflow"; type: string };
    description: string;
    required: boolean;
  }>;
  evals?: Array<{
    id: string;
    kind: "static_smoke" | "deterministic_runtime";
    scenarioId: string;
    description: string;
    required: boolean;
  }>;
  compatibility?: {
    packApi: 2;
    minimumWorkbenchVersion: string;
    maximumWorkbenchVersion?: string;
  };
  resourceLimits?: {
    maxRunSeconds: number;
    maxToolCallsPerRun: number;
    maxConcurrentRuns: number;
    maxArtifactBytes: number;
  };
  smokeScenarios: Array<{
    id: string;
    prompt: string;
  }>;
};

export type AgentBehaviorTemplate = {
  id: string;
  name: string;
  description: string;
  profile: "default" | "analyst" | "operator";
  version: string;
  format: "xml";
  authoring?: AgentBehaviorAuthoringMetadata;
  pack?: AgentPackTemplateMetadata;
  prompt: string;
};

export type ChatRuntimeSummary = {
  state:
    | "no_session"
    | "no_thread"
    | "thread_ready"
    | "blocked"
    | "running"
    | "failed"
    | "completed";
  latestSession: {
    sessionId?: Id;
    agentId?: Id;
    status?: string;
    activeThreadId?: Id;
    metadata?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
    lastSeenAt?: string;
  } | null;
  latestThread: {
    threadId?: Id;
    sessionId?: Id;
    agentId?: Id;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
    lastSeenAt?: string;
  } | null;
  latestRun: {
    id?: Id;
    threadId?: Id;
    agentId?: Id;
    upstreamRunId?: Id;
    status?: string;
    metadata?: Record<string, unknown>;
    error?: string;
    startedAt?: string;
    completedAt?: string;
    failedAt?: string;
    updatedAt?: string;
  } | null;
  latestIntent: {
    id?: Id;
    executionMode?: string;
    status?: string;
    updatedAt?: string;
  } | null;
  latestPolicyDecision: {
    id?: Id;
    decision?: string;
    reason?: string;
    executionMode?: string;
    limits?: Record<string, unknown>;
    createdAt?: string;
  } | null;
  timings: {
    firstTokenMs?: number;
    totalMs?: number;
    preStreamMs?: number;
    providerMs?: number;
    stageMarks: Record<string, number>;
  } | null;
  events: ControlPlaneEvent[];
  failure: {
    source: "chat-run" | "chat-policy";
    message: string;
    status?: string;
    targetId?: Id;
    createdAt?: string;
    errorCode?: string;
    retryable?: boolean;
  } | null;
};

export type ChatRuntimeSummaryResponse = {
  ok?: boolean;
  generatedAt?: string;
  chatRuntime?: ChatRuntimeSummary;
  error?: string;
};

export type ChatThreadSummary = {
  threadId: Id;
  sessionId: Id;
  agentId: Id;
  agent?: AgentSummary | null;
  status: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
  isActive: boolean;
  agentHandoff?: AgentHandoffSummary | null;
  latestRunStatus?: string;
  messageCount?: number;
};

export type AgentSwitchTarget = "current_thread" | "new_thread";

export type AgentHandoffSummary = {
  id: Id;
  threadId?: Id;
  fromAgentId?: Id;
  fromAgentName?: string;
  toAgentId: Id;
  toAgentName: string;
  target: AgentSwitchTarget;
  createdAt: string;
};

export type ChatThreadStatus = "active" | "archived" | "deleted" | "draft";

export type ChatThreadsResponse = {
  ok?: boolean;
  threads?: ChatThreadSummary[];
  error?: string;
};

export type ChatThreadResponse = {
  ok?: boolean;
  thread?: ChatThreadSummary | null;
  error?: string;
};

export type ChatSessionResponse = {
  ok?: boolean;
  revision?: number;
  isStale?: boolean;
  partial?: boolean;
  threadsRefreshRecommended?: boolean;
  workspace?: {
    id: Id;
    name: string;
    status: string;
    isDefault: boolean;
  } | null;
  activeAgent?: AgentSummary | null;
  activeThread?: ChatThreadSummary | null;
  threads?: ChatThreadSummary[];
  agentHandoff?: AgentHandoffSummary | null;
  connection?: {
    chatProtocolVersion?: number;
    agentHost?: string;
    agentName?: string;
    instanceName?: string;
    token?: string;
    threadId?: Id;
    sessionId?: Id;
    workspaceId?: Id;
    agentId?: Id;
    expiresAt?: string;
  };
  stagedThread?: {
    threadId: Id;
    sessionId: Id;
    expiresAt: string;
    status: "draft";
  };
  pending?: { type: "create" } | { type: "activate"; threadId: Id };
  materializedTurn?: { threadId: Id; status: "accepted"; messageId?: Id; duplicate?: boolean };
  transition?: {
    type:
      | "initial"
      | "create"
      | "activate"
      | "agent_handoff"
      | "rename"
      | "archive"
      | "restore"
      | "delete"
      | "token_refresh";
    startedAt?: string;
  };
  expiresAt?: string;
  error?: string;
};

export type WorkbenchSessionEvent = {
  id: Id;
  type:
    | "session.snapshot"
    | "session.thread.created"
    | "session.thread.activated"
    | "session.agent.handoff"
    | "session.thread.updated"
    | "session.threads.refreshed"
    | "chat.run.started"
    | "chat.run.completed"
    | "chat.run.failed"
    | "workflow.run.updated"
    | "approval.updated"
    | "action.updated"
    | "tool.run.updated"
    | "trace.updated"
    | "admin.summary.invalidated";
  revision?: number;
  createdAt: string;
  data: Record<string, unknown>;
};

export type AgentSummary = {
  id: Id;
  name: string;
  description: string | null;
  status: string;
  profile: "default" | "analyst" | "operator";
  runtime: AgentRuntimeConfig;
  behavior: AgentBehaviorConfig;
  isDefault: boolean;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type CloudflareAgentsResponse = {
  ok?: boolean;
  activeAgentId?: Id;
  agents?: AgentSummary[];
  error?: string;
};

export type CloudflareAgentBehaviorTemplatesResponse = {
  ok?: boolean;
  templates?: AgentBehaviorTemplate[];
  error?: string;
};

export type CloudflareAgentMutationResponse = {
  ok?: boolean;
  activeAgentId?: Id;
  agent?: AgentSummary | null;
  error?: string;
};

export type WorkspaceContextResponse = {
  ok?: boolean;
  context?: {
    identity: {
      userId: Id;
      workspaceId: Id;
      agentId: Id;
      authMode: string;
      workspaceSource: string;
    };
    account: {
      id: Id;
      source: string;
    } | null;
    user: {
      id: Id;
      email: string | null;
      displayName: string | null;
      status: string;
    } | null;
    workspace: {
      id: Id;
      name: string;
      status: string;
      isDefault: boolean;
    } | null;
    membership: {
      role: string;
      status: string;
      roles: string[];
      permissions: string[];
    } | null;
    agent: {
      id: Id;
      name: string;
      status: string;
      isDefault: boolean;
    } | null;
  };
  error?: string;
};
