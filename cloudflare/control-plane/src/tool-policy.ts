import { appendControlPlaneEvent } from "./control-plane-events";
import { isAdminMembership } from "./membership-policy";
import { isRecord, parseDataJson } from "./http";
import {
  createId,
  toJson,
  type AgentIdentity,
  type Env,
  type ExecutionMode,
  type MembershipRow,
  type ToolPermissionRow,
  type ToolPermissionStatus,
} from "./types";
import { agentControlPlaneRegistry } from "../../../generated/agent-runtime/control-plane";
import type { RuntimeToolBinding } from "@operloom/agent-sdk/control-plane";
import { platformDiagnosticPolicyDefaults } from "../../../lib/workbench/admin-test-tools";

export {
  artifactMetadataTestPolicy,
  artifactMetadataTestToolName,
  diagnosticPingPolicy,
  diagnosticPingToolName,
  runnerEchoPolicy,
  runnerEchoToolName,
} from "../../../lib/workbench/admin-test-tools";

export type ToolPolicySurface =
  | "admin_list"
  | "admin_run"
  | "admin_resume"
  | "workflow"
  | "model_exposure"
  | "model_tool_call";

export type ToolPolicyResult = {
  decision: "allow" | "block";
  status: 200 | 403;
  code:
    | "allowed"
    | "unsupported_tool"
    | "inactive_membership"
    | "admin_required"
    | "tool_disabled"
    | "approval_required"
    | "unsupported_execution_mode"
    | "model_exposure_blocked"
    | "tool_policy_not_editable"
    | "resource_denied"
    | "resource_not_allowed"
    | "cooldown_active"
    | "rate_limit_exceeded"
    | "runtime_limit_exceeded"
    | "artifact_limit_exceeded";
  reason: string;
  executionMode: ExecutionMode;
  policyReference?: string;
  permission?: ToolPermissionRow;
  adminVisible: boolean;
  modelVisible: boolean;
  approvalRequired: boolean;
  killSwitchReason?: string;
  allowedExecutionModes: ExecutionMode[];
  policyEditable: boolean;
  constraints: ToolPolicyConstraints;
};

export type ToolPolicyLimits = {
  perUserPerHour?: number;
  perWorkspacePerHour?: number;
};

export type ToolPolicyConstraints = {
  limits: ToolPolicyLimits;
  cooldownSeconds?: number;
  allowlist: string[];
  denylist: string[];
  maxRuntimeMs?: number;
  maxArtifactBytes?: number;
};

export type ToolPolicyResource = {
  kind: "url" | "generic";
  value?: string;
  host?: string;
};

type ToolPolicyCatalogEntry = {
  policyReference: string;
  allowedExecutionModes: ExecutionMode[];
  adminVisible: boolean;
  modelVisible: boolean;
  requiresApproval: boolean;
  status: ToolPermissionStatus;
  policyEditable: boolean;
  mutationRisk: "read_only" | "mutation_capable";
  constraints: ToolPolicyConstraints;
};

const executionModes = new Set<ExecutionMode>(["ask", "dry_run", "execute"]);

const emptyConstraints = (): ToolPolicyConstraints => ({
  limits: {},
  allowlist: [],
  denylist: [],
});

const compiledToolPolicyCatalog = () => {
  const result: Record<string, ToolPolicyCatalogEntry> = {};
  const tools: RuntimeToolBinding[] = [];
  for (const entry of Object.values(agentControlPlaneRegistry)) {
    tools.push(...entry.module.tools);
  }
  for (const tool of tools) {
    result[tool.id] ??= {
      policyReference: tool.policy.reference,
      allowedExecutionModes: [...tool.executionModes],
      adminVisible: tool.policy.adminVisible,
      modelVisible: tool.policy.modelVisible,
      requiresApproval: tool.policy.requiresApproval,
      status: "enabled",
      policyEditable: tool.policy.policyEditable,
      mutationRisk: tool.policy.mutationRisk,
      constraints: {
        ...emptyConstraints(),
        maxRuntimeMs: tool.timeoutMs,
        maxArtifactBytes: tool.maxArtifactBytes,
      },
    };
  }
  for (const tool of platformDiagnosticPolicyDefaults) {
    result[tool.id] = {
      policyReference: tool.policyReference,
      allowedExecutionModes: ["dry_run"],
      adminVisible: true,
      modelVisible: false,
      requiresApproval: false,
      status: "enabled",
      policyEditable: false,
      mutationRisk: "read_only",
      constraints: {
        ...emptyConstraints(),
        maxRuntimeMs: tool.timeoutMs,
        maxArtifactBytes: tool.maxArtifactBytes,
      },
    };
  }
  return result;
};

