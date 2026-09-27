import type { RuntimeDurableApproval, RuntimeDurableApprovalReceipt } from "@operloom/agent-sdk";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import { runtimeStateCanonicalJson } from "./runtime-state";
import { durableExecutionLiveSql as live } from "./durable-attempt-authority";
import { requireDurableExecutionAuthority } from "./durable-execution-store";
import type { AgentIdentity, Env } from "./types";
import { json } from "./http";

export type DurableApprovalRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  run_id: string;
  workflow_intent_id: string;
  request_hash: string;
  expires_at: string;
  status: string;
  decided_at: string | null;
  decided_by_user_id: string | null;
  consumed_at: string | null;
  wake_lease_id: string | null;
  wake_attempts: number;
};
const scope = (identity: AgentIdentity) => [
  identity.scope.userId,
  identity.scope.workspaceId,
  identity.agentId,
];
const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};
const clock = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export const readDurableApproval = (env: Env, identity: AgentIdentity, id: string) =>
  env.DB.prepare(
    "SELECT * FROM control_durable_approvals WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=?",
  )
    .bind(id, ...scope(identity))
    .first<DurableApprovalRow>();

export const prepareDurableApproval = async (
  env: Env,
  identity: AgentIdentity,
  runId: string,
  definition: RuntimeDurableApproval,
) => {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,80}$/.test(definition.key) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,80}$/.test(definition.version) ||
    typeof definition.summary !== "string" ||
    !definition.summary.trim() ||
    definition.summary.length > 500 ||
    !Number.isSafeInteger(definition.timeoutMs) ||
    definition.timeoutMs < 1000 ||
    definition.timeoutMs > 604800000 ||
    !definition.payload ||
    typeof definition.payload !== "object" ||
    Array.isArray(definition.payload)
  )
    return fail("durable_approval_invalid");
  const payload = runtimeStateCanonicalJson(definition.payload);
  if (new TextEncoder().encode(payload).byteLength > 32768)
    return fail("durable_approval_payload_limit");
  const requestHash = await sha256Hex(runtimeStateCanonicalJson(definition));
  const id = `approval-${await sha256Hex(runtimeStateCanonicalJson([runId, definition.key]))}`;
  const execution = await requireDurableExecutionAuthority(env, identity, runId);
  const replay = (row: DurableApprovalRow) => {
    if (row.request_hash !== requestHash) return fail("durable_approval_conflict");
    return row;
  };
  const previous = await readDurableApproval(env, identity, id);
  if (previous) return replay(previous);
  const now = new Date().toISOString();
  const expiresAt = new Date(
    Math.min(Date.now() + definition.timeoutMs, Date.parse(execution.deadline)),
  ).toISOString();
  try {
    await env.DB.prepare(`INSERT INTO control_durable_approvals
      (id,user_id,workspace_id,agent_id,run_id,workflow_intent_id,step_key,step_version,request_hash,
       summary,payload_json,expires_at,status,created_at,preconditions_met)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'requested',?,CASE WHEN EXISTS (${live()}
        AND NOT EXISTS (SELECT 1 FROM control_durable_steps s WHERE s.run_id=e.run_id AND s.status='running')
        AND NOT EXISTS (SELECT 1 FROM control_durable_approvals p WHERE p.run_id=e.run_id AND p.consumed_at IS NULL)
      ) THEN 1 ELSE 0 END)`)
      .bind(
        id,
        ...scope(identity),
        runId,
        execution.workflow_intent_id,
        definition.key,
        definition.version,
        requestHash,
        definition.summary,
        payload,
        expiresAt,
        now,
        runId,
        ...scope(identity),
        now,
      )
      .run();
  } catch (error) {
    const concurrent = await readDurableApproval(env, identity, id);
    if (concurrent) return replay(concurrent);
    if (String(error).includes("workspace_export_in_progress"))
      return fail("workspace_export_in_progress");
    return fail("durable_approval_admission_denied");
  }
  return (await readDurableApproval(env, identity, id))!;
};

