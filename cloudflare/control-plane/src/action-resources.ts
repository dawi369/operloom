import type {
  ActionProposal,
  RuntimeStateDefinition,
  RuntimeStateCommit,
} from "@operloom/agent-sdk";
import type { AgentIdentity, D1PreparedStatement, Env } from "./types";

const fail = (message: string): never => {
  throw Object.assign(new Error(message), { code: "action_resource_invalid" });
};
export const validateActionReservations = (
  proposal: ActionProposal,
  definitions: readonly RuntimeStateDefinition[],
  providerOperation: boolean,
) => {
  const reservations = proposal.reservations ?? [];
  if (
    !Array.isArray(reservations) ||
    reservations.length > 8 ||
    (reservations.length && !providerOperation)
  )
    return fail("At most eight resource reservations are allowed on named provider operations");
  const seen = new Set<string>();
  for (const item of reservations) {
    if (
      !item ||
      typeof item.namespace !== "string" ||
      typeof item.kind !== "string" ||
      typeof item.key !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(item.key) ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1 ||
      typeof item.field !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(item.field) ||
      !Number.isSafeInteger(item.amount) ||
      item.amount < 1 ||
      item.amount > 1000000000 ||
      !definitions.some(
        (definition) => definition.namespace === item.namespace && definition.kind === item.kind,
      )
    )
      return fail(
        "Reservations require declared records, exact versions, integer amounts and a bounded capacity field",
      );
    const key = JSON.stringify([item.namespace, item.kind, item.key, item.field]);
    if (seen.has(key)) return fail("A proposal cannot repeat a resource reservation");
    seen.add(key);
  }
  return reservations;
};

export const actionReservationStatements = (
  env: Env,
  input: {
    identity: AgentIdentity;
    proposalId: string;
    receiptId: string;
    scopeId: string;
    reservations: NonNullable<ActionProposal["reservations"]>;
    now: string;
  },
) =>
  input.reservations.map((reservation, index) =>
    env.DB.prepare(`INSERT INTO control_action_reservations
  (id,user_id,workspace_id,agent_id,proposal_id,provider_receipt_id,scope_id,namespace,kind,record_key,record_version,field,amount,status,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'held',?,?)`).bind(
      `${input.receiptId}:${index}`,
      input.identity.scope.userId,
      input.identity.scope.workspaceId,
      input.identity.agentId,
      input.proposalId,
      input.receiptId,
      input.scopeId,
      reservation.namespace,
      reservation.kind,
      reservation.key,
      reservation.version,
      reservation.field,
      reservation.amount,
      input.now,
      input.now,
    ),
  );

/** Projection is appended after the commit guard, before writes; a later failure rolls it all back. */
export const actionProjectionStatements = (
  env: Env,
  input: {
    identity: AgentIdentity;
    target: "simulation" | "external";
    packId: string;
    scopeId: string;
    commit: RuntimeStateCommit;
    commitId: string;
    now: string;
  },
): D1PreparedStatement[] => {
  const projection = input.commit.projection;
  if (projection === undefined) return [];
  if (
    input.target !== "external" ||
    !projection ||
    typeof projection.proposalId !== "string" ||
    projection.proposalId.length > 200 ||
    !projection.proposalId.length
  )
    return fail("Only external typed state can project a named provider action");
  const { identity } = input;
  // INSERT ... VALUES with a scalar lookup deliberately yields NULL on a failed
  // predicate. The NOT NULL constraint aborts the batch, rather than silently
  // inserting zero rows and allowing state writes to continue.
  return [
    env.DB.prepare(`INSERT INTO control_action_projections
    (id,user_id,workspace_id,agent_id,proposal_id,provider_receipt_id,commit_id,created_at)
    VALUES (?,?,?,?,?,(SELECT o.id FROM control_provider_operations o JOIN control_action_proposals p ON p.id=o.proposal_id
      JOIN memberships m ON m.user_id=o.user_id AND m.workspace_id=o.workspace_id AND m.status='active' AND m.role IN ('owner','admin')
      WHERE p.id=? AND p.pack_id=? AND o.user_id=? AND o.workspace_id=? AND o.agent_id=? AND o.status IN ('succeeded','failed') AND json_extract(o.result_json,'$.payloadPrunedAt') IS NULL
      AND NOT EXISTS (SELECT 1 FROM control_action_reservations c
        LEFT JOIN control_state_records r ON r.scope_id=c.scope_id AND r.namespace=c.namespace AND r.kind=c.kind AND r.record_key=c.record_key
        LEFT JOIN json_each(?) w ON json_extract(w.value,'$.namespace')=c.namespace AND json_extract(w.value,'$.kind')=c.kind AND json_extract(w.value,'$.key')=c.record_key
        WHERE c.proposal_id=p.id AND c.status='held' AND (c.scope_id!=? OR o.status!='succeeded' OR r.id IS NULL OR w.value IS NULL
          OR json_type(w.value,'$.data.'||c.field) IS NOT 'integer'
          OR json_extract(w.value,'$.data.'||c.field)!=json_extract(r.data_json,'$.'||c.field)-c.amount))
    ),?,?)`).bind(
      `projection:${input.commitId}`,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      projection.proposalId,
      projection.proposalId,
      input.packId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      JSON.stringify(input.commit.writes),
      input.scopeId,
      input.commitId,
      input.now,
    ),
    env.DB.prepare(`UPDATE control_action_reservations SET status='projected',projection_commit_id=?,updated_at=?
      WHERE proposal_id=? AND user_id=? AND workspace_id=? AND agent_id=? AND status='held'`).bind(
      input.commitId,
      input.now,
      projection.proposalId,
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
    ),
  ];
};
