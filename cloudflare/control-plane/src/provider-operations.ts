import {
  assertSchemaValue,
  type ActionExecutionResult,
  type ActionPort,
  type RuntimeToolBinding,
} from "@operloom/agent-sdk/control-plane";
import { resolveCredentialVault } from "./credential-vault";
import { actionReviewTransition, loadActionReview } from "./action-review";
import { recoverUndispatchedProviderAction } from "./provider-operation-recovery";
import { actionReservationStatements } from "./action-resources";
import { runtimeStateCanonicalJson } from "./runtime-state";
import { sha256Hex } from "./connection-broker-shared";
import {
  providerOperationDescriptor,
  providerOperationOutput,
  providerOperationReference,
  type ProviderOperationDescriptor,
} from "./provider-operation-registry";
import type { AgentIdentity, ControlActionProposalRow, Env } from "./types";

type Receipt = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  proposal_id: string;
  review_id: string;
  operation_id: string;
  operation_version: string;
  descriptor_json: string;
  request_hash: string;
  connection_record_id: string;
  vault_version: string;
  status: "dispatching" | "succeeded" | "failed" | "outcome_unknown";
  result_json: string;
};
export const inspectProviderAction = async (
  env: Env,
  identity: AgentIdentity,
  packId: string,
  proposalId: string,
): ReturnType<NonNullable<ActionPort["inspect"]>> => {
  const row =
    await env.DB.prepare(`SELECT p.proposal_json,o.status,o.result_json,projection.commit_id,projection.created_at
    FROM control_action_proposals p
    JOIN workspaces w ON w.id=p.workspace_id AND w.status='active'
    JOIN users u ON u.id=p.user_id AND u.status='active'
    JOIN memberships m ON m.workspace_id=p.workspace_id AND m.user_id=p.user_id AND m.status='active'
    JOIN agents a ON a.id=p.agent_id AND a.workspace_id=p.workspace_id AND a.status='active' AND a.runtime_revision=?
    LEFT JOIN control_provider_operations o ON o.proposal_id=p.id
    LEFT JOIN control_action_projections projection ON projection.proposal_id=p.id
    WHERE p.id=? AND p.user_id=? AND p.workspace_id=? AND p.agent_id=? AND p.pack_id=?`)
      .bind(
        identity.agentRevision ?? 0,
        proposalId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        packId,
      )
      .first<{
        proposal_json: string;
        status: Receipt["status"] | null;
        result_json: string | null;
        commit_id: string | null;
        created_at: string | null;
      }>();
  if (!row)
    throw Object.assign(new Error("Action not found in the current execution scope"), {
      code: "action_not_found",
    });
  const proposal = JSON.parse(row.proposal_json);
  return {
    proposal: proposal.payloadPrunedAt ? null : proposal,
    provider: row.status
      ? { status: row.status, output: JSON.parse(row.result_json ?? "{}") }
      : null,
    projection: row.commit_id ? { commitId: row.commit_id, createdAt: row.created_at! } : null,
  };
};
const scopedReceipt = (env: Env, identity: AgentIdentity, proposalId: string) =>
  env.DB.prepare(
    `SELECT * FROM control_provider_operations WHERE proposal_id=? AND user_id=? AND workspace_id=? AND agent_id=?`,
  )
    .bind(proposalId, identity.scope.userId, identity.scope.workspaceId, identity.agentId)
    .first<Receipt>();
const unknown = (id: string): ActionExecutionResult => ({
  proposalId: id,
  status: "outcome_unknown",
  summary: "Provider outcome is unconfirmed; reconciliation is required.",
});
const resultFromReceipt = (receipt: Receipt, reconcile = false): ActionExecutionResult => {
  if (receipt.status === "dispatching" || receipt.status === "outcome_unknown")
    return unknown(receipt.proposal_id);
  const output = JSON.parse(receipt.result_json) as Record<string, unknown>;
  return {
    proposalId: receipt.proposal_id,
    status: reconcile ? "reconciled" : receipt.status === "succeeded" ? "executed" : "failed",
    summary:
      receipt.status === "succeeded"
        ? "Provider accepted the allocation request."
        : "Provider rejected the allocation request.",
    externalReference: typeof output.resourceId === "string" ? output.resourceId : undefined,
    output,
  };
};