export const decideDurableApproval = async (
  env: Env,
  identity: AgentIdentity,
  id: string,
  decision: "approved" | "denied",
  reason?: string,
) => {
  const row = await readDurableApproval(env, identity, id);
  if (!row) return json({ ok: false, code: "approval_not_found" }, { status: 404 });
  try {
    await requireDurableExecutionAuthority(env, identity, row.run_id);
  } catch {
    return json({ ok: false, code: "durable_approval_authority_revoked" }, { status: 409 });
  }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE control_durable_approvals
    SET status=?,decided_at=?,decided_by_user_id=?,decision_reason=?,wake_next_at=?
    WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=? AND status='requested' AND expires_at>${clock}
      AND EXISTS (${live("'waiting'")})
      AND EXISTS (SELECT 1 FROM memberships WHERE user_id=? AND workspace_id=? AND status='active' AND role IN ('owner','admin'))`)
    .bind(
      decision,
      now,
      identity.scope.userId,
      (reason ?? "").slice(0, 240),
      decision === "approved" ? now : null,
      id,
      ...scope(identity),
      row.run_id,
      ...scope(identity),
      now,
      identity.scope.userId,
      identity.scope.workspaceId,
    )
    .run();
  // D1 counts trigger writes too. The primary-key predicate limits the decision
  // itself to one row; a successful decision also updates projections and events.
  if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) < 1)
    return json({ ok: false, code: "durable_approval_conflict" }, { status: 409 });
  return json({
    ok: true,
    run: {
      id: row.run_id,
      workflowIntentId: row.workflow_intent_id,
      status: decision === "approved" ? "waiting" : "cancelled",
    },
    approvalRequest: { id, status: decision },
    toolCall: null,
    artifact: null,
  });
};

export const consumeDurableApproval = async (
  env: Env,
  identity: AgentIdentity,
  id: string,
  requestHash: string,
): Promise<RuntimeDurableApprovalReceipt> => {
  const row = await readDurableApproval(env, identity, id);
  if (!row || row.request_hash !== requestHash) return fail("durable_approval_conflict");
  await requireDurableExecutionAuthority(env, identity, row.run_id);
  if (row.status !== "approved") return fail(`durable_approval_${row.status}`);
  if (!row.consumed_at) {
    await env.DB.prepare(`UPDATE control_durable_approvals SET consumed_at=?,wake_next_at=NULL
      WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=? AND status='approved'
        AND consumed_at IS NULL AND expires_at>${clock} AND EXISTS (${live("'waiting'")})
        AND EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
          WHERE m.user_id=control_durable_approvals.decided_by_user_id AND m.workspace_id=control_durable_approvals.workspace_id
            AND m.status='active' AND m.role IN ('owner','admin'))`)
      .bind(
        new Date().toISOString(),
        id,
        ...scope(identity),
        row.run_id,
        ...scope(identity),
        new Date().toISOString(),
      )
      .run();
    const consumed = await readDurableApproval(env, identity, id);
    if (!consumed?.consumed_at) return fail("durable_approval_consumption_denied");
  }
  return { id, requestHash, decidedAt: row.decided_at!, decidedByUserId: row.decided_by_user_id! };
};

/** System expiration revokes a pending review; it never grants execution authority. */
export const expireDurableApprovals = async (env: Env) => {
  await env.DB.prepare(`UPDATE control_durable_approvals SET status='expired',decided_at=${clock},wake_next_at=NULL
    WHERE id IN (SELECT id FROM control_durable_approvals p WHERE p.status='requested' AND p.expires_at<=${clock}
      AND NOT EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=p.workspace_id
        AND f.status='active' AND f.lease_expires_at>${clock}) ORDER BY expires_at LIMIT 16)`).run();
  // Keep the approved decision immutable, but revoke an unconsumed expired continuation.
  await env.DB.prepare(`UPDATE control_runs SET status='blocked',updated_at=${clock},last_event_at=${clock},
    data_json=json_set(data_json,'$.approvalOutcome','expired') WHERE status='waiting' AND id IN (
      SELECT p.run_id FROM control_durable_approvals p WHERE p.status='approved' AND p.consumed_at IS NULL
        AND p.expires_at<=${clock} AND NOT EXISTS (SELECT 1 FROM control_workspace_write_fences f
          WHERE f.workspace_id=p.workspace_id AND f.status='active' AND f.lease_expires_at>${clock})
      ORDER BY p.expires_at LIMIT 16)`).run();
};
