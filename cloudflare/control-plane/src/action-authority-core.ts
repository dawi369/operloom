import {
  type ActionExecutionResult,
  type ActionProposal,
  type AgentPackConnectionDescriptor,
  type AgentExecutionContext,
  type RuntimeToolBinding,
  type RuntimeResult,
} from "@operloom/agent-sdk/control-plane";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";
import { createBrokeredConnectionPort, issueFlyConnectionCapability } from "./connection-broker";
import { mutationsEnabled } from "./feature-gates";
import { isRecord, parseDataJson } from "./http";
import { selectMembership } from "./authz-store";
import { evaluateToolPolicy, recordToolPolicyDecision } from "./tool-policy";
import {
  invokeFlyToolRunner,
  noEgressSandboxContract,
  runnerMetadataFor,
  type ToolRunnerSandboxContract,
} from "./tool-runner";
import {
  createId,
  toJson,
  type AgentIdentity,
  type ControlActionProposalRow,
  type Env,
} from "./types";

export type RuntimeIdentity = {
  packId: string;
  packVersion: string;
  runtimeVersion: string;
  bindingVersion: number;
  runId: string;
  workflowIntentId: string;
  toolCallId?: string;
};

export const terminalStatuses = new Set([
  "executed",
  "failed",
  "reconciled",
  "cancelled",
  "expired",
]);

export const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
};

export const sha256Hex = async (value: unknown) => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(stableValue(value))),
    ),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const proposalColumns = `id, user_id, workspace_id, agent_id, workflow_intent_id, run_id,
  tool_call_id, pack_id, pack_version, runtime_version, binding_version, tool_id, action_type,
  connection_record_id, status, summary, idempotency_key, input_sha256, proposal_json,
  policy_decision_id, approval_request_id, external_reference, result_json, error_json,
  version, created_at, updated_at, terminal_at`;

export const selectProposal = (env: Env, identity: AgentIdentity, proposalId: string) =>
  env.DB.prepare(
    `SELECT ${proposalColumns} FROM control_action_proposals
     WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ? LIMIT 1`,
  )
    .bind(proposalId, identity.scope.userId, identity.scope.workspaceId, identity.agentId)
    .first<ControlActionProposalRow>();

export const appendLedgerStatement = (
  env: Env,
  identity: AgentIdentity,
  input: {
    proposalId: string;
    status: string;
    summary: string;
    requestSha256?: string | null;
    responseSha256?: string | null;
    externalReference?: string | null;
    data?: Record<string, unknown>;
    requiredStatus: string;
    requiredUpdatedAt?: string;
    timestamp: string;
  },
) =>
  env.DB.prepare(
    `INSERT INTO control_action_ledger (
       id, user_id, workspace_id, agent_id, proposal_id, sequence, status, summary,
       request_sha256, response_sha256, external_reference, data_json, created_at
     ) SELECT ?, ?, ?, ?, ?,
       COALESCE((SELECT MAX(sequence) FROM control_action_ledger WHERE proposal_id = ?), 0) + 1,
       ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_action_proposals
         WHERE id = ? AND status = ? AND (? IS NULL OR updated_at = ?)
       )`,
  ).bind(
    createId("cf-action-ledger"),
    identity.scope.userId,
    identity.scope.workspaceId,
    identity.agentId,
    input.proposalId,
    input.proposalId,
    input.status,
    input.summary,
    input.requestSha256 ?? null,
    input.responseSha256 ?? null,
    input.externalReference ?? null,
    toJson(input.data ?? {}),
    input.timestamp,
    input.proposalId,
    input.requiredStatus,
    input.requiredUpdatedAt ?? null,
    input.requiredUpdatedAt ?? null,
  );

export const actionEvidenceStatements = (
  env: Env,
  identity: AgentIdentity,
  input: {
    proposalId: string;
    action: string;
    eventType: string;
    summary: string;
    status: string;
    timestamp: string;
    data?: Record<string, unknown>;
  },
) => [
  env.DB.prepare(
    `INSERT INTO control_audit_events (
       id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
     ) SELECT ?, ?, ?, ?, ?, 'actionProposal', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_action_proposals
         WHERE id = ? AND status = ? AND updated_at = ?
       )`,
  ).bind(
    createId("cf-audit"),
    identity.scope.userId,
    identity.scope.workspaceId,
    input.action,
    input.summary,
    input.proposalId,
    toJson(input.data ?? {}),
    input.timestamp,
    input.proposalId,
    input.status,
    input.timestamp,
  ),
  env.DB.prepare(
    `INSERT INTO control_plane_events (
       id, user_id, workspace_id, agent_id, type, summary, target_type, target_id,
       data_json, created_at
     ) SELECT ?, ?, ?, ?, ?, ?, 'actionProposal', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_action_proposals
         WHERE id = ? AND status = ? AND updated_at = ?
       )`,
  ).bind(
    createId("cf-event"),
    identity.scope.userId,
    identity.scope.workspaceId,
    identity.agentId,
    input.eventType,
    input.summary,
    input.proposalId,
    toJson(input.data ?? {}),
    input.timestamp,
    input.proposalId,
    input.status,
    input.timestamp,
  ),
];

