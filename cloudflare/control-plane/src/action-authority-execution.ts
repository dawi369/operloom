import {
  assertSchemaValue,
  type ActionExecutionResult,
  type ActionPort,
  type ActionProposal,
  type RuntimeToolBinding,
} from "@operloom/agent-sdk/control-plane";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { parseJson } from "./http";
import { prepareOperatorAlertStatement } from "./operator-alerts";
import { createId, toJson, type AgentIdentity, type Env } from "./types";
import {
  actionEvidenceStatements,
  appendLedgerStatement,
  dispatchAction,
  evaluateActionPolicy,
  executionContext,
  manifestConnections,
  mutationPreflight,
  resolveBinding,
  selectProposal,
  sha256Hex,
  terminalStatuses,
} from "./action-authority-core";
import type { RuntimeIdentity } from "./action-authority-core";

export const createDurableActionPort = (
  env: Env,
  identity: AgentIdentity,
  runtimeIdentity: RuntimeIdentity,
): ActionPort => ({
  async propose(proposal) {
    if (
      proposal.summary.trim().length === 0 ||
      proposal.summary.length > 240 ||
      proposal.idempotencyKey.length > 200
    ) {
      throw Object.assign(new Error("Action proposal is invalid."), {
        code: "action_proposal_invalid",
      });
    }
    const runtime = resolvePackRuntime(runtimeIdentity.packId, runtimeIdentity.packVersion);
    if (!runtime.runnable) {
      throw Object.assign(new Error("Action runtime is incompatible."), {
        code: runtime.reason,
      });
    }
    if (runtime.runtimeVersion !== runtimeIdentity.runtimeVersion) {
      throw Object.assign(new Error("Action runtime is incompatible."), {
        code: "runtime_incompatible",
      });
    }
    const binding = runtime.controlPlane.tools.find((tool) => tool.id === proposal.toolId) as
      | RuntimeToolBinding
      | undefined;
    if (!binding?.action)
      throw Object.assign(new Error("Action binding is unavailable."), {
        code: "action_binding_unavailable",
      });
    assertSchemaValue(
      binding.action.proposalSchema,
      proposal.preview,
      `${proposal.toolId} action proposal`,
    );
    const descriptor = binding.action.connectionId
      ? manifestConnections(runtimeIdentity.packId).find(
          (candidate) => candidate.id === binding.action?.connectionId,
        )
      : undefined;
    const connection = descriptor
      ? await env.DB.prepare(
          `SELECT id FROM control_connections
           WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND pack_id = ?
             AND connection_id = ? AND status = 'authorized' LIMIT 1`,
        )
          .bind(
            identity.scope.userId,
            identity.scope.workspaceId,
            identity.agentId,
            runtimeIdentity.packId,
            descriptor.id,
          )
          .first<{ id: string }>()
      : null;
    const id = createId("cf-action");
    const timestamp = new Date().toISOString();
    const inputSha256 = await sha256Hex(proposal.preview);
    const result = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO control_action_proposals (
           id, user_id, workspace_id, agent_id, workflow_intent_id, run_id, tool_call_id,
           pack_id, pack_version, runtime_version, binding_version, tool_id, action_type,
           connection_record_id, status, summary, idempotency_key, input_sha256, proposal_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, workspace_id, tool_id, idempotency_key) DO NOTHING`,
      ).bind(
        id,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        runtimeIdentity.workflowIntentId,
        runtimeIdentity.runId,
        runtimeIdentity.toolCallId ?? null,
        runtimeIdentity.packId,
        runtimeIdentity.packVersion,
        runtimeIdentity.runtimeVersion,
        runtimeIdentity.bindingVersion,
        proposal.toolId,
        proposal.type,
        connection?.id ?? null,
        proposal.summary,
        proposal.idempotencyKey,
        inputSha256,
        toJson(proposal),
        timestamp,
        timestamp,
      ),
      appendLedgerStatement(env, identity, {
        proposalId: id,
        status: "proposed",
        summary: proposal.summary,
        requestSha256: inputSha256,
        requiredStatus: "proposed",
        requiredUpdatedAt: timestamp,
        timestamp,
      }),
      ...actionEvidenceStatements(env, identity, {
        proposalId: id,
        action: "action.proposed",
        eventType: "action.proposed",
        summary: proposal.summary,
        status: "proposed",
        timestamp,
        data: { toolId: proposal.toolId, actionType: proposal.type },
      }),
    ]);
    if ((result[0]?.meta?.changes ?? 0) === 0) {
      const existing = await env.DB.prepare(
        `SELECT id, status FROM control_action_proposals
         WHERE user_id = ? AND workspace_id = ? AND tool_id = ? AND idempotency_key = ? LIMIT 1`,
      )
        .bind(
          identity.scope.userId,
          identity.scope.workspaceId,
          proposal.toolId,
          proposal.idempotencyKey,
        )
        .first<{ id: string; status: string }>();
      if (!existing) throw new Error("action_proposal_conflict");
      return { proposalId: existing.id, status: "proposed" };
    }
    return { proposalId: id, status: "proposed" };
  },
  async execute(proposalId) {
    return executeActionProposal(env, identity, proposalId);
  },
  async reconcile(proposalId) {
    return reconcileActionProposal(env, identity, proposalId);
  },
});

export const executeActionProposal = async (
  env: Env,
  identity: AgentIdentity,
  proposalId: string,
): Promise<ActionExecutionResult> => {
  const row = await selectProposal(env, identity, proposalId);
  if (!row)
    throw Object.assign(new Error("Action proposal not found."), { code: "action_not_found" });
  if (row.status !== "approved")
    throw Object.assign(new Error("Action proposal is not approved."), {
      code: terminalStatuses.has(row.status) ? "action_terminal" : "action_approval_required",
    });
  await mutationPreflight(env, identity, row);
  const policy = await evaluateActionPolicy(env, identity, row, "admin_resume");
  if (policy.result.decision === "block") {
    throw Object.assign(new Error(policy.result.reason), { code: policy.result.code });
  }
  const { binding } = resolveBinding(row);
  const proposal = parseJson(row.proposal_json) as ActionProposal;
  assertSchemaValue(
    binding.action!.proposalSchema,
    proposal.preview,
    `${row.tool_id} action proposal`,
  );
  const timestamp = new Date().toISOString();
  const claimed = await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_action_proposals SET status = 'executing', version = version + 1, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'approved' AND version = ?`,
    ).bind(timestamp, row.id, identity.scope.userId, identity.scope.workspaceId, row.version),
    appendLedgerStatement(env, identity, {
      proposalId: row.id,
      status: "executing",
      requiredStatus: "executing",
      requiredUpdatedAt: timestamp,
      summary: "Action execution started.",
      requestSha256: row.input_sha256,
      timestamp,
    }),
  ]);
  if ((claimed[0]?.meta?.changes ?? 0) === 0)
    throw Object.assign(new Error("Action proposal is already being handled."), {
      code: "action_conflict",
    });

  let result: ActionExecutionResult;
  try {
    result = await Promise.race([
      dispatchAction(env, identity, row, binding, proposal),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              Object.assign(new Error("Action outcome is unknown after timeout."), {
                code: "action_timeout",
              }),
            ),
          binding.action!.timeoutMs,
        ),
      ),
    ]);
    if (result.status !== "failed") {
      assertSchemaValue(
        binding.action!.resultSchema,
        result.output ?? {},
        `${row.tool_id} action result`,
      );
    }
  } catch (error) {
    result = {
      proposalId: row.id,
      status:
        error && typeof error === "object" && "code" in error && error.code === "action_timeout"
          ? "outcome_unknown"
          : "failed",
      summary: error instanceof Error ? error.message : "Action execution failed.",
    };
  }
  const finishedAt = new Date().toISOString();
  const responseSha256 = await sha256Hex(
    result.output ?? { status: result.status, summary: result.summary },
  );
  const published = await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_action_proposals SET status = ?, external_reference = ?, result_json = ?,
         error_json = ?, version = version + 1, terminal_at = CASE WHEN ? = 'outcome_unknown' THEN NULL ELSE ? END,
         updated_at = ? WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'executing'
         AND EXISTS (
           SELECT 1 FROM control_runs WHERE id = control_action_proposals.run_id
             AND user_id = ? AND workspace_id = ? AND status = 'running'
         )`,
    ).bind(
      result.status,
      result.externalReference ?? null,
      toJson(result.output ?? {}),
      result.status === "failed" || result.status === "outcome_unknown"
        ? toJson({ code: result.status, summary: result.summary })
        : "{}",
      result.status,
      finishedAt,
      finishedAt,
      row.id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.scope.userId,
      identity.scope.workspaceId,
    ),
    appendLedgerStatement(env, identity, {
      proposalId: row.id,
      status: result.status,
      summary: result.summary,
      requestSha256: row.input_sha256,
      responseSha256,
      externalReference: result.externalReference,
      requiredStatus: result.status,
      requiredUpdatedAt: finishedAt,
      timestamp: finishedAt,
    }),
    ...actionEvidenceStatements(env, identity, {
      proposalId: row.id,
      action: `action.${result.status}`,
      eventType: `action.${result.status}`,
      summary: result.summary,
      status: result.status,
      timestamp: finishedAt,
      data: { toolId: row.tool_id, packId: row.pack_id },
    }),
    ...(result.status === "outcome_unknown"
      ? [
          prepareOperatorAlertStatement(env, {
            userId: identity.scope.userId,
            workspaceId: identity.scope.workspaceId,
            agentId: identity.agentId,
            severity: "critical",
            code: "action_outcome_unknown",
            summary:
              "An external mutation has an ambiguous provider outcome and requires reconciliation.",
            targetType: "actionProposal",
            targetId: row.id,
            dedupKey: `action-outcome-unknown:${row.id}`,
            data: { toolId: row.tool_id, packId: row.pack_id },
            timestamp: finishedAt,
            conditionSql:
              "EXISTS (SELECT 1 FROM control_action_proposals WHERE id = ? AND status = 'outcome_unknown' AND updated_at = ?)",
            conditionBindings: [row.id, finishedAt],
          }),
        ]
      : []),
  ]);
  if ((published[0]?.meta?.changes ?? 0) === 0) {
    const revokedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE control_action_proposals SET status = 'outcome_unknown', error_json = ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'executing'`,
      ).bind(
        toJson({
          code: "publication_revoked",
          summary: "Execution completed after cancellation; reconcile before retry.",
        }),
        revokedAt,
        row.id,
        identity.scope.userId,
        identity.scope.workspaceId,
      ),
      appendLedgerStatement(env, identity, {
        proposalId: row.id,
        status: "outcome_unknown",
        requiredStatus: "outcome_unknown",
        requiredUpdatedAt: revokedAt,
        summary: "Action result publication was revoked after dispatch.",
        requestSha256: row.input_sha256,
        timestamp: revokedAt,
      }),
      ...actionEvidenceStatements(env, identity, {
        proposalId: row.id,
        action: "action.outcome_unknown",
        eventType: "action.outcome_unknown",
        summary: "Action result publication was revoked after dispatch.",
        status: "outcome_unknown",
        timestamp: revokedAt,
        data: { toolId: row.tool_id, packId: row.pack_id, publicationRevoked: true },
      }),
      prepareOperatorAlertStatement(env, {
        userId: identity.scope.userId,
        workspaceId: identity.scope.workspaceId,
        agentId: identity.agentId,
        severity: "critical",
        code: "action_outcome_unknown",
        summary:
          "An external mutation completed after publication authority was revoked; reconcile before retry.",
        targetType: "actionProposal",
        targetId: row.id,
        dedupKey: `action-outcome-unknown:${row.id}`,
        data: { toolId: row.tool_id, packId: row.pack_id, publicationRevoked: true },
        timestamp: revokedAt,
        conditionSql:
          "EXISTS (SELECT 1 FROM control_action_proposals WHERE id = ? AND status = 'outcome_unknown' AND updated_at = ?)",
        conditionBindings: [row.id, revokedAt],
      }),
    ]);
    return {
      proposalId: row.id,
      status: "outcome_unknown",
      summary: "Execution completed after cancellation; reconcile before retry.",
    };
  }
  return { ...result, proposalId: row.id };
};