const compiledAgentToolPolicyCatalog = compiledToolPolicyCatalog();
export const compiledAgentToolNames = new Set(Object.keys(compiledAgentToolPolicyCatalog));

export const toolPolicyCatalog: Record<string, ToolPolicyCatalogEntry> = {
  ...compiledAgentToolPolicyCatalog,
};

const readDataFlag = (data: Record<string, unknown>, name: string, fallback: boolean) =>
  typeof data[name] === "boolean" ? data[name] : fallback;

const readNumber = (value: unknown, fallback?: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

const readStringList = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().toLowerCase())
    : [];

const readAllowedExecutionModes = (value: unknown, fallback: ExecutionMode[]) => {
  if (!Array.isArray(value)) return fallback;
  const modes = value.filter(
    (item): item is ExecutionMode =>
      typeof item === "string" && executionModes.has(item as ExecutionMode),
  );
  return modes.length > 0 ? Array.from(new Set(modes)) : fallback;
};

const readLimits = (value: unknown, fallback: ToolPolicyLimits): ToolPolicyLimits => {
  const source = isRecord(value) ? value : {};
  return {
    perUserPerHour: readNumber(source.perUserPerHour, fallback.perUserPerHour),
    perWorkspacePerHour: readNumber(source.perWorkspacePerHour, fallback.perWorkspacePerHour),
  };
};

const readConstraints = (
  execution: Record<string, unknown>,
  data: Record<string, unknown>,
  defaults: ToolPolicyCatalogEntry,
): ToolPolicyConstraints => ({
  limits: readLimits(execution.limits, defaults.constraints.limits),
  cooldownSeconds: readNumber(execution.cooldownSeconds, defaults.constraints.cooldownSeconds),
  allowlist: readStringList(data.allowlist).length
    ? readStringList(data.allowlist)
    : defaults.constraints.allowlist,
  denylist: readStringList(data.denylist).length
    ? readStringList(data.denylist)
    : defaults.constraints.denylist,
  maxRuntimeMs: readNumber(execution.maxRuntimeMs, defaults.constraints.maxRuntimeMs),
  maxArtifactBytes: readNumber(execution.maxArtifactBytes, defaults.constraints.maxArtifactBytes),
});

const readExecutionMode = (raw: string): ExecutionMode =>
  executionModes.has(raw as ExecutionMode) ? (raw as ExecutionMode) : "ask";

const matchesPolicyPattern = (value: string, pattern: string) => {
  const normalizedValue = value.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  if (normalizedValue === normalizedPattern) return true;
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return normalizedValue.endsWith(suffix);
  }
  if (normalizedPattern.startsWith(".")) return normalizedValue.endsWith(normalizedPattern);
  return false;
};

const countAllowedPolicyDecisions = async (
  env: Env,
  identity: AgentIdentity,
  input: { toolName: string; since: string; scope: "user" | "workspace" },
) => {
  const query =
    input.scope === "user"
      ? `SELECT COUNT(*) AS count
         FROM control_policy_decisions
         WHERE user_id = ? AND workspace_id = ? AND tool_id = ?
           AND decision = 'allow' AND created_at >= ?`
      : `SELECT COUNT(*) AS count
         FROM control_policy_decisions
         WHERE workspace_id = ? AND tool_id = ? AND decision = 'allow' AND created_at >= ?`;
  const row =
    input.scope === "user"
      ? await env.DB.prepare(query)
          .bind(identity.scope.userId, identity.scope.workspaceId, input.toolName, input.since)
          .first<{ count?: number }>()
      : await env.DB.prepare(query)
          .bind(identity.scope.workspaceId, input.toolName, input.since)
          .first<{ count?: number }>();
  return typeof row?.count === "number" ? row.count : 0;
};