const connectionCredential = async (
  env: Env,
  identity: AgentIdentity,
  row: ControlActionProposalRow,
  operation: ProviderOperationDescriptor,
) => {
  const connection =
    await env.DB.prepare(`SELECT c.vault_object_id,c.vault_version FROM control_connections c
    JOIN workspaces w ON w.id=c.workspace_id AND w.status='active'
    JOIN users u ON u.id=c.user_id AND u.status='active'
    JOIN memberships m ON m.user_id=c.user_id AND m.workspace_id=c.workspace_id AND m.status='active' AND m.role IN ('owner','admin')
    JOIN agents a ON a.id=c.agent_id AND a.workspace_id=c.workspace_id AND a.status='active'
    WHERE c.id=? AND c.user_id=? AND c.workspace_id=? AND c.agent_id=? AND c.pack_id=? AND c.provider_id=? AND c.status='authorized' AND c.credential_class=?`)
      .bind(
        row.connection_record_id,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        row.pack_id,
        operation.providerId,
        operation.credentialClass,
      )
      .first<{ vault_object_id: string; vault_version: string }>();
  if (!connection?.vault_object_id || !connection.vault_version)
    throw new Error("provider_connection_unavailable");
  const stored = await resolveCredentialVault(env).read({
    id: connection.vault_object_id,
    version: connection.vault_version,
  });
  if (stored.version !== connection.vault_version)
    throw new Error("provider_credential_version_changed");
  let credential: { kind?: string; apiKey?: unknown };
  try {
    credential = JSON.parse(stored.value);
  } catch {
    throw new Error("provider_credential_invalid");
  }
  if (
    !credential ||
    credential.kind !== "api_key" ||
    typeof credential.apiKey !== "string" ||
    credential.apiKey.length < 16 ||
    credential.apiKey.length > 8192 ||
    !/^[\x21-\x7e]+$/.test(credential.apiKey)
  )
    throw new Error("provider_credential_invalid");
  return { secret: credential.apiKey, version: connection.vault_version };
};

const authenticatedHeaders = async (
  operation: ProviderOperationDescriptor,
  secret: string,
  requestId: string,
  method: string,
  url: string,
  body: string,
) => {
  const headers = new Headers({ "content-type": "application/json", "idempotency-key": requestId });
  if (operation.auth === "bearer") headers.set("authorization", `Bearer ${secret}`);
  else {
    const timestamp = new Date().toISOString();
    const canonical = [method, url, await sha256Hex(body), requestId, timestamp].join("\n");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)),
    );
    headers.set("x-capacity-timestamp", timestamp);
    headers.set(
      "x-capacity-signature",
      Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  }
  return headers;
};

const readBoundedJson = async (response: Response, maxBytes: number) => {
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    await response.body?.cancel();
    throw new Error("provider_response_unconfirmed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("provider_response_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
};

const observeResponse = async (
  env: Env,
  identity: AgentIdentity,
  row: ControlActionProposalRow,
  receipt: Pick<Receipt, "id">,
  operation: ProviderOperationDescriptor,
  secret: string,
  init: RequestInit,
  url: string,
) => {
  let output: ReturnType<typeof providerOperationOutput> | undefined;
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(operation.timeoutMs),
    });
    output = providerOperationOutput(
      operation,
      await readBoundedJson(response, operation.maxResponseBytes),
      receipt.id,
      secret,
    );
  } catch {
    /* Unconfirmed transport/schema outcomes never authorize another mutation. */
  }
  await env.DB.prepare(`UPDATE control_provider_operations SET status=?,result_json=?,updated_at=?
    WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=? AND status IN ('dispatching','outcome_unknown')`)
    .bind(
      output ? (output.lifecycle === "rejected" ? "failed" : "succeeded") : "outcome_unknown",
      runtimeStateCanonicalJson(output ?? {}),
      new Date().toISOString(),
      receipt.id,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
    )
    .run();
  const durable = await scopedReceipt(env, identity, row.id);
  if (!durable) throw new Error("provider_receipt_unavailable");
  return durable;
};