export const reconcileActionProposal = async (
  env: Env,
  identity: AgentIdentity,
  proposalId: string,
): Promise<ActionExecutionResult> => {
  const row = await selectProposal(env, identity, proposalId);
  if (!row)
    throw Object.assign(new Error("Action proposal not found."), { code: "action_not_found" });
  if (row.status !== "outcome_unknown")
    throw Object.assign(new Error("Only unknown outcomes can be reconciled."), {
      code: "reconciliation_not_required",
    });
  const { binding } = resolveBinding(row);
  if (!binding.action?.reconcile)
    throw Object.assign(new Error("Action binding does not support reconciliation."), {
      code: "reconciliation_unavailable",
    });
  const proposal = parseJson(row.proposal_json) as ActionProposal;
  const result = await binding.action.reconcile(
    proposal,
    executionContext(env, identity, row, manifestConnections(row.pack_id)),
  );
  const timestamp = new Date().toISOString();
  if (result.status !== "reconciled" && result.status !== "executed") {
    await env.DB.batch([
      appendLedgerStatement(env, identity, {
        proposalId: row.id,
        status: "reviewed",
        requiredStatus: "outcome_unknown",
        summary: result.summary,
        externalReference: result.externalReference,
        timestamp,
      }),
      ...actionEvidenceStatements(env, identity, {
        proposalId: row.id,
        action: "action.reviewed",
        eventType: "action.reviewed",
        summary: result.summary,
        status: "outcome_unknown",
        timestamp,
        data: { toolId: row.tool_id, packId: row.pack_id },
      }),
    ]);
    return { ...result, proposalId: row.id, status: "outcome_unknown" };
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_action_proposals SET status = 'reconciled', external_reference = ?, result_json = ?,
         error_json = '{}', version = version + 1, terminal_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'outcome_unknown'`,
    ).bind(
      result.externalReference ?? null,
      toJson(result.output ?? {}),
      timestamp,
      timestamp,
      row.id,
      identity.scope.userId,
      identity.scope.workspaceId,
    ),
    appendLedgerStatement(env, identity, {
      proposalId: row.id,
      status: "reconciled",
      requiredStatus: "reconciled",
      requiredUpdatedAt: timestamp,
      summary: result.summary,
      externalReference: result.externalReference,
      timestamp,
    }),
    ...actionEvidenceStatements(env, identity, {
      proposalId: row.id,
      action: "action.reconciled",
      eventType: "action.reconciled",
      summary: result.summary,
      status: "reconciled",
      timestamp,
      data: { toolId: row.tool_id, packId: row.pack_id },
    }),
  ]);
  return { ...result, proposalId: row.id, status: "reconciled" };
};
