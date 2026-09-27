import type { ActionProposal, RuntimeStateRead } from "@operloom/agent-sdk";
import { resolveBinding, sha256Hex } from "./action-authority-core";
import { runtimeStateCanonicalJson, runtimeStateScopeId } from "./runtime-state";
import { providerOperationDescriptor } from "./provider-operation-registry";
import { validateActionReservations } from "./action-resources";
import {
  createId,
  type AgentIdentity,
  type ControlActionProposalRow,
  type D1PreparedStatement,
  type EffectTarget,
  type Env,
  type ToolPermissionRow,
} from "./types";

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
type ReviewBinding = {
  reservations?: ActionProposal["reservations"];
  providerOperation?: ReturnType<typeof providerOperationDescriptor>;
  userId: string;
  workspaceId: string;
  agentId: string;
  agentRevision: number;
  agentDataJson: string;
  proposalJson: string;
  proposalHash: string;
  runtimeHash: string;
  packId: string;
  toolId: string;
  approvalId: string;
  runId: string;
  intentId: string;
  stateScopeId: string;
  reads: readonly RuntimeStateRead[];
  permission: { id: string; status: string; executionJson: string; dataJson: string };
  connection: null | {
    id: string;
    connectionId: string;
    providerId: string;
    scopesJson: string;
    vaultObjectId: string | null;
    vaultVersion: string | null;
  };
  expiresAt: string;
};
export type ActionReview = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  proposal_id: string;
  request_hash: string;
  binding_json: string;
  expires_at: string;
  created_at: string;
};
const runtimeHash = async (env: Env, row: ControlActionProposalRow) => {
  const { binding, runtime } = resolveBinding(row);
  const operation = providerOperationDescriptor(env, binding);
  return sha256Hex(
    JSON.parse(
      JSON.stringify(
        {
          pack: row.pack_id,
          version: row.pack_version,
          runtime: runtime.runtimeVersion,
          bindingVersion: row.binding_version,
          binding,
          ...(operation ? { providerOperation: operation } : {}),
        },
        (_key, value) => (typeof value === "function" ? value.toString() : value),
      ),
    ),
  );
};
export const validateActionPreconditions = (
  proposal: ActionProposal,
  row: ControlActionProposalRow,
) => {
  if (proposal.preconditions !== undefined && !Array.isArray(proposal.preconditions))
    return fail("action_preconditions_invalid", "State preconditions must be an array");
  const reads = [...(proposal.preconditions ?? [])];
  const { runtime, binding } = resolveBinding(row);
  const reservations = validateActionReservations(
    proposal,
    runtime.controlPlane.state ?? [],
    Boolean(binding.action?.providerOperation),
  );
  const keys = new Set<string>();
  if (!Array.isArray(reads) || reads.length > 32)
    return fail("action_preconditions_invalid", "At most 32 state preconditions are allowed");
  for (const read of reads) {
    if (
      !read ||
      typeof read.namespace !== "string" ||
      typeof read.kind !== "string" ||
      typeof read.key !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(read.key) ||
      !Number.isSafeInteger(read.version) ||
      read.version < 0 ||
      !runtime.controlPlane.state?.some(
        (item) => item.namespace === read.namespace && item.kind === read.kind,
      )
    )
      return fail(
        "action_preconditions_invalid",
        "State preconditions must name declared records and exact versions",
      );
    const key = JSON.stringify([read.namespace, read.kind, read.key]);
    if (keys.has(key))
      return fail("action_preconditions_invalid", "State preconditions cannot repeat a record");
    keys.add(key);
  }
  for (const reservation of reservations) {
    const existing = reads.find(
      (read) =>
        read.namespace === reservation.namespace &&
        read.kind === reservation.kind &&
        read.key === reservation.key,
    );
    if (existing && existing.version !== reservation.version)
      return fail("action_preconditions_invalid", "Reservation and state read versions disagree");
    if (!existing)
      reads.push({
        namespace: reservation.namespace,
        kind: reservation.kind,
        key: reservation.key,
        version: reservation.version,
      });
  }
  if (reads.length > 32)
    return fail("action_preconditions_invalid", "At most 32 state preconditions are allowed");
  if (
    proposal.expiresAt !== undefined &&
    (typeof proposal.expiresAt !== "string" || !Number.isFinite(Date.parse(proposal.expiresAt)))
  )
    return fail("action_preconditions_invalid", "The action deadline must be an ISO timestamp");
  return reads;
};

