import type { RuntimeToolBinding } from "@operloom/agent-sdk/control-plane";
import type { AgentPackConnectionDescriptor } from "../../../agent-packs";

import { resolveAgentBehaviorConfig } from "./agent-records";
import { selectAgent, selectMembership } from "./authz-store";
import { connectionAuthForPackTool } from "./connection-auth";
import {
  readDynamicCapabilityContext,
  resolveDynamicToolCapabilities,
  type DynamicCapabilityContext,
} from "./dynamic-capabilities";
import { parseDataJson, parseJson } from "./http";
import {
  artifactMetadataTestPolicy,
  artifactMetadataTestToolName,
  diagnosticPingPolicy,
  diagnosticPingToolName,
  runnerEchoAdapterVersion,
  runnerEchoPolicy,
  runnerEchoToolName,
  runArtifactMetadataTest,
  runDiagnosticPing,
} from "../../../lib/workbench/admin-test-tools";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { evaluateToolPolicy, type ToolPolicyResult } from "./tool-policy";
import { isFlyRunnerConfigured, runnerMetadataFor } from "./tool-runner";
import type {
  AgentIdentity,
  AgentRow,
  ControlApprovalRequestRow,
  ControlArtifactRow,
  ControlToolCallRow,
  Env,
  TenantScope,
} from "./types";

const labelInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { label: { type: "string", maxLength: 80 } },
} as const;

const diagnosticPingBinding = {
  id: diagnosticPingToolName,
  description: "Run a deterministic control-plane diagnostic ping.",
  inputSchema: labelInputSchema,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "summary", "checkedAt"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      summary: { type: "string" },
      label: { type: "string" },
      checkedAt: { type: "string" },
    },
  },
  executionModes: ["dry_run"],
  transport: "cloudflare_inline",
  adapterVersion: "diagnostic-ping-v1",
  timeoutMs: 1_000,
  maxArtifactBytes: 0,
  policy: {
    reference: diagnosticPingPolicy,
    adminVisible: true,
    modelVisible: false,
    requiresApproval: false,
    policyEditable: false,
    mutationRisk: "read_only",
  },
  execute(input) {
    const result = runDiagnosticPing(input);
    return result.ok
      ? { ok: true, output: result.output, summary: result.output.summary }
      : { ok: false, error: result.error, summary: result.error.message };
  },
} as const satisfies RuntimeToolBinding;

const artifactMetadataBinding = {
  id: artifactMetadataTestToolName,
  description: "Create deterministic metadata-only artifact evidence.",
  inputSchema: labelInputSchema,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "summary", "artifact"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      summary: { type: "string" },
      label: { type: "string" },
      artifact: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title", "mimeType"],
        properties: {
          kind: { type: "string", enum: ["report"] },
          title: { type: "string" },
          mimeType: { type: "string", enum: ["application/json"] },
        },
      },
    },
  },
  executionModes: ["dry_run"],
  transport: "cloudflare_inline",
  adapterVersion: "artifact-metadata-test-v1",
  timeoutMs: 1_000,
  maxArtifactBytes: 16 * 1024,
  policy: {
    reference: artifactMetadataTestPolicy,
    adminVisible: true,
    modelVisible: false,
    requiresApproval: false,
    policyEditable: false,
    mutationRisk: "read_only",
  },
  execute(input) {
    const result = runArtifactMetadataTest(input);
    if (!result.ok) return { ok: false, error: result.error, summary: result.error.message };
    return {
      ok: true,
      output: result.output,
      summary: result.output.summary,
      artifacts: [
        {
          kind: "report",
          title: result.output.artifact.title,
          mimeType: result.output.artifact.mimeType,
          data: {
            status: result.output.status,
            summary: result.output.summary,
            label: result.output.label,
          },
        },
      ],
    };
  },
} as const satisfies RuntimeToolBinding;

