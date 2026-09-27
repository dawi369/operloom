import { z } from "zod";
import { actionProposalSummarySchema } from "./public-action-contracts.js";

const id = z.string().min(1);
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const jsonObject = z.record(z.string(), z.unknown());
const nonNegativeInteger = z.number().int().nonnegative();

const envelope = {
  ok: z.boolean(),
  error: z.string().optional(),
};

const tenantScope = z.object({ userId: id, workspaceId: id }).passthrough();
const workspace = z
  .object({ id, name: z.string(), status: z.string(), isDefault: z.boolean() })
  .passthrough();
const runtime = z
  .object({
    provider: z.literal("openrouter"),
    model: z.string().min(1),
    temperature: z.number(),
    maxTokens: nonNegativeInteger,
    source: z.enum(["agent", "system-default"]),
  })
  .passthrough();
const behavior = z
  .object({
    profile: z.enum(["default", "analyst", "operator"]),
    source: z.enum(["server-preset", "template-snapshot"]),
    version: z.string().min(1),
    instructionId: id,
  })
  .passthrough();
const agent = z
  .object({
    id,
    name: z.string(),
    description: z.string().nullable(),
    status: z.string().min(1),
    profile: z.enum(["default", "analyst", "operator"]),
    runtime,
    behavior,
    isDefault: z.boolean(),
    isActive: z.boolean(),
    createdAt: timestamp.optional(),
    updatedAt: timestamp.optional(),
  })
  .passthrough();
const handoff = z
  .object({
    id,
    toAgentId: id,
    toAgentName: z.string(),
    target: z.enum(["current_thread", "new_thread"]),
    createdAt: timestamp,
  })
  .passthrough();
const thread = z
  .object({
    threadId: id,
    sessionId: id,
    agentId: id,
    agent: agent.nullable().optional(),
    status: z.string().min(1),
    title: z.string(),
    isActive: z.boolean(),
    createdAt: timestamp.optional(),
    updatedAt: timestamp.optional(),
    lastSeenAt: timestamp.optional(),
    agentHandoff: handoff.nullable().optional(),
    latestRunStatus: z.string().optional(),
    messageCount: nonNegativeInteger.optional(),
  })
  .passthrough();
const runRelation = z
  .object({
    kind: z.string().optional(),
    parentRunId: id.optional(),
    rootRunId: id.optional(),
    depth: nonNegativeInteger.optional(),
    durableChild: z.boolean().optional(),
  })
  .passthrough();
const artifact = z
  .object({
    id,
    scope: tenantScope.optional(),
    kind: z.string().optional(),
    uri: z.string().optional(),
    title: z.string().optional(),
    mimeType: z.string().optional(),
    sizeBytes: nonNegativeInteger.optional(),
    data: jsonObject.optional(),
    createdAt: timestamp.optional(),
  })
  .passthrough();