export const createActionReview = async (
  env: Env,
  identity: AgentIdentity,
  row: ControlActionProposalRow,
  input: { approvalId: string; runId: string; intentId: string; permission?: ToolPermissionRow },
): Promise<ActionReview> => {
  const proposal = JSON.parse(row.proposal_json) as ActionProposal;
  const reads = validateActionPreconditions(proposal, row);
  const agent = await env.DB.prepare(
    "SELECT runtime_revision,effect_target,data_json FROM agents WHERE id=? AND workspace_id=? AND status='active'",
  )
    .bind(identity.agentId, identity.scope.workspaceId)
    .first<{ runtime_revision: number; effect_target: EffectTarget; data_json: string }>();
  if (!agent || !input.permission)
    return fail("action_review_conflict", "Current agent and tool policy are required");
  const connection = row.connection_record_id
    ? await env.DB.prepare(`SELECT id,connection_id,provider_id,scopes_json,vault_object_id,vault_version
    FROM control_connections WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=? AND status='authorized'`)
        .bind(
          row.connection_record_id,
          identity.scope.userId,
          identity.scope.workspaceId,
          identity.agentId,
        )
        .first<{
          id: string;
          connection_id: string;
          provider_id: string;
          scopes_json: string;
          vault_object_id: string | null;
          vault_version: string | null;
        }>()
    : null;
  if (row.connection_record_id && !connection)
    return fail("connection_not_authorized", "The action connection is unavailable");
  const providerOperation = providerOperationDescriptor(
    env,
    resolveBinding(row).binding,
    connection?.provider_id,
  );
  const expiresAt = new Date(
    Math.min(
      Date.now() + 15 * 60_000,
      proposal.expiresAt ? Date.parse(proposal.expiresAt) : Infinity,
    ),
  ).toISOString();
  if (Date.parse(expiresAt) <= Date.now())
    return fail("action_review_expired", "The proposed action deadline has passed");
  const binding: ReviewBinding = {
    ...(proposal.reservations?.length ? { reservations: proposal.reservations } : {}),
    ...(providerOperation ? { providerOperation } : {}),
    ...identity.scope,
    agentId: identity.agentId,
    agentRevision: agent.runtime_revision,
    agentDataJson: agent.data_json,
    proposalJson: row.proposal_json,
    proposalHash: await sha256Hex(proposal),
    runtimeHash: await runtimeHash(env, row),
    packId: row.pack_id,
    toolId: row.tool_id,
    approvalId: input.approvalId,
    runId: input.runId,
    intentId: input.intentId,
    stateScopeId: await runtimeStateScopeId(identity, row.pack_id, agent.effect_target),
    reads,
    permission: {
      id: input.permission.id,
      status: input.permission.status,
      executionJson: input.permission.execution_json,
      dataJson: input.permission.data_json,
    },
    connection: connection
      ? {
          id: connection.id,
          connectionId: connection.connection_id,
          providerId: connection.provider_id,
          scopesJson: connection.scopes_json,
          vaultObjectId: connection.vault_object_id,
          vaultVersion: connection.vault_version,
        }
      : null,
    expiresAt,
  };
  return {
    id: input.approvalId,
    user_id: identity.scope.userId,
    workspace_id: identity.scope.workspaceId,
    agent_id: identity.agentId,
    proposal_id: row.id,
    request_hash: await sha256Hex(binding),
    binding_json: runtimeStateCanonicalJson(binding),
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  };
};