const runnerEchoBinding = {
  id: runnerEchoToolName,
  description: "Echo bounded text through the signed runner boundary.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: { type: "string", maxLength: 160 },
      uppercase: { type: "boolean" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "summary", "message", "echoed", "uppercase", "length", "timingMs"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      summary: { type: "string" },
      message: { type: "string" },
      echoed: { type: "string" },
      uppercase: { type: "boolean" },
      length: { type: "integer", minimum: 0 },
      timingMs: { type: "integer", minimum: 0 },
    },
  },
  executionModes: ["dry_run"],
  transport: "fly",
  adapterVersion: runnerEchoAdapterVersion,
  timeoutMs: 5_000,
  maxArtifactBytes: 0,
  sandbox: {
    template: "runner-echo-no-egress-v1",
    maxRuntimeMs: 5_000,
    maxArtifactBytes: 0,
    network: { egress: "none", privateNetwork: "deny", dnsPinning: "required" },
  },
  policy: {
    reference: runnerEchoPolicy,
    adminVisible: true,
    modelVisible: false,
    requiresApproval: false,
    policyEditable: false,
    mutationRisk: "read_only",
  },
} as const satisfies RuntimeToolBinding;

export const platformDiagnosticTools = [
  diagnosticPingBinding,
  runnerEchoBinding,
  artifactMetadataBinding,
] as const satisfies readonly RuntimeToolBinding[];

export type ResolvedRuntimeTool = {
  binding: RuntimeToolBinding;
  packId: string;
  packVersion: string;
  runtimeVersion: string;
  connections: readonly AgentPackConnectionDescriptor[];
  platformOwned: boolean;
};

export const runtimeToolsForAgent = (agent: AgentRow): ResolvedRuntimeTool[] => {
  const pack = resolveAgentBehaviorConfig(agent).pack;
  const platform = platformDiagnosticTools.map((binding) => ({
    binding,
    packId: "platform",
    packVersion: "1.0.0",
    runtimeVersion: "1.0.0",
    connections: [],
    platformOwned: true,
  }));
  if (!pack) return platform;
  const runtime = resolvePackRuntime(pack.id, pack.version);
  if (!runtime.runnable) return platform;
  return [
    ...runtime.controlPlane.tools.map((binding) => ({
      binding,
      packId: pack.id,
      packVersion: pack.version,
      runtimeVersion: runtime.runtimeVersion,
      connections: pack.connections ?? [],
      platformOwned: false,
    })),
    ...platform,
  ];
};

export const resolveRuntimeToolForAgent = (agent: AgentRow, toolId: string) =>
  runtimeToolsForAgent(agent).find(({ binding }) => binding.id === toolId);

const scopeFromRow = (row: { user_id: string; workspace_id: string }): TenantScope => ({
  userId: row.user_id,
  workspaceId: row.workspace_id,
});

export const listLatestToolCalls = async (env: Env, scope: TenantScope, limit = 8) => {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, workflow_intent_id, run_id, tool_id, status,
            input_summary, output_summary, artifact_refs_json, data_json, started_at,
            finished_at, created_at
     FROM control_tool_calls
     WHERE user_id = ? AND workspace_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(scope.userId, scope.workspaceId, limit)
    .all<ControlToolCallRow>();
  return rows.results.map((row) => ({
    id: row.id,
    scope: scopeFromRow(row),
    agentId: row.agent_id,
    workflowIntentId: row.workflow_intent_id,
    runId: row.run_id,
    toolId: row.tool_id,
    status: row.status,
    inputSummary: row.input_summary ?? undefined,
    outputSummary: row.output_summary ?? undefined,
    artifactRefs: parseJson(row.artifact_refs_json) ?? [],
    data: parseDataJson(row.data_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    createdAt: row.created_at,
  }));
};

export const listLatestArtifacts = async (env: Env, scope: TenantScope, limit = 8) => {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, kind, uri, title, mime_type, size_bytes, data_json,
            created_at
     FROM control_artifacts
     WHERE user_id = ? AND workspace_id = ?
       AND COALESCE(json_extract(data_json, '$.publicationStatus'), 'published') <> 'staged'
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(scope.userId, scope.workspaceId, limit)
    .all<ControlArtifactRow>();
  return rows.results.map((row) => ({
    id: row.id,
    scope: scopeFromRow(row),
    kind: row.kind,
    uri: row.uri,
    title: row.title ?? undefined,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    data: parseDataJson(row.data_json),
    createdAt: row.created_at,
  }));
};

const policySummary = (policy: ToolPolicyResult) => ({
  decision: policy.decision,
  code: policy.code,
  reason: policy.reason,
  executionMode: policy.executionMode,
  policyReference: policy.policyReference,
  constraints: policy.constraints,
});

const latestApproval = (env: Env, identity: AgentIdentity, toolId: string) =>
  env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, workflow_intent_id, run_id, tool_id, status,
            reason, data_json, created_at, updated_at
     FROM control_approval_requests
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND tool_id = ?
     ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, toolId)
    .first<ControlApprovalRequestRow>();