export const dispatchProviderOperation = async (
  env: Env,
  identity: AgentIdentity,
  proposalId: string,
  binding: RuntimeToolBinding,
): Promise<ActionExecutionResult> => {
  if (env.OPERLOOM_CONNECTIONS_ENABLED !== "true" || env.OPERLOOM_MUTATIONS_ENABLED !== "true")
    throw new Error("provider_operations_disabled");
  const row = await env.DB.prepare(
    `SELECT * FROM control_action_proposals WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=?`,
  )
    .bind(proposalId, identity.scope.userId, identity.scope.workspaceId, identity.agentId)
    .first<ControlActionProposalRow>();
  if (!row || row.status !== "executing") throw new Error("provider_action_not_executing");
  const operation = providerOperationDescriptor(env, binding);
  if (!operation) throw new Error("provider_operation_unavailable");
  const input = (JSON.parse(row.proposal_json) as { preview: unknown }).preview;
  assertSchemaValue(operation.inputSchema, input, "Provider operation input");
  const requestHash = await sha256Hex(runtimeStateCanonicalJson({ input, operation }));
  const prior = await scopedReceipt(env, identity, row.id);
  if (prior) {
    if (prior.request_hash !== requestHash) throw new Error("provider_operation_conflict");
    return resultFromReceipt(prior);
  }
  const review = await loadActionReview(env, identity, row);
  if (
    runtimeStateCanonicalJson(JSON.parse(review.binding_json).providerOperation) !==
    runtimeStateCanonicalJson(operation)
  )
    throw new Error("provider_operation_changed");
  const credential = await connectionCredential(env, identity, row, operation);
  const requestId = await sha256Hex(
    runtimeStateCanonicalJson({
      ...identity.scope,
      agentId: identity.agentId,
      proposalId: row.id,
      operationId: operation.id,
    }),
  );
  const body = runtimeStateCanonicalJson(input);
  const headers = await authenticatedHeaders(
    operation,
    credential.secret,
    requestId,
    "POST",
    operation.url,
    body,
  );
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      actionReviewTransition(env, identity, row, review, "provider_dispatch", now),
      env.DB.prepare(`INSERT INTO control_provider_operations(id,user_id,workspace_id,agent_id,proposal_id,review_id,operation_id,operation_version,descriptor_json,request_hash,connection_record_id,vault_version,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'dispatching',?,?)`).bind(
        requestId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        row.id,
        review.id,
        operation.id,
        operation.version,
        runtimeStateCanonicalJson(operation),
        requestHash,
        row.connection_record_id,
        credential.version,
        now,
        now,
      ),
      ...actionReservationStatements(env, {
        identity,
        proposalId: row.id,
        receiptId: requestId,
        scopeId: JSON.parse(review.binding_json).stateScopeId,
        reservations: JSON.parse(review.binding_json).reservations ?? [],
        now,
      }),
    ]);
  } catch {
    const concurrent = await scopedReceipt(env, identity, row.id);
    if (concurrent?.request_hash === requestHash) return resultFromReceipt(concurrent);
    throw new Error("provider_operation_admission_conflict");
  }
  const receipt = { id: requestId };
  return resultFromReceipt(
    await observeResponse(
      env,
      identity,
      row,
      receipt,
      operation,
      credential.secret,
      { method: "POST", headers, body },
      operation.url,
    ),
  );
};