const latestAllowedPolicyDecision = async (env: Env, identity: AgentIdentity, toolName: string) =>
  env.DB.prepare(
    `SELECT created_at
     FROM control_policy_decisions
     WHERE user_id = ? AND workspace_id = ? AND tool_id = ? AND decision = 'allow'
     ORDER BY created_at DESC
     LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, toolName)
    .first<{ created_at?: string }>();

const evaluateResourceAndLimitPolicy = async (
  env: Env,
  identity: AgentIdentity,
  toolName: string,
  input: {
    constraints: ToolPolicyConstraints;
    resource?: ToolPolicyResource;
    requestedRuntimeMs?: number;
    requestedArtifactBytes?: number;
  },
): Promise<null | { code: ToolPolicyResult["code"]; reason: string }> => {
  const resourceValue = input.resource?.host ?? input.resource?.value;
  if (resourceValue) {
    if (
      input.constraints.denylist.some((pattern) => matchesPolicyPattern(resourceValue, pattern))
    ) {
      return { code: "resource_denied", reason: `${resourceValue} is denied by tool policy.` };
    }
    if (
      input.constraints.allowlist.length > 0 &&
      !input.constraints.allowlist.some((pattern) => matchesPolicyPattern(resourceValue, pattern))
    ) {
      return {
        code: "resource_not_allowed",
        reason: `${resourceValue} is not in the tool policy allowlist.`,
      };
    }
  }

  if (
    input.constraints.maxRuntimeMs !== undefined &&
    input.requestedRuntimeMs !== undefined &&
    input.requestedRuntimeMs > input.constraints.maxRuntimeMs
  ) {
    return {
      code: "runtime_limit_exceeded",
      reason: `Requested runtime exceeds the ${input.constraints.maxRuntimeMs}ms policy limit.`,
    };
  }

  if (
    input.constraints.maxArtifactBytes !== undefined &&
    input.requestedArtifactBytes !== undefined &&
    input.requestedArtifactBytes > input.constraints.maxArtifactBytes
  ) {
    return {
      code: "artifact_limit_exceeded",
      reason: `Requested artifact size exceeds the ${input.constraints.maxArtifactBytes} byte policy limit.`,
    };
  }

  if (input.constraints.cooldownSeconds && input.constraints.cooldownSeconds > 0) {
    const latest = await latestAllowedPolicyDecision(env, identity, toolName);
    const latestMs = latest?.created_at ? Date.parse(latest.created_at) : Number.NaN;
    if (Number.isFinite(latestMs)) {
      const availableAtMs = latestMs + input.constraints.cooldownSeconds * 1000;
      if (Date.now() < availableAtMs) {
        return {
          code: "cooldown_active",
          reason: `Tool policy cooldown is active until ${new Date(availableAtMs).toISOString()}.`,
        };
      }
    }
  }

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  if (input.constraints.limits.perUserPerHour !== undefined) {
    const count = await countAllowedPolicyDecisions(env, identity, {
      toolName,
      since,
      scope: "user",
    });
    if (count >= input.constraints.limits.perUserPerHour) {
      return {
        code: "rate_limit_exceeded",
        reason: `Per-user hourly policy limit of ${input.constraints.limits.perUserPerHour} was reached.`,
      };
    }
  }
  if (input.constraints.limits.perWorkspacePerHour !== undefined) {
    const count = await countAllowedPolicyDecisions(env, identity, {
      toolName,
      since,
      scope: "workspace",
    });
    if (count >= input.constraints.limits.perWorkspacePerHour) {
      return {
        code: "rate_limit_exceeded",
        reason: `Per-workspace hourly policy limit of ${input.constraints.limits.perWorkspacePerHour} was reached.`,
      };
    }
  }

  return null;
};

export const isKnownTool = (toolName: string) => Boolean(toolPolicyCatalog[toolName]);

export const isPolicyEditableTool = (toolName: string) =>
  Boolean(toolPolicyCatalog[toolName]?.policyEditable);

const defaultExecution = (defaults: ToolPolicyCatalogEntry) => ({
  mode: defaults.allowedExecutionModes[0],
  policy: defaults.policyReference,
  allowedExecutionModes: defaults.allowedExecutionModes,
  limits: defaults.constraints.limits,
  cooldownSeconds: defaults.constraints.cooldownSeconds,
  maxRuntimeMs: defaults.constraints.maxRuntimeMs,
  maxArtifactBytes: defaults.constraints.maxArtifactBytes,
});

const defaultData = (defaults: ToolPolicyCatalogEntry) => ({
  adminVisible: defaults.adminVisible,
  modelVisible: defaults.modelVisible,
  requiresApproval: defaults.requiresApproval,
  mutationEnabled: false,
  allowlist: defaults.constraints.allowlist,
  denylist: defaults.constraints.denylist,
});

export const ensureToolPermission = async (env: Env, identity: AgentIdentity, toolName: string) => {
  const defaults = toolPolicyCatalog[toolName];
  if (!defaults) return null;

  const timestamp = new Date().toISOString();
  const existing = await env.DB.prepare(
    `SELECT id, user_id, workspace_id, agent_id, tool_id, status, execution_json, data_json,
            created_at, updated_at
     FROM tool_permissions
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND tool_id = ?
     LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, toolName)
    .first<ToolPermissionRow>();
  if (existing) return existing;

  const permission: ToolPermissionRow = {
    id: createId("cf-tool-permission"),
    user_id: identity.scope.userId,
    workspace_id: identity.scope.workspaceId,
    agent_id: identity.agentId,
    tool_id: toolName,
    status: defaults.status,
    execution_json: toJson(defaultExecution(defaults)),
    data_json: toJson(defaultData(defaults)),
    created_at: timestamp,
    updated_at: timestamp,
  };

  await env.DB.prepare(
    `INSERT INTO tool_permissions (
       id, user_id, workspace_id, agent_id, tool_id, status, execution_json, data_json,
       created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, workspace_id, agent_id, tool_id) DO NOTHING`,
  )
    .bind(
      permission.id,
      permission.user_id,
      permission.workspace_id,
      permission.agent_id,
      permission.tool_id,
      permission.status,
      permission.execution_json,
      permission.data_json,
      permission.created_at,
      permission.updated_at,
    )
    .run();

  return permission;
};

