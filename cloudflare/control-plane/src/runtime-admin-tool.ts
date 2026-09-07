import { assertSchemaValue } from "@operloom/agent-sdk/control-plane";

import { selectAgent, selectMembership } from "./authz-store";
import { isRecord, json } from "./http";
import { executeResolvedRuntimeAdminTool } from "./runtime-admin-execution";
import { resolveRuntimeToolForAgent } from "./runtime-tool-catalog";
import { startPackWorkflowRun } from "./runtime-run-lifecycle";
import { createRuntimeToolApproval } from "./tool-approvals";
import { evaluateToolPolicy, recordToolPolicyDecision, toolPolicyError } from "./tool-policy";
import type { AgentIdentity, Env } from "./types";

export const handleRuntimeAdminTool = async (
  request: Request,
  body: unknown,
  env: Env,
  identity: AgentIdentity,
): Promise<Response | null> => {
  const toolName = isRecord(body) && typeof body.toolName === "string" ? body.toolName : "";
  const agent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  if (!agent) return null;
  const resolved = resolveRuntimeToolForAgent(agent, toolName);
  if (!resolved) return null;
  const { binding, packId, packVersion, runtimeVersion } = resolved;
  const toolInput = isRecord(body) && isRecord(body.input) ? body.input : {};
  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  const policy = await evaluateToolPolicy(env, identity, {
    membership,
    toolName,
    executionMode: "dry_run",
    surface: "admin_run",
  });
  const policyDecisionId = await recordToolPolicyDecision(env, identity, {
    toolName,
    surface: "admin_run",
    result: policy,
    data: { action: "runtime.tool.run", packId, runtimeVersion },
  });
  if (policy.decision === "block" && policy.code === "approval_required") {
    try {
      assertSchemaValue(binding.inputSchema, toolInput, `${binding.id} input`);
    } catch (cause) {
      return json(
        {
          ok: false,
          error: cause instanceof Error ? cause.message : "Invalid tool input",
          details: { code: "invalid_input", retryable: false, redacted: true },
        },
        { status: 400 },
      );
    }
    return createRuntimeToolApproval({
      env,
      identity,
      toolName,
      toolInput,
      policyDecisionId,
      policyReference: binding.policy.reference,
      reason: policy.reason,
      packId,
      packVersion,
      runtimeVersion,
      bindingVersion: 1,
      transport: binding.transport,
    });
  }
  if (policy.decision === "block") {
    return json(
      { ok: false, error: policy.reason, details: toolPolicyError(policy), policyDecisionId },
      { status: policy.status },
    );
  }

  const started = await startPackWorkflowRun(env, identity, {
    workflowType: `tool.${binding.id}`,
    policyReference: binding.policy.reference,
    displayName: binding.description,
    packId,
    toolInput,
    executionMode: "dry_run",
    engine: "cloudflare",
    source: "admin",
    runtimeMetadata: {
      packVersion,
      runtimeVersion,
      bindingVersion: 1,
      transports: [binding.transport],
      policyDecisionId,
    },
  });
  return executeResolvedRuntimeAdminTool({
    requestUrl: request.url,
    env,
    identity,
    resolved,
    toolInput,
    policyDecisionId,
    started,
  });
};
