import { publicStateContracts } from "../../../packages/client/src/public-state-contracts";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import {
  startRuntimeStateMigration,
  repairRuntimeStateMigration,
  advanceRuntimeStateMigration,
  stateMigrationSummary,
} from "./runtime-state-migrations";
import { resolveAgentBehaviorConfig } from "./agent-records";
import { json } from "./http";
import { runtimeStateScopeId } from "./runtime-state";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import type { AgentIdentity, AgentRow, Env } from "./types";

const failure = (status: number, code: string, error: string) =>
  json({ ok: false, code, error }, { status });
const authoritySql = `SELECT a.*, m.role FROM agents a
  JOIN workspaces w ON w.id = a.workspace_id AND w.status = 'active'
  JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ? AND m.status = 'active'
  JOIN users u ON u.id = m.user_id AND u.status = 'active'
  WHERE a.workspace_id = ? AND a.id = ? AND a.status = 'active'`;
type StateRow = {
  id: string;
  namespace: string;
  kind: string;
  record_key: string;
  schema_version: number;
  version: number;
  data_json: string;
  updated_at: string;
  entry_key: string;
  event_key: string;
  commit_id: string;
  type: string;
  created_at: string;
  delivered_at: string | null;
  status: string;
  attempts: number;
};

export const handleRuntimeStateMigrationOperation = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  migrationId?: string,
  action: "start" | "advance" | "repair" = "start",
) => {
  const agent = await env.DB.prepare(authoritySql)
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId)
    .first<AgentRow & { role: string }>();
  if (!agent) return failure(403, "state_scope_denied", "Current state authority is revoked");
  const pack = resolveAgentBehaviorConfig(agent).pack;
  if (!pack) return failure(404, "state_package_missing", "This agent has no package state");
  const runtime = resolvePackRuntime(pack.id, pack.version);
  const available = runtime.runnable ? (runtime.controlPlane.stateMigrations ?? []) : [];
  if (!migrationId) {
    const parsed = publicStateContracts["GET /workbench/state/migrations"].query.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) return failure(400, "state_query_invalid", "Invalid migration query");
    const scopeId = await runtimeStateScopeId(identity, pack.id, parsed.data.target);
    let after = "";
    if (parsed.data.cursor) {
      try {
        const cursor = JSON.parse(atob(parsed.data.cursor));
        if (
          cursor.scopeId !== scopeId ||
          typeof cursor.after !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(cursor.after)
        )
          throw new Error("cursor");
        after = cursor.after;
      } catch {
        return failure(400, "state_cursor_invalid", "Cursor does not belong to this query");
      }
    }
    const rows =
      await env.DB.prepare(`SELECT * FROM control_state_migrations WHERE scope_id = ? AND migration_key > ?
      AND EXISTS (${authoritySql} AND a.data_json = ?) ORDER BY migration_key LIMIT ?`)
        .bind(
          scopeId,
          after,
          identity.scope.userId,
          identity.scope.workspaceId,
          identity.agentId,
          agent.data_json,
          parsed.data.limit + 1,
        )
        .all<Parameters<typeof stateMigrationSummary>[0]>();
    const selected = rows.results.slice(0, parsed.data.limit);
    return json(
      publicStateContracts["GET /workbench/state/migrations"].response.parse({
        ok: true,
        available: available.map(({ id, namespace, kind, fromVersion, toVersion }) => ({
          id,
          namespace,
          kind,
          fromVersion,
          toVersion,
        })),
        migrations: selected.map(stateMigrationSummary),
        ...(rows.results.length > parsed.data.limit
          ? { nextCursor: btoa(JSON.stringify({ scopeId, after: selected.at(-1)!.migration_key })) }
          : {}),
      }),
    );
  }
  const contract =
    publicStateContracts[
      action === "repair"
        ? "POST /workbench/state/migrations/{id}/repair"
        : action === "advance"
          ? "POST /workbench/state/migrations/{id}/advance"
          : "POST /workbench/state/migrations/{id}"
    ];
  const body = await request.json().catch(() => null);
  const parsed = contract.request.safeParse(body);
  if (!parsed.success) return failure(400, "state_request_invalid", "Invalid migration command");
  const input = { packId: pack.id, target: parsed.data.target, agentSnapshot: agent.data_json };
  try {
    let migration;
    if (
      action === "advance" &&
      "expectedRevision" in parsed.data &&
      typeof parsed.data.expectedRevision === "number"
    )
      migration = await advanceRuntimeStateMigration(env, identity, {
        ...input,
        migrationId,
        expectedRevision: parsed.data.expectedRevision,
      });
    else if (action === "repair") {
      const repair =
        publicStateContracts["POST /workbench/state/migrations/{id}/repair"].request.parse(body);
      const replacement = available.find((item) => item.id === repair.replacementId);
      if (!runtime.runnable || !replacement)
        return failure(
          404,
          "state_migration_missing",
          "No reviewed replacement is registered for this agent",
        );
      migration = await repairRuntimeStateMigration(env, identity, {
        ...input,
        migrationId,
        expectedRevision: repair.expectedRevision,
        idempotencyKey: repair.idempotencyKey,
        replacement,
        definitions: runtime.controlPlane.state ?? [],
      });
    } else {
      const definition = available.find((item) => item.id === migrationId);
      if (!runtime.runnable || !definition)
        return failure(
          404,
          "state_migration_missing",
          "No reviewed migration is registered for this agent",
        );
      migration = await startRuntimeStateMigration(env, identity, {
        ...input,
        definitions: runtime.controlPlane.state ?? [],
        migration: definition,
      });
    }
    return json(contract.response.parse({ ok: true, migration }), { status: contract.status });
  } catch (error) {
    const code = String(error).includes("workspace_export_in_progress")
      ? "workspace_export_in_progress"
      : error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "state_migration_failed";
    const status =
      code === "state_scope_denied"
        ? 403
        : code === "state_migration_missing"
          ? 404
          : code.includes("conflict") || code === "workspace_export_in_progress"
            ? 409
            : code === "state_migration_failed"
              ? 500
              : 422;
    return failure(
      status,
      code,
      "Migration command failed; inspect canonical progress before retrying",
    );
  }
};