export const updateToolPermissionStatus = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    toolName: string;
    status?: ToolPermissionStatus;
    requiresApproval?: boolean;
    mutationEnabled?: boolean;
    killSwitchReason?: string | null;
    modelVisible?: boolean;
    approvalReason?: string;
    allowedExecutionModes?: ExecutionMode[];
    limits?: ToolPolicyLimits;
    cooldownSeconds?: number | null;
    allowlist?: string[];
    denylist?: string[];
    maxRuntimeMs?: number | null;
    maxArtifactBytes?: number | null;
  },
) => {
  const permission = await ensureToolPermission(env, identity, input.toolName);
  if (!permission) return null;

  const timestamp = new Date().toISOString();
  const data = parseDataJson(permission.data_json);
  const execution = parseDataJson(permission.execution_json);
  const defaults = toolPolicyCatalog[input.toolName];
  const nextStatus = input.status ?? permission.status;
  const nextExecution: Record<string, unknown> = {
    ...execution,
    policy:
      typeof execution.policy === "string" && execution.policy
        ? execution.policy
        : defaults.policyReference,
    mode:
      typeof execution.mode === "string" && executionModes.has(execution.mode as ExecutionMode)
        ? execution.mode
        : defaults.allowedExecutionModes[0],
    allowedExecutionModes:
      input.allowedExecutionModes ??
      readAllowedExecutionModes(execution.allowedExecutionModes, defaults.allowedExecutionModes),
    limits: input.limits ?? readLimits(execution.limits, defaults.constraints.limits),
  };
  const cooldownSeconds =
    input.cooldownSeconds === null
      ? undefined
      : (input.cooldownSeconds ?? readNumber(execution.cooldownSeconds));
  const maxRuntimeMs =
    input.maxRuntimeMs === null
      ? undefined
      : (input.maxRuntimeMs ?? readNumber(execution.maxRuntimeMs));
  const maxArtifactBytes =
    input.maxArtifactBytes === null
      ? undefined
      : (input.maxArtifactBytes ?? readNumber(execution.maxArtifactBytes));
  if (cooldownSeconds === undefined) delete nextExecution.cooldownSeconds;
  else nextExecution.cooldownSeconds = cooldownSeconds;
  if (maxRuntimeMs === undefined) delete nextExecution.maxRuntimeMs;
  else nextExecution.maxRuntimeMs = maxRuntimeMs;
  if (maxArtifactBytes === undefined) delete nextExecution.maxArtifactBytes;
  else nextExecution.maxArtifactBytes = maxArtifactBytes;

  const nextData: Record<string, unknown> = {
    ...data,
    adminVisible: readDataFlag(data, "adminVisible", defaults.adminVisible),
    modelVisible:
      typeof input.modelVisible === "boolean"
        ? input.modelVisible
        : readDataFlag(data, "modelVisible", defaults.modelVisible),
    requiresApproval:
      typeof input.requiresApproval === "boolean"
        ? input.requiresApproval
        : readDataFlag(data, "requiresApproval", defaults.requiresApproval),
    mutationEnabled:
      defaults.mutationRisk === "mutation_capable"
        ? typeof input.mutationEnabled === "boolean"
          ? input.mutationEnabled
          : readDataFlag(data, "mutationEnabled", false)
        : false,
    allowlist: input.allowlist ?? readStringList(data.allowlist),
    denylist: input.denylist ?? readStringList(data.denylist),
  };
  if (input.approvalReason !== undefined) nextData.approvalReason = input.approvalReason;
  if (nextStatus === "disabled") {
    nextData.killSwitchReason =
      input.killSwitchReason?.trim() ||
      (isRecord(data) && typeof data.killSwitchReason === "string"
        ? data.killSwitchReason
        : "Disabled by workspace admin policy.");
  } else {
    delete nextData.killSwitchReason;
  }

  await env.DB.prepare(
    `UPDATE tool_permissions
     SET status = ?, execution_json = ?, data_json = ?, updated_at = ?
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND tool_id = ?`,
  )
    .bind(
      nextStatus,
      toJson(nextExecution),
      toJson(nextData),
      timestamp,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      input.toolName,
    )
    .run();

  return ensureToolPermission(env, identity, input.toolName);
};