export const resolveToolSummaries = async (
  env: Env,
  identity: AgentIdentity,
  capabilityContext: DynamicCapabilityContext = readDynamicCapabilityContext(),
) => {
  const [agent, membership, capabilityDecisions] = await Promise.all([
    selectAgent(env, identity.agentId, identity.scope.workspaceId),
    selectMembership(env, identity.scope.userId, identity.scope.workspaceId),
    resolveDynamicToolCapabilities(env, identity, capabilityContext),
  ]);
  const resolvedTools = agent ? runtimeToolsForAgent(agent) : [];
  const tools = await Promise.all(
    resolvedTools.map(async (resolved) => {
      const { binding } = resolved;
      const adminPolicy = await evaluateToolPolicy(env, identity, {
        membership,
        toolName: binding.id,
        executionMode: "dry_run",
        surface: "admin_list",
      });
      const [modelPolicy, approval] = await Promise.all([
        evaluateToolPolicy(env, identity, {
          membership,
          toolName: binding.id,
          executionMode: "dry_run",
          surface: "model_exposure",
        }),
        latestApproval(env, identity, binding.id),
      ]);
      const unavailable = binding.transport === "fly" && !isFlyRunnerConfigured(env);
      const permissionData = parseDataJson(
        (adminPolicy.permission ?? modelPolicy.permission)?.data_json ?? "{}",
      );
      const capability = capabilityDecisions.find(
        (decision) => decision.kind === "tool" && decision.capabilityId === binding.id,
      );
      return {
        name: binding.id,
        description: binding.description,
        kind: binding.transport === "fly" ? "cli" : "native",
        family: resolved.platformOwned ? "diagnostic" : resolved.packId,
        status: unavailable ? "unavailable" : "available",
        supportedExecutionModes: [...binding.executionModes],
        requiresSecrets: false,
        mutationRisk: binding.policy.mutationRisk,
        mutationEnabled:
          binding.policy.mutationRisk === "mutation_capable" &&
          permissionData.mutationEnabled === true,
        runner: runnerMetadataFor(
          {
            toolName: binding.id,
            adapterVersion: binding.adapterVersion,
            supportedExecutionModes: [...binding.executionModes],
            transport: binding.transport,
          },
          "admin",
          binding.transport,
          binding.sandbox as Parameters<typeof runnerMetadataFor>[3],
        ),
        adminVisible: adminPolicy.decision === "allow" && adminPolicy.adminVisible,
        modelVisible: !unavailable && modelPolicy.decision === "allow" && modelPolicy.modelVisible,
        reason: unavailable
          ? `${binding.id} requires the configured signed Fly runner.`
          : adminPolicy.decision === "allow"
            ? `${adminPolicy.reason} ${modelPolicy.reason}`
            : adminPolicy.reason,
        permissionStatus: (adminPolicy.permission ?? modelPolicy.permission)?.status,
        policyReference: adminPolicy.policyReference,
        allowedExecutionModes: adminPolicy.allowedExecutionModes,
        approvalRequired: adminPolicy.approvalRequired,
        killSwitchReason:
          typeof permissionData.killSwitchReason === "string"
            ? permissionData.killSwitchReason
            : undefined,
        policyEditable: adminPolicy.policyEditable,
        policyConstraints: adminPolicy.constraints,
        connectionAuth: connectionAuthForPackTool(binding.id, resolved.connections),
        adminPolicy: policySummary(adminPolicy),
        modelExposurePolicy: policySummary(modelPolicy),
        capability,
        packScope: resolved.platformOwned
          ? undefined
          : {
              activePackId: resolved.packId,
              declared: true,
              executionModes: [...binding.executionModes],
            },
        latestApprovalRequest: approval
          ? {
              id: approval.id,
              scope: scopeFromRow(approval),
              agentId: approval.agent_id,
              workflowIntentId: approval.workflow_intent_id,
              runId: approval.run_id,
              toolId: approval.tool_id,
              status: approval.status,
              reason: approval.reason,
              data: parseDataJson(approval.data_json),
              createdAt: approval.created_at,
              updatedAt: approval.updated_at,
            }
          : undefined,
      };
    }),
  );
  return { context: capabilityContext, decisions: capabilityDecisions, tools };
};

export { runnerEchoPolicy, runnerEchoToolName };