/** b is a server-created immutable review binding. No package can supply this SQL or scope. */
const authority = `
  SELECT 1 FROM control_action_proposals p
  JOIN workspaces w ON w.id=p.workspace_id AND w.status='active'
  JOIN users u ON u.id=p.user_id AND u.status='active'
  JOIN memberships m ON m.user_id=p.user_id AND m.workspace_id=p.workspace_id AND m.status='active' AND m.role IN ('owner','admin')
  JOIN agents a ON a.id=p.agent_id AND a.workspace_id=p.workspace_id AND a.status='active'
  JOIN tool_permissions t ON t.user_id=p.user_id AND t.workspace_id=p.workspace_id AND t.agent_id=p.agent_id AND t.tool_id=p.tool_id
  CROSS JOIN b
  WHERE p.id=? AND p.status=? AND p.version=?
    AND p.user_id=json_extract(b.data,'$.userId') AND p.workspace_id=json_extract(b.data,'$.workspaceId') AND p.agent_id=json_extract(b.data,'$.agentId')
    AND p.proposal_json=json_extract(b.data,'$.proposalJson')
    AND a.runtime_revision=json_extract(b.data,'$.agentRevision') AND a.data_json=json_extract(b.data,'$.agentDataJson')
    AND json_extract(b.data,'$.expiresAt')>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND t.id=json_extract(b.data,'$.permission.id') AND t.status=json_extract(b.data,'$.permission.status')
    AND t.execution_json=json_extract(b.data,'$.permission.executionJson') AND t.data_json=json_extract(b.data,'$.permission.dataJson')
    AND json_extract(t.data_json,'$.mutationEnabled')=1
    AND EXISTS (SELECT 1 FROM control_retention_policies WHERE workspace_id=p.workspace_id AND confirmed_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM control_kill_switches k WHERE k.user_id=p.user_id AND k.workspace_id=p.workspace_id AND k.enabled=1 AND (
      (k.scope_kind='workspace' AND k.scope_id=p.workspace_id) OR (k.scope_kind='pack' AND k.scope_id=p.pack_id) OR (k.scope_kind='tool' AND k.scope_id=p.tool_id)
      OR (k.scope_kind='connection' AND k.scope_id IN (p.connection_record_id,json_extract(b.data,'$.connection.connectionId')))))
    AND (p.connection_record_id IS NULL OR EXISTS (SELECT 1 FROM control_connections c WHERE c.id=p.connection_record_id
      AND c.user_id=p.user_id AND c.workspace_id=p.workspace_id AND c.agent_id=p.agent_id AND c.status='authorized'
      AND c.provider_id=json_extract(b.data,'$.connection.providerId') AND c.scopes_json=json_extract(b.data,'$.connection.scopesJson')
      AND c.vault_object_id IS json_extract(b.data,'$.connection.vaultObjectId') AND c.vault_version IS json_extract(b.data,'$.connection.vaultVersion')))
    AND NOT EXISTS (SELECT 1 FROM json_each(b.data,'$.reads') expected LEFT JOIN control_state_records record
      ON record.scope_id=json_extract(b.data,'$.stateScopeId') AND record.namespace=json_extract(expected.value,'$.namespace')
      AND record.kind=json_extract(expected.value,'$.kind') AND record.record_key=json_extract(expected.value,'$.key')
      WHERE COALESCE(record.version,0)!=json_extract(expected.value,'$.version'))`;

export const insertActionReview = (env: Env, review: ActionReview, row: ControlActionProposalRow) =>
  env.DB.prepare(`WITH b(data) AS (VALUES (?)) INSERT INTO control_action_reviews
    (id,user_id,workspace_id,agent_id,proposal_id,request_hash,binding_json,expires_at,created_at,preconditions_met)
    VALUES (?,?,?,?,?,?,?,?,?,CASE WHEN EXISTS (${authority}) THEN 1 ELSE 0 END)`).bind(
    review.binding_json,
    review.id,
    review.user_id,
    review.workspace_id,
    review.agent_id,
    review.proposal_id,
    review.request_hash,
    review.binding_json,
    review.expires_at,
    review.created_at,
    row.id,
    "proposed",
    row.version,
  );