export const evaluateToolPolicy = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    membership: MembershipRow | null;
    toolName: string;
    executionMode: string;
    surface: ToolPolicySurface;
    resource?: ToolPolicyResource;
    requestedRuntimeMs?: number;
    requestedArtifactBytes?: number;
  },
): Promise<ToolPolicyResult> => {
  const defaults = toolPolicyCatalog[input.toolName];
  const executionMode = readExecutionMode(input.executionMode);
  if (!defaults) {
    return {
      decision: "block",
      status: 403,
      code: "unsupported_tool",
      reason: "Tool is not registered in the policy catalog.",
      executionMode,
      adminVisible: false,
      modelVisible: false,
      approvalRequired: false,
      allowedExecutionModes: [],
      policyEditable: false,
      constraints: emptyConstraints(),
    };
  }

  const permission = await ensureToolPermission(env, identity, input.toolName);
  const data = parseDataJson(permission?.data_json ?? "{}");
  const adminVisibleFlag = readDataFlag(data, "adminVisible", defaults.adminVisible);
  const modelVisibleFlag = defaults.policyEditable
    ? readDataFlag(data, "modelVisible", defaults.modelVisible)
    : defaults.modelVisible;
  const approvalRequired = readDataFlag(data, "requiresApproval", defaults.requiresApproval);
  const killSwitchReason =
    typeof data.killSwitchReason === "string" ? data.killSwitchReason : undefined;
  const approvalReason = typeof data.approvalReason === "string" ? data.approvalReason : undefined;
  const execution = parseDataJson(permission?.execution_json ?? "{}");
  const policyReference =
    isRecord(execution) && typeof execution.policy === "string"
      ? String(execution.policy)
      : defaults.policyReference;
  const allowedExecutionModes = readAllowedExecutionModes(
    execution.allowedExecutionModes,
    defaults.allowedExecutionModes,
  );
  const constraints = readConstraints(execution, data, defaults);

  const base = {
    executionMode,
    policyReference,
    permission: permission ?? undefined,
    adminVisible: false,
    modelVisible: false,
    approvalRequired,
    killSwitchReason,
    allowedExecutionModes,
    policyEditable: defaults.policyEditable,
    constraints,
  };

  if (!input.membership || input.membership.status !== "active") {
    return {
      ...base,
      decision: "block",
      status: 403,
      code: "inactive_membership",
      reason: "Workspace membership is not active.",
    };
  }

  if (permission?.status === "disabled") {
    return {
      ...base,
      decision: "block",
      status: 403,
      code: "tool_disabled",
      reason: killSwitchReason ?? "Tool is disabled by workspace policy.",
    };
  }

  if (permission?.status === "pending_review") {
    return {
      ...base,
      decision: "block",
      status: 403,
      code: "approval_required",
      reason: "Tool permission is pending review.",
    };
  }

  if (!allowedExecutionModes.includes(executionMode)) {
    return {
      ...base,
      decision: "block",
      status: 403,
      code: "unsupported_execution_mode",
      reason: `${input.toolName} only supports ${allowedExecutionModes.join(", ")}.`,
    };
  }

  if (input.surface === "model_exposure" || input.surface === "model_tool_call") {
    if (approvalRequired) {
      return {
        ...base,
        decision: "block",
        status: 403,
        code: "approval_required",
        reason: "Tool is hidden from model exposure while approval is required.",
        modelVisible: false,
      };
    }
    if (modelVisibleFlag) {
      return {
        ...base,
        decision: "allow",
        status: 200,
        code: "allowed",
        reason:
          input.surface === "model_tool_call"
            ? `${input.toolName} is enabled for model dry-run execution.`
            : `${input.toolName} is exposed to the model by workspace policy.`,
        adminVisible: adminVisibleFlag,
        modelVisible: true,
      };
    }
    return {
      ...base,
      decision: "block",
      status: 403,
      code: "model_exposure_blocked",
      reason: "Tool is hidden from model exposure by workspace policy.",
      modelVisible: false,
    };
  }

  if (input.surface === "workflow") {
    if (approvalRequired) {
      return {
        ...base,
        decision: "block",
        status: 403,
        code: "approval_required",
        reason: approvalReason ?? "Tool requires approval before workflow execution.",
        adminVisible: adminVisibleFlag,
        modelVisible: modelVisibleFlag,
      };
    }
    const resourceBlock = await evaluateResourceAndLimitPolicy(env, identity, input.toolName, {
      constraints,
      resource: input.resource,
      requestedRuntimeMs: input.requestedRuntimeMs,
      requestedArtifactBytes: input.requestedArtifactBytes,
    });
    if (resourceBlock) {
      return {
        ...base,
        decision: "block",
        status: 403,
        ...resourceBlock,
        adminVisible: adminVisibleFlag,
        modelVisible: modelVisibleFlag,
      };
    }
    return {
      ...base,
      decision: "allow",
      status: 200,
      code: "allowed",
      reason: `${input.toolName} is enabled for workflow dry-run execution.`,
      adminVisible: adminVisibleFlag,
      modelVisible: modelVisibleFlag,
    };
  }

  if (!isAdminMembership(input.membership)) {
    return {
      ...base,
      decision: "block",
      status: 403,
      code: "admin_required",
      reason: "Workspace owner/admin membership is required to use this Admin tool.",
    };
  }

  if (input.surface === "admin_list" && !adminVisibleFlag) {
    return {
      ...base,
      decision: "block",
      status: 403,
      code: "admin_required",
      reason: "Tool is not exposed in Admin for this workspace.",
    };
  }

  if (approvalRequired && input.surface !== "admin_resume") {
    return {
      ...base,
      decision: "block",
      status: 403,
      code: "approval_required",
      reason:
        approvalReason ??
        "Tool requires approval before execution; this slice records the interrupted request.",
      adminVisible: adminVisibleFlag,
      modelVisible: modelVisibleFlag,
    };
  }

  const resourceBlock = await evaluateResourceAndLimitPolicy(env, identity, input.toolName, {
    constraints,
    resource: input.resource,
    requestedRuntimeMs: input.requestedRuntimeMs,
    requestedArtifactBytes: input.requestedArtifactBytes,
  });
  if (resourceBlock) {
    return {
      ...base,
      decision: "block",
      status: 403,
      ...resourceBlock,
      adminVisible: adminVisibleFlag,
      modelVisible: modelVisibleFlag,
    };
  }

  return {
    ...base,
    decision: "allow",
    status: 200,
    code: "allowed",
    reason:
      input.surface === "admin_run" || input.surface === "admin_resume"
        ? `${input.toolName} is enabled for Admin dry-run execution.`
        : `${input.toolName} is enabled by workspace policy.`,
    adminVisible: adminVisibleFlag,
    modelVisible: modelVisibleFlag,
  };
};