/** Same admission, receipt and reservation records as a dispatch, with the simulator's output as the outcome. */
export const recordSimulatedProviderOperation = async (
  env: Env,
  identity: AgentIdentity,
  proposalId: string,
  binding: RuntimeToolBinding,
  output: Record<string, unknown>,
): Promise<ActionExecutionResult> => {
  const row = await env.DB.prepare(
    `SELECT * FROM control_action_proposals WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=?`,
  )
    .bind(proposalId, identity.scope.userId, identity.scope.workspaceId, identity.agentId)
    .first<ControlActionProposalRow>();
  if (!row || row.status !== "executing" || row.effect_target !== "simulation")
    throw new Error("provider_action_not_executing");
  const operation = providerOperationReference(binding);
  if (!operation) throw new Error("provider_operation_unavailable");
  const input = (JSON.parse(row.proposal_json) as { preview: unknown }).preview;
  assertSchemaValue(operation.inputSchema, input, "Provider operation input");
  const requestHash = await sha256Hex(runtimeStateCanonicalJson({ input, operation }));
  const prior = await scopedReceipt(env, identity, row.id);
  if (prior) {
    if (prior.request_hash !== requestHash) throw new Error("provider_operation_conflict");
    return resultFromReceipt(prior);
  }
  const review = await loadActionReview(env, identity, row);
  if (
    runtimeStateCanonicalJson(JSON.parse(review.binding_json).providerOperation) !==
    runtimeStateCanonicalJson(operation)
  )
    throw new Error("provider_operation_changed");
  const requestId = await sha256Hex(
    runtimeStateCanonicalJson({
      ...identity.scope,
      agentId: identity.agentId,
      proposalId: row.id,
      operationId: operation.id,
    }),
  );
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      actionReviewTransition(env, identity, row, review, "provider_dispatch", now),
      env.DB.prepare(`INSERT INTO control_provider_operations(id,user_id,workspace_id,agent_id,proposal_id,review_id,operation_id,operation_version,descriptor_json,request_hash,connection_record_id,vault_version,effect_target,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'simulation','simulation','simulation','dispatching',?,?)`).bind(
        requestId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        row.id,
        review.id,
        operation.id,
        operation.version,
        runtimeStateCanonicalJson(operation),
        requestHash,
        now,
        now,
      ),
      ...actionReservationStatements(env, {
        identity,
        proposalId: row.id,
        receiptId: requestId,
        scopeId: JSON.parse(review.binding_json).stateScopeId,
        reservations: JSON.parse(review.binding_json).reservations ?? [],
        now,
      }),
      env.DB.prepare(`UPDATE control_provider_operations SET status=?,result_json=?,updated_at=?
        WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=? AND status='dispatching'`).bind(
        output.lifecycle === "rejected" ? "failed" : "succeeded",
        runtimeStateCanonicalJson(output),
        now,
        requestId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
      ),
    ]);
  } catch {
    const concurrent = await scopedReceipt(env, identity, row.id);
    if (concurrent?.request_hash === requestHash) return resultFromReceipt(concurrent);
    throw new Error("provider_operation_admission_conflict");
  }
  const receipt = await scopedReceipt(env, identity, row.id);
  if (!receipt) throw new Error("provider_receipt_unavailable");
  return resultFromReceipt(receipt);
};

export const reconcileProviderOperation = async (
  env: Env,
  identity: AgentIdentity,
  row: ControlActionProposalRow,
  binding: RuntimeToolBinding,
): Promise<ActionExecutionResult> => {
  const authority =
    await env.DB.prepare(`SELECT 1 FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
    JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN agents a ON a.id=? AND a.workspace_id=w.id AND a.status='active'
    WHERE w.id=? AND w.status='active' AND m.user_id=? AND m.status='active' AND m.role IN ('owner','admin')`)
      .bind(identity.agentId, identity.scope.workspaceId, identity.scope.userId)
      .first();
  if (!authority) throw new Error("provider_operation_not_found");
  let receipt = await scopedReceipt(env, identity, row.id);
  if (!receipt) {
    const resolved = await recoverUndispatchedProviderAction(env, identity, row);
    if (resolved) return resolved;
    receipt = await scopedReceipt(env, identity, row.id);
    if (!receipt) return unknown(row.id);
  }
  // Canonical outcomes survive projection failure and require no provider request.
  if (receipt.status === "succeeded" || receipt.status === "failed")
    return resultFromReceipt(receipt, true);
  if (row.effect_target === "simulation") return unknown(row.id);
  if (env.OPERLOOM_CONNECTIONS_ENABLED !== "true") throw new Error("provider_operations_disabled");
  const operation = providerOperationDescriptor(env, binding);
  if (!operation || runtimeStateCanonicalJson(operation) !== receipt.descriptor_json)
    throw new Error("provider_operation_changed");
  const credential = await connectionCredential(env, identity, row, operation);
  if (credential.version !== receipt.vault_version)
    throw new Error("provider_credential_version_changed");
  const url = `${operation.url}/${receipt.id}`;
  const headers = await authenticatedHeaders(
    operation,
    credential.secret,
    receipt.id,
    "GET",
    url,
    "",
  );
  return resultFromReceipt(
    await observeResponse(
      env,
      identity,
      row,
      receipt,
      operation,
      credential.secret,
      { method: "GET", headers },
      url,
    ),
    true,
  );
};