export const loadActionReview = async (
  env: Env,
  identity: AgentIdentity,
  row: ControlActionProposalRow,
) => {
  const review = await env.DB.prepare(
    `SELECT * FROM control_action_reviews WHERE proposal_id=? AND id=? AND user_id=? AND workspace_id=? AND agent_id=?`,
  )
    .bind(
      row.id,
      row.approval_request_id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
    )
    .first<ActionReview>();
  if (!review)
    return fail(
      "action_review_required",
      "This historical approval has no bound review; cancel or deny it and create a new proposal",
    );
  const binding = JSON.parse(review.binding_json) as ReviewBinding;
  if (
    (await sha256Hex(binding)) !== review.request_hash ||
    binding.proposalJson !== row.proposal_json ||
    binding.proposalHash !== (await sha256Hex(JSON.parse(row.proposal_json))) ||
    binding.runtimeHash !== (await runtimeHash(env, row))
  )
    return fail(
      "action_review_changed",
      "The reviewed payload or runtime changed; create a new proposal",
    );
  if (Date.parse(review.expires_at) <= Date.now())
    return fail("action_review_expired", "The approval has expired; create a new proposal");
  return review;
};

/** CHECK failure aborts the complete batch, including transitions which would otherwise update zero rows. */
export const actionReviewTransition = (
  env: Env,
  identity: AgentIdentity,
  row: ControlActionProposalRow,
  review: ActionReview,
  phase: "approved" | "executing" | "provider_dispatch",
  timestamp: string,
) =>
  env.DB.prepare(`WITH b(data) AS (VALUES (?)) INSERT INTO control_action_ledger
  (id,user_id,workspace_id,agent_id,proposal_id,sequence,status,summary,request_sha256,data_json,created_at,transition_key,preconditions_met)
  VALUES (?,?,?,?,?,COALESCE((SELECT MAX(sequence) FROM control_action_ledger WHERE proposal_id=?),0)+1,?,?,?,?,?,?,
    CASE WHEN EXISTS (${authority}) THEN CASE WHEN EXISTS (
      SELECT 1 FROM control_approval_requests approval JOIN control_runs r ON r.id=approval.run_id AND r.status=?
      JOIN control_workflow_intents i ON i.id=approval.workflow_intent_id AND i.status=r.status CROSS JOIN b
      WHERE approval.id=? AND approval.user_id=json_extract(b.data,'$.userId') AND approval.workspace_id=json_extract(b.data,'$.workspaceId')
      AND approval.agent_id=json_extract(b.data,'$.agentId') AND approval.run_id=json_extract(b.data,'$.runId')
      AND approval.workflow_intent_id=json_extract(b.data,'$.intentId') AND approval.status=?
      AND json_extract(approval.data_json,'$.actionReviewHash')=?
    ) THEN 1 ELSE 0 END ELSE 0 END)`).bind(
    review.binding_json,
    createId("cf-action-ledger"),
    identity.scope.userId,
    identity.scope.workspaceId,
    identity.agentId,
    row.id,
    row.id,
    phase === "provider_dispatch" ? "executing" : phase,
    phase === "approved"
      ? "Bound action approved by workspace operator."
      : "Bound action dispatch admitted.",
    review.request_hash,
    JSON.stringify({ reviewId: review.id, expiresAt: review.expires_at }),
    timestamp,
    `${phase}:${review.id}`,
    row.id,
    phase === "approved"
      ? "approval_requested"
      : phase === "provider_dispatch"
        ? "executing"
        : "approved",
    row.version,
    phase === "approved" ? "interrupted" : "running",
    review.id,
    phase === "approved" ? "requested" : "approved",
    review.request_hash,
  );

export const commitActionReviewBatch = async (env: Env, statements: D1PreparedStatement[]) => {
  try {
    return await env.DB.batch(statements);
  } catch (error) {
    if (
      error instanceof Error &&
      /action_(review|transition)_precondition|control_action_reviews\.(id|proposal_id)|control_action_ledger.proposal_id, control_action_ledger.transition_key/.test(
        error.message,
      )
    )
      return fail(
        "action_review_conflict",
        "Action authority, reviewed state or approval changed; create a new proposal",
      );
    throw error;
  }
};