export const recordToolPolicyDecision = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    toolName: string;
    surface: ToolPolicySurface;
    result: ToolPolicyResult;
    data?: Record<string, unknown>;
  },
) => {
  const timestamp = new Date().toISOString();
  const decisionId = createId("cf-policy");
  await env.DB.prepare(
    `INSERT INTO control_policy_decisions (
       id, user_id, workspace_id, agent_id, tool_id, surface, decision, reason,
       execution_mode, policy_reference, data_json, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      decisionId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      input.toolName,
      input.surface,
      input.result.decision,
      input.result.reason,
      input.result.executionMode,
      input.result.policyReference ?? null,
      toJson({
        code: input.result.code,
        permissionId: input.result.permission?.id,
        status: input.result.permission?.status,
        authMode: identity.authMode,
        allowedExecutionModes: input.result.allowedExecutionModes,
        constraints: input.result.constraints,
        ...input.data,
      }),
      timestamp,
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO control_audit_events (
       id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      createId("cf-audit"),
      identity.scope.userId,
      identity.scope.workspaceId,
      input.result.decision === "allow" ? "tool.policy.allowed" : "tool.policy.blocked",
      input.result.reason,
      "toolPolicyDecision",
      decisionId,
      toJson({
        eventName:
          input.result.decision === "allow" ? "tool.policy.allowed" : "tool.policy.blocked",
        agentId: identity.agentId,
        toolName: input.toolName,
        surface: input.surface,
        code: input.result.code,
        policyReference: input.result.policyReference,
        authMode: identity.authMode,
      }),
      timestamp,
    )
    .run();

  await appendControlPlaneEvent(env, identity, {
    type: input.result.decision === "allow" ? "tool.policy.allowed" : "tool.policy.blocked",
    summary: input.result.reason,
    targetType: "toolPolicyDecision",
    targetId: decisionId,
    data: {
      toolName: input.toolName,
      surface: input.surface,
      code: input.result.code,
      decision: input.result.decision,
      policyReference: input.result.policyReference,
      authMode: identity.authMode,
    },
  });

  return decisionId;
};

export const toolPolicyError = (result: ToolPolicyResult) => ({
  code: result.code,
  message: result.reason,
  retryable: false,
  redacted: true as const,
});