/** Operator reads never require the package's executable handler to still be installed. */
export const handleRuntimeStateOperation = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  resource: "records" | "entries" | "deliveries",
  retryId?: string,
) => {
  const actor = [identity.scope.userId, identity.scope.workspaceId, identity.agentId];
  const agent = await env.DB.prepare(authoritySql)
    .bind(...actor)
    .first<AgentRow & { role: string }>();
  if (!agent) return failure(403, "state_scope_denied", "Current state authority is revoked");
  const pack = resolveAgentBehaviorConfig(agent).pack;
  if (!pack) return failure(404, "state_package_missing", "This agent has no package state");

  // This predicate is evaluated again within every read/transaction, including an unchanged
  // package snapshot. Revocation or an intervening upgrade cannot authorize a stale request.
  const liveAuthority = `EXISTS (${authoritySql} AND a.data_json = ?${retryId ? " AND lower(m.role) IN ('owner', 'admin')" : ""})`;
  const liveBindings = [...actor, agent.data_json];
  if (retryId) {
    if (!["owner", "admin"].includes(agent.role.toLowerCase()))
      return failure(403, "state_retry_forbidden", "Workspace admin role is required");
    const parsed = publicStateContracts[
      "POST /workbench/state/deliveries/{id}/retry"
    ].request.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return failure(400, "state_request_invalid", "Invalid retry request");
    const { target, expectedAttempts } = parsed.data;
    const scopeId = await runtimeStateScopeId(identity, pack.id, target);
    const condition = `id = ? AND scope_id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?
      AND status = 'failed' AND attempts = ? AND ${liveAuthority}`;
    const bindings = [retryId, scopeId, ...actor, expectedAttempts, ...liveBindings];
    const eventId = `state-retry:${await sha256Hex(JSON.stringify([scopeId, retryId, expectedAttempts]))}`;
    try {
      const result = await env.DB.batch([
        env.DB.prepare(`INSERT INTO control_plane_events
          (id, user_id, workspace_id, agent_id, type, summary, target_type, target_id, data_json, created_at)
          SELECT ?, user_id, workspace_id, agent_id, 'state.delivery_retry',
            'Operator requested state event delivery retry.', 'stateDelivery', id,
            json_object('attempts', attempts, 'commitId', commit_id), ?
          FROM control_state_outbox WHERE ${condition}
          ON CONFLICT(id) DO NOTHING`).bind(eventId, new Date().toISOString(), ...bindings),
        env.DB.prepare(
          `UPDATE control_state_outbox SET status = 'pending' WHERE ${condition}`,
        ).bind(...bindings),
      ]);
      if (result[1]?.meta?.changes !== 1)
        return failure(
          409,
          "state_delivery_conflict",
          "Delivery changed or retry authority was revoked; refresh before retrying",
        );
    } catch (error) {
      if (error instanceof Error && error.message.includes("workspace_export_in_progress"))
        return failure(
          409,
          "workspace_export_in_progress",
          "Retry after the workspace export completes",
        );
      throw error;
    }
    // Attempts are never reset. After exhaustion, each operator retry grants one more attempt;
    // a delayed duplicate cannot reopen a later failed attempt using an old expectedAttempts.
    return json({ ok: true, id: retryId, status: "pending" }, { status: 202 });
  }

  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  // Duplicate query fields are ambiguous across frontends/proxies; fail closed.
  if ([...url.searchParams.keys()].length !== Object.keys(query).length)
    return failure(400, "state_query_invalid", "Duplicate query fields are not supported");
  const contract = publicStateContracts[`GET /workbench/state/${resource}`];
  const parsed = contract.query.safeParse(query);
  if (!parsed.success) return failure(400, "state_query_invalid", "Invalid state query");
  const input = parsed.data;
  const scopeId = await runtimeStateScopeId(identity, pack.id, input.target);
  const fingerprint = await sha256Hex(
    JSON.stringify([
      scopeId,
      resource,
      "namespace" in input ? input.namespace : null,
      "kind" in input ? input.kind : null,
      "type" in input ? input.type : null,
      "status" in input ? input.status : null,
    ]),
  );
  let after = "";
  if (input.cursor) {
    try {
      const cursor = JSON.parse(atob(input.cursor));
      if (
        cursor.fingerprint !== fingerprint ||
        typeof cursor.after !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(cursor.after)
      )
        throw new Error("cursor");
      after = cursor.after;
    } catch {
      return failure(400, "state_cursor_invalid", "Cursor does not belong to this query");
    }
  }
  const table = {
    records: "control_state_records",
    entries: "control_state_entries",
    deliveries: "control_state_outbox",
  }[resource];
  const key = ({ records: "record_key", entries: "entry_key", deliveries: "event_key" } as const)[
    resource
  ];
  const clauses = [
    "scope_id = ?",
    "user_id = ?",
    "workspace_id = ?",
    "agent_id = ?",
    `${key} > ?`,
    liveAuthority,
  ];
  const bindings: unknown[] = [scopeId, ...actor, after, ...liveBindings];
  if ("namespace" in input) {
    clauses.push("namespace = ?", "kind = ?");
    bindings.push(input.namespace, input.kind);
  }
  if ("type" in input && input.type) {
    clauses.push("type = ?");
    bindings.push(input.type);
  }
  if ("status" in input && input.status) {
    clauses.push("status = ?");
    bindings.push(input.status);
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE ${clauses.join(" AND ")} ORDER BY ${key} LIMIT ?`,
  )
    .bind(...bindings, input.limit + 1)
    .all<StateRow>();
  const selected = rows.results.slice(0, input.limit);
  const items = selected.map((row) => {
    const common = { id: row.id, data: JSON.parse(row.data_json) };
    if (resource === "records")
      return {
        ...common,
        namespace: row.namespace,
        kind: row.kind,
        key: row.record_key,
        schemaVersion: row.schema_version,
        version: row.version,
        updatedAt: row.updated_at,
      };
    if (resource === "entries")
      return {
        ...common,
        key: row.entry_key,
        commitId: row.commit_id,
        type: row.type,
        createdAt: row.created_at,
      };
    return {
      ...common,
      eventId: row.event_key,
      commitId: row.commit_id,
      type: row.type,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
    };
  });
  const response = {
    ok: true,
    [resource]: items,
    ...(rows.results.length > input.limit
      ? { nextCursor: btoa(JSON.stringify({ fingerprint, after: selected.at(-1)![key] })) }
      : {}),
  };
  return json(contract.response.parse(response));
};