export const resolveBinding = (row: ControlActionProposalRow) => {
  const runtime = resolvePackRuntime(row.pack_id, row.pack_version);
  if (!runtime.runnable) {
    throw Object.assign(new Error("The proposal runtime is no longer compatible."), {
      code: runtime.reason,
    });
  }
  if (runtime.runtimeVersion !== row.runtime_version) {
    throw Object.assign(new Error("The proposal runtime is no longer compatible."), {
      code: "runtime_incompatible",
    });
  }
  const binding = runtime.controlPlane.tools.find((tool) => tool.id === row.tool_id) as
    | RuntimeToolBinding
    | undefined;
  if (!binding?.action) {
    throw Object.assign(new Error("The proposal action binding is unavailable."), {
      code: "action_binding_unavailable",
    });
  }
  return { runtime, binding };
};

export const manifestConnections = (packId: string): readonly AgentPackConnectionDescriptor[] => {
  const entry = agentManifestRegistry[packId as keyof typeof agentManifestRegistry];
  return entry?.module.connections ?? [];
};

export const mutationPreflight = async (
  env: Env,
  identity: AgentIdentity,
  row: ControlActionProposalRow,
) => {
  if (!mutationsEnabled(env))
    throw Object.assign(new Error("External mutation is disabled."), { code: "mutation_disabled" });
  const policy = await env.DB.prepare(
    `SELECT confirmed_at FROM control_retention_policies
     WHERE workspace_id = ? LIMIT 1`,
  )
    .bind(identity.scope.workspaceId)
    .first<{ confirmed_at: string | null }>();
  if (!policy?.confirmed_at)
    throw Object.assign(new Error("Confirm workspace retention before mutation."), {
      code: "retention_confirmation_required",
    });
  const permission = await env.DB.prepare(
    `SELECT data_json FROM tool_permissions
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND tool_id = ? LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, row.tool_id)
    .first<{ data_json: string }>();
  if (parseDataJson(permission?.data_json ?? "{}").mutationEnabled !== true) {
    throw Object.assign(
      new Error("Enable mutation for this tool in workspace policy before execution."),
      { code: "workspace_mutation_not_enabled" },
    );
  }
  const blocked = await env.DB.prepare(
    `SELECT scope_kind, scope_id, reason FROM control_kill_switches
     WHERE user_id = ? AND workspace_id = ? AND enabled = 1 AND (
       (scope_kind = 'workspace' AND scope_id = ?) OR
       (scope_kind = 'pack' AND scope_id = ?) OR
       (scope_kind = 'tool' AND scope_id = ?) OR
       (scope_kind = 'connection' AND scope_id IN (
         ?,
         COALESCE((SELECT connection_id FROM control_connections WHERE id = ?), '')
       ))
     ) ORDER BY CASE scope_kind WHEN 'workspace' THEN 0 WHEN 'pack' THEN 1 WHEN 'tool' THEN 2 ELSE 3 END
     LIMIT 1`,
  )
    .bind(
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.scope.workspaceId,
      row.pack_id,
      row.tool_id,
      row.connection_record_id ?? "",
      row.connection_record_id ?? "",
    )
    .first<{ scope_kind: string; scope_id: string; reason: string }>();
  if (blocked)
    throw Object.assign(new Error("Mutation blocked by an operator kill switch."), {
      code: "kill_switch_active",
      data: { scopeKind: blocked.scope_kind, scopeId: blocked.scope_id },
    });
  if (row.connection_record_id) {
    const connection = await env.DB.prepare(
      `SELECT status FROM control_connections WHERE id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`,
    )
      .bind(row.connection_record_id, identity.scope.userId, identity.scope.workspaceId)
      .first<{ status: string }>();
    if (connection?.status !== "authorized")
      throw Object.assign(new Error("The required connection is not authorized."), {
        code: "connection_not_authorized",
      });
  }
  const { binding } = resolveBinding(row);
  if (binding.action?.connectionId && !row.connection_record_id) {
    throw Object.assign(new Error("The required connection is not authorized."), {
      code: "connection_not_authorized",
    });
  }
};

export const evaluateActionPolicy = async (
  env: Env,
  identity: AgentIdentity,
  row: ControlActionProposalRow,
  surface: "admin_run" | "admin_resume",
) => {
  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  const result = await evaluateToolPolicy(env, identity, {
    membership,
    toolName: row.tool_id,
    executionMode: "execute",
    surface,
  });
  const decisionId = await recordToolPolicyDecision(env, identity, {
    toolName: row.tool_id,
    surface,
    result,
    data: { source: "action_authority", proposalId: row.id },
  });
  return { result, decisionId };
};

export const executionContext = (
  env: Env,
  identity: AgentIdentity,
  row: ControlActionProposalRow,
  connections: readonly AgentPackConnectionDescriptor[],
): AgentExecutionContext => ({
  scope: { ...identity.scope, agentId: identity.agentId },
  pack: { id: row.pack_id, version: row.pack_version, runtimeVersion: row.runtime_version },
  run: {
    id: row.run_id,
    workflowIntentId: row.workflow_intent_id,
    executionMode: "execute",
    source: "user",
  },
  signal: new AbortController().signal,
  connections: createBrokeredConnectionPort(env, identity, connections),
  actions: {
    async propose() {
      throw Object.assign(new Error("Nested action proposals are disabled."), {
        code: "nested_action_disabled",
      });
    },
    async execute() {
      throw Object.assign(new Error("Nested action execution is disabled."), {
        code: "nested_action_disabled",
      });
    },
  },
  tools: {
    async invoke() {
      throw Object.assign(new Error("Action executors cannot invoke tools."), {
        code: "nested_tool_invocation_disabled",
      });
    },
  },
  managedState: {
    async upsert() {
      throw Object.assign(new Error("Action executors cannot write managed state directly."), {
        code: "managed_state_write_disabled",
      });
    },
  },
  events: { async append() {} },
});

export const dispatchAction = async (
  env: Env,
  identity: AgentIdentity,
  row: ControlActionProposalRow,
  binding: RuntimeToolBinding,
  proposal: ActionProposal,
): Promise<ActionExecutionResult> => {
  if (binding.transport === "cloudflare_inline") {
    return binding.action!.execute(
      proposal,
      executionContext(env, identity, row, manifestConnections(row.pack_id)),
    );
  }
  const runner = runnerMetadataFor(
    {
      toolName: binding.id,
      adapterVersion: binding.adapterVersion,
      supportedExecutionModes: [...binding.executionModes],
      transport: "fly",
    },
    "agent-pack",
    "fly",
    (binding.sandbox as ToolRunnerSandboxContract | undefined) ??
      noEgressSandboxContract({
        template: binding.adapterVersion,
        maxRuntimeMs: binding.action!.timeoutMs,
        maxArtifactBytes: binding.maxArtifactBytes,
      }),
  );
  const connectionCapability =
    binding.action!.connectionId && row.connection_record_id
      ? await issueFlyConnectionCapability(env, identity, {
          connectionRecordId: row.connection_record_id,
          connectionId: binding.action!.connectionId,
          runId: row.run_id,
          workflowIntentId: row.workflow_intent_id,
          toolCallId: row.tool_call_id ?? `action:${row.id}`,
          toolId: binding.id,
          timeoutMs: binding.action!.timeoutMs,
        })
      : undefined;
  const result = await invokeFlyToolRunner(env, identity, {
    scope: identity.scope,
    agentId: identity.agentId,
    runId: row.run_id,
    workflowIntentId: row.workflow_intent_id,
    toolCallId: row.tool_call_id ?? `action:${row.id}`,
    packVersion: row.pack_version,
    runtimeVersion: row.runtime_version,
    bindingVersion: row.binding_version,
    toolName: binding.id,
    execution: { mode: "execute", policy: binding.policy.reference },
    input: {
      summary: proposal.summary,
      idempotencyKey: proposal.idempotencyKey,
      preview: proposal.preview,
    },
    runner,
    connectionCapability,
    policyDecisionId: row.policy_decision_id ?? undefined,
    source: "agent-pack",
  });
  const runtimeResult = result as RuntimeResult;
  if (!runtimeResult.ok) {
    return {
      proposalId: row.id,
      status: "failed",
      summary: runtimeResult.summary,
    };
  }
  const output = runtimeResult.output;
  const status = output.status === "outcome_unknown" ? "outcome_unknown" : "executed";
  return {
    proposalId: row.id,
    status,
    summary: runtimeResult.summary,
    externalReference:
      typeof output.externalReference === "string" ? output.externalReference : undefined,
    output,
  };
};