const runSummary = z
  .object({
    id,
    scope: tenantScope.optional(),
    agentId: id.optional(),
    workflowIntentId: id.optional(),
    status: z
      .enum([
        "queued",
        "running",
        "waiting",
        "interrupted",
        "blocked",
        "completed",
        "failed",
        "cancelled",
      ])
      .or(z.string().min(1))
      .optional(),
    stage: z.string().optional(),
    engine: z.string().optional(),
    artifactIds: z.array(id).optional(),
    decisionIds: z.array(id).optional(),
    toolCallCount: nonNegativeInteger.optional(),
    createdAt: timestamp.optional(),
    updatedAt: timestamp.optional(),
    completedAt: timestamp.optional(),
    failedAt: timestamp.optional(),
    controls: z
      .object({ canCancel: z.boolean(), canRetry: z.boolean(), canResume: z.boolean() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const toolCall = z
  .object({ id, status: z.string().optional(), relation: runRelation.optional() })
  .passthrough();
const workflowReview = z.object({
  payload: jsonObject,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: timestamp,
});
const approval = z
  .object({
    id: id.optional(),
    scope: tenantScope.optional(),
    runId: id.optional(),
    toolId: z.string().optional(),
    status: z.string().optional(),
    review: workflowReview.optional(),
    createdAt: timestamp.optional(),
    updatedAt: timestamp.optional(),
  })
  .passthrough();
const executionSnapshot = z
  .object({
    scope: tenantScope,
    intent: z.object({}).passthrough().nullable(),
    run: z.object({}).passthrough().nullable(),
    toolCalls: z.array(toolCall),
    artifacts: z.array(artifact),
    decisions: z.array(z.object({ id }).passthrough()),
    auditEvents: z.array(z.object({ id }).passthrough()),
    childRuns: z.array(z.object({}).passthrough()).optional(),
    interventions: z
      .array(
        z
          .object({ id, runId: id, workflowIntentId: id, review: workflowReview.optional() })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const connection = z
  .object({
    id,
    provider: z.string().min(1),
    principal: z.enum(["none", "app", "user"]),
    credentialClass: z.enum(["none", "oauth2", "api_key"]),
    required: z.boolean(),
    toolIds: z.array(z.string()),
    requestedScopes: z.array(z.string()),
    status: z.string().min(1),
    grantedScopes: z.array(z.string()),
    tokenExpiresAt: timestamp.optional(),
    lastHealthAt: timestamp.optional(),
    version: nonNegativeInteger.optional(),
  })
  .passthrough();
const proposal = actionProposalSummarySchema;
const managedState = z
  .object({
    id,
    agentId: id,
    namespace: z.string(),
    stateType: z.string(),
    stateKey: z.string(),
    type: z.string(),
    name: z.string(),
    status: z.string(),
    version: nonNegativeInteger,
    artifactRefs: z.array(id),
    data: jsonObject,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .passthrough();
const device = z
  .object({
    id,
    installationId: id,
    platform: z.enum(["ios", "android"]),
    provider: z.literal("expo"),
    status: z.enum(["active", "disabled", "revoked"]),
    lastSeenAt: timestamp,
    appVersion: z.string().min(1),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .passthrough();

export const responseSchemas = {
  session: z
    .object({
      ...envelope,
      revision: nonNegativeInteger.optional(),
      workspace: workspace.nullable().optional(),
      activeAgent: agent.nullable().optional(),
      activeThread: thread.nullable().optional(),
      threads: z.array(thread).optional(),
      agentHandoff: handoff.nullable().optional(),
      connection: z
        .object({
          chatProtocolVersion: z.literal(2),
          agentHost: z.string().min(1).optional(),
          token: z.string().min(1).optional(),
          threadId: id.optional(),
          sessionId: id.optional(),
          workspaceId: id.optional(),
          agentId: id.optional(),
          expiresAt: timestamp.optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
  threads: z.object({ ...envelope, threads: z.array(thread) }).passthrough(),
  accounts: z
    .object({
      ...envelope,
      currentAccountId: id.optional(),
      currentOrganizationId: id.optional(),
      accounts: z.array(
        z
          .object({
            id,
            name: z.string(),
            source: z.enum(["workos-organization", "workos-personal", "local-dev"]),
            isCurrent: z.boolean(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
  workspaces: z
    .object({ ...envelope, activeWorkspaceId: id.optional(), workspaces: z.array(workspace) })
    .passthrough(),
  workspaceMutation: z
    .object({
      ...envelope,
      activeWorkspaceId: id.optional(),
      workspace: workspace.nullable().optional(),
    })
    .passthrough(),
  agents: z
    .object({ ...envelope, activeAgentId: id.optional(), agents: z.array(agent) })
    .passthrough(),
  agentMutation: z
    .object({ ...envelope, activeAgentId: id.optional(), agent: agent.nullable().optional() })
    .passthrough(),
  workflows: z
    .object({
      ...envelope,
      runnable: z.boolean(),
      workflows: z.array(
        z
          .object({
            type: z.string().min(1),
            label: z.string(),
            engine: z.enum(["cloudflare"]),
            inputSchema: jsonObject,
            outputSchema: jsonObject,
            toolIds: z.array(z.string()),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
  toolRun: z
    .object({
      ...envelope,
      run: z.object({ id: id.optional(), status: z.string().optional() }).passthrough().optional(),
      approvalRequest: approval.optional(),
      toolCall: toolCall.nullable().optional(),
      artifact: artifact.nullable().optional(),
      result: jsonObject.optional(),
    })
    .passthrough(),
  runList: z
    .object({ ...envelope, runs: z.array(runSummary), limit: nonNegativeInteger.optional() })
    .passthrough(),
  runDetail: z
    .object({ ...envelope, snapshot: executionSnapshot.nullable().optional() })
    .passthrough(),
  executionRun: z
    .object({ ...envelope, snapshot: executionSnapshot.nullable().optional() })
    .passthrough(),
  artifacts: z
    .object({ ...envelope, artifacts: z.array(artifact), limit: nonNegativeInteger.optional() })
    .passthrough(),
  approvals: z.object({ ...envelope, approvals: z.array(approval) }).passthrough(),
  connections: z
    .object({ ...envelope, enabled: z.boolean().optional(), connections: z.array(connection) })
    .passthrough(),
  connectionAuthorization: z
    .object({ ...envelope, authorizationUrl: z.url(), expiresAt: timestamp })
    .passthrough(),
  actions: z
    .object({ ...envelope, proposals: z.array(proposal).optional(), result: jsonObject.optional() })
    .passthrough(),
  managedState: z
    .object({ ...envelope, states: z.array(managedState), limit: nonNegativeInteger.optional() })
    .passthrough(),
  devices: z
    .object({
      ...envelope,
      enabled: z.boolean().optional(),
      devices: z.array(device).optional(),
      device: device.optional(),
      revoked: z.boolean().optional(),
    })
    .passthrough(),
  notificationPreferences: z
    .object({
      ...envelope,
      enabled: z.boolean().optional(),
      preferences: z
        .object({
          approvalRequired: z.boolean(),
          terminalOutcomes: z.boolean(),
          updatedAt: timestamp.optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
} as const;

export type ResponseSchemaName = keyof typeof responseSchemas;

export const responseSchemaContract = Object.freeze(
  Object.fromEntries(
    Object.keys(responseSchemas)
      .sort()
      .map((name) => [name, 1]),
  ) as Record<ResponseSchemaName, 1>,
);
