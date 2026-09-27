import {
  assertSchemaDefinition,
  assertSchemaValue,
  type RuntimeStateCommit,
  type RuntimeStateDefinition,
  type RuntimeStateKey,
  type RuntimeStatePort,
  type RuntimeStateReceipt,
  type RuntimeStateRecord,
} from "@operloom/agent-sdk";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import { durableAttemptGuard, type DurableAttemptAuthority } from "./durable-attempt-authority";
import type { AgentIdentity, Env } from "./types";
import { actionProjectionStatements } from "./action-resources";

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined || (typeof value === "number" && !Number.isFinite(value)))
      fail("state_invalid_json", "State must contain finite JSON values");
    return result!;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};
const recordKey = (key: RuntimeStateKey) => stableJson([key.namespace, key.kind, key.key]);
export { stableJson as runtimeStateCanonicalJson };
export const runtimeStateScopeId = (
  identity: AgentIdentity,
  packId: string,
  target: "simulation" | "external",
) =>
  sha256Hex(
    stableJson([
      identity.scope.userId,
      identity.scope.workspaceId,
      identity.agentId,
      packId,
      target,
    ]),
  );
type StoredRecord = {
  namespace: string;
  kind: string;
  record_key: string;
  schema_version: number;
  version: number;
  data_json: string;
  updated_at: string;
};
const mapRecord = (row: StoredRecord): RuntimeStateRecord => ({
  namespace: row.namespace,
  kind: row.kind,
  key: row.record_key,
  schemaVersion: row.schema_version,
  version: row.version,
  data: JSON.parse(row.data_json),
  updatedAt: row.updated_at,
});

export const validateRuntimeStateDefinitions = (definitions: readonly RuntimeStateDefinition[]) => {
  if (definitions.length > 32)
    fail("state_schema_invalid", "At most 32 state definitions are supported");
  const seen = new Set<string>();
  for (const definition of definitions) {
    const key = `${definition.namespace}/${definition.kind}/${definition.schemaVersion}`;
    if (
      !identifier.test(definition.namespace) ||
      !identifier.test(definition.kind) ||
      !Number.isSafeInteger(definition.schemaVersion) ||
      definition.schemaVersion < 1 ||
      seen.has(key)
    )
      fail(
        "state_schema_invalid",
        "State declarations must have unique namespace/kind/version identities",
      );
    seen.add(key);
    assertSchemaDefinition(definition.schema, `state ${key}`);
    if (definition.schema.type !== "object")
      fail("state_schema_invalid", "State record schemas must be objects");
    if (
      (definition.indexes?.length ?? 0) > 4 ||
      new Set(definition.indexes?.map((index) => index.name)).size !==
        (definition.indexes?.length ?? 0)
    )
      fail("state_schema_invalid", "Declare at most four unique indexes per record kind");
    for (const index of definition.indexes ?? [])
      if (!identifier.test(index.name) || !identifier.test(index.field))
        fail(
          "state_schema_invalid",
          "Index names and top-level fields must be bounded identifiers",
        );
  }
};

/** Scope derives only from authorized server inputs. Version upgrades retain the same scope. */
export const createRuntimeStatePort = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    packId: string;
    target: "simulation" | "external";
    definitions: readonly RuntimeStateDefinition[];
    signal?: AbortSignal;
    runId?: string;
    contextSnapshotId?: string;
    durableAttempt?: DurableAttemptAuthority;
  },
): Promise<RuntimeStatePort> => {
  input = { ...input, durableAttempt: input.durableAttempt && { ...input.durableAttempt } };
  const attemptGuard = durableAttemptGuard(identity, input.runId, input.durableAttempt);
  validateRuntimeStateDefinitions(input.definitions);
  const scopeId = await runtimeStateScopeId(identity, input.packId, input.target);
  const scope = [identity.scope.userId, identity.scope.workspaceId, identity.agentId, scopeId];
  const check = () => input.signal?.throwIfAborted();
  const requireReadable = async () => {
    check();
    const authorized = await env.DB.prepare(`SELECT 1 AS allowed FROM memberships m
      JOIN workspaces w ON w.id = m.workspace_id JOIN users u ON u.id = m.user_id
      JOIN agents a ON a.workspace_id = w.id AND a.id = ?
      WHERE m.user_id = ? AND m.workspace_id = ? AND m.status = 'active' AND w.status = 'active' AND u.status = 'active' AND a.status = 'active' AND a.runtime_revision = ? AND ${attemptGuard.sql}`)
      .bind(
        identity.agentId,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentRevision ?? 0,
        ...attemptGuard.values,
      )
      .first();
    if (!authorized) fail("state_scope_denied", "Current state authority is revoked");
  };
  const declaration = (key: Pick<RuntimeStateKey, "namespace" | "kind">, version?: number) => {
    const candidates = input.definitions.filter(
      (definition) =>
        definition.namespace === key.namespace &&
        definition.kind === key.kind &&
        (version === undefined || definition.schemaVersion === version),
    );
    if (!candidates.length)
      return fail(
        "state_scope_denied",
        "The package has not declared this namespace, record kind or schema version",
      );
    return candidates.sort((a, b) => b.schemaVersion - a.schemaVersion)[0]!;
  };
  const validateKey = (key: RuntimeStateKey) => {
    declaration(key);
    if (!identifier.test(key.key))
      fail("state_key_invalid", "State key must be a bounded identifier");
  };
  const receiptFor = async (key: string) =>
    env.DB.prepare(
      "SELECT request_hash, receipt_json FROM control_state_commits WHERE scope_id = ? AND idempotency_key = ?",
    )
      .bind(scopeId, key)
      .first<{ request_hash: string; receipt_json: string }>();
  return {
    async get(key) {
      await requireReadable();
      validateKey(key);
      const row = await env.DB.prepare(
        "SELECT * FROM control_state_records WHERE scope_id = ? AND namespace = ? AND kind = ? AND record_key = ?",
      )
        .bind(scopeId, key.namespace, key.kind, key.key)
        .first<StoredRecord>();
      return row ? mapRecord(row) : null;
    },
    async list(query) {
      await requireReadable();
      const definition = declaration(query);
      const limit = Math.max(1, Math.min(100, Math.trunc(query.limit ?? 50)));
      if (!Number.isFinite(limit)) fail("state_query_invalid", "List limit must be finite");
      const fingerprint = await sha256Hex(
        stableJson([scopeId, query.namespace, query.kind, query.index ?? null]),
      );
      let after = "";
      if (query.cursor) {
        try {
          const parsed = JSON.parse(atob(query.cursor)) as { fingerprint: string; after: string };
          if (parsed.fingerprint !== fingerprint || !identifier.test(parsed.after))
            throw new Error("cursor");
          after = parsed.after;
        } catch {
          fail("state_cursor_invalid", "Cursor does not belong to this query");
        }
      }
      const index = query.index
        ? definition.indexes?.find((item) => item.name === query.index!.name)
        : undefined;
      if (query.index && !index)
        fail("state_index_invalid", "Query references an undeclared index");
      const rows = await env.DB.prepare(
        `SELECT * FROM control_state_records record WHERE scope_id = ? AND namespace = ? AND kind = ? AND record_key > ?${index ? " AND EXISTS (SELECT 1 FROM control_state_indexes i WHERE i.scope_id = record.scope_id AND i.namespace = record.namespace AND i.kind = record.kind AND i.record_key = record.record_key AND i.index_name = ? AND i.value_json = ?)" : ""} ORDER BY record_key LIMIT ?`,
      )
        .bind(
          scopeId,
          query.namespace,
          query.kind,
          after,
          ...(index ? [index.name, stableJson(query.index!.value)] : []),
          limit + 1,
        )
        .all<StoredRecord>();
      const records = rows.results.slice(0, limit).map(mapRecord);
      return {
        records,
        ...(rows.results.length > limit
          ? { nextCursor: btoa(JSON.stringify({ fingerprint, after: records.at(-1)!.key })) }
          : {}),
      };
    },
    async commit(commit: RuntimeStateCommit) {
      check();
      if (!identifier.test(commit.idempotencyKey))
        fail("state_key_invalid", "Commit idempotency key must be a bounded identifier");
      if (
        commit.reads.length > 32 ||
        commit.writes.length > 32 ||
        (commit.entries?.length ?? 0) > 16 ||
        (commit.events?.length ?? 0) > 16
      )
        fail("state_quota_exceeded", "Commit exceeds bounded operation limits");
      const serialized = stableJson(commit);
      if (new TextEncoder().encode(serialized).length > 65536)
        fail("state_quota_exceeded", "Commit exceeds 64 KiB");
      const reads = new Map<string, number>();
      for (const read of commit.reads) {
        validateKey(read);
        if (!Number.isSafeInteger(read.version) || read.version < 0 || reads.has(recordKey(read)))
          fail(
            "state_precondition_invalid",
            "Read versions must be explicit, nonnegative and unique",
          );
        reads.set(recordKey(read), read.version);
      }
      const writes = new Set<string>();
      for (const write of commit.writes) {
        validateKey(write);
        const definition = declaration(write, write.schemaVersion);
        if (!reads.has(recordKey(write)) || writes.has(recordKey(write)))
          fail(
            "state_precondition_invalid",
            "Each write requires exactly one explicit read version",
          );
        writes.add(recordKey(write));
        assertSchemaValue(definition.schema, write.data, `state ${write.namespace}/${write.kind}`);
      }
      for (const entry of [...(commit.entries ?? []), ...(commit.events ?? [])])
        if (!identifier.test(entry.id))
          fail("state_key_invalid", "Evidence and event identities must be bounded identifiers");
      const hash = await sha256Hex(serialized);
      const replay = (existing: {
        request_hash: string;
        receipt_json: string;
      }): RuntimeStateReceipt => {
        if (existing.request_hash !== hash)
          return fail("idempotency_conflict", "Commit key was already used with different content");
        return JSON.parse(existing.receipt_json) as RuntimeStateReceipt;
      };
      const previous = await receiptFor(commit.idempotencyKey);
      if (previous) {
        await requireReadable();
        return replay(previous);
      }
      const now = new Date().toISOString();
      const id = `state-commit-${crypto.randomUUID()}`;
      const receipt: RuntimeStateReceipt = {
        id,
        committedAt: now,
        records: commit.writes.map((write) => ({
          namespace: write.namespace,
          kind: write.kind,
          key: write.key,
          version: reads.get(recordKey(write))! + 1,
        })),
        entryIds: commit.entries?.map((entry) => entry.id) ?? [],
        eventIds: commit.events?.map((event) => event.id) ?? [],
      };
      // Keep the authority branches separate: a long AND chain exceeds D1's
      // expression-depth limit once durable checks are combined.
      const statements = [
        env.DB.prepare(`INSERT INTO control_state_commits
        (id, user_id, workspace_id, agent_id, scope_id, idempotency_key, request_hash, receipt_json, created_at, preconditions_met)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ${attemptGuard.sql} THEN CASE WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND status = 'active')
          AND EXISTS (SELECT 1 FROM memberships WHERE user_id = ? AND workspace_id = ? AND status = 'active')
          AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')
          AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND workspace_id = ? AND status = 'active' AND runtime_revision = ?)
          AND (? IS NULL OR EXISTS (SELECT 1 FROM control_runs WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ? AND status = 'running'))
          AND NOT EXISTS (SELECT 1 FROM control_kill_switches WHERE user_id = ? AND workspace_id = ? AND enabled = 1 AND ((scope_kind = 'workspace' AND scope_id = ?) OR (scope_kind = 'pack' AND scope_id = ?)))
          AND NOT EXISTS (SELECT 1 FROM json_each(?) expected
            LEFT JOIN control_state_records record ON record.scope_id = ?
              AND record.namespace = json_extract(expected.value, '$.namespace')
              AND record.kind = json_extract(expected.value, '$.kind')
              AND record.record_key = json_extract(expected.value, '$.key')
            WHERE COALESCE(record.version, 0) != json_extract(expected.value, '$.version'))
          AND NOT EXISTS (SELECT 1 FROM json_each(?) expected JOIN control_state_records record ON record.scope_id = ?
              AND record.namespace = json_extract(expected.value, '$.namespace')
              AND record.kind = json_extract(expected.value, '$.kind')
              AND record.record_key = json_extract(expected.value, '$.key')
            WHERE record.schema_version != json_extract(expected.value, '$.schemaVersion'))
          AND NOT EXISTS (SELECT 1 FROM json_each(?) expected JOIN control_state_schema_heads head ON head.scope_id = ?
            AND head.namespace = json_extract(expected.value, '$.namespace') AND head.kind = json_extract(expected.value, '$.kind')
            WHERE head.status != 'active' OR head.schema_version != json_extract(expected.value, '$.schemaVersion'))
          AND (? IS NULL OR EXISTS (SELECT 1 FROM control_context_snapshots snapshot WHERE snapshot.id = ?
            AND snapshot.user_id = ? AND snapshot.workspace_id = ? AND snapshot.agent_id = ? AND snapshot.status = 'ready'
            AND snapshot.agent_revision = ? AND snapshot.pack_id = ? AND json_extract(snapshot.snapshot_json, '$.target') = ?
            AND (? IS NULL OR snapshot.run_id = ?) AND NOT EXISTS (SELECT 1 FROM json_each(snapshot.snapshot_json, '$.sources') source
              WHERE json_extract(source.value, '$.required') = 1 AND
                (json_extract(source.value, '$.status') != 'fresh' OR json_extract(source.value, '$.expiresAt') <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))))
          AND (SELECT COUNT(*) FROM control_state_records WHERE scope_id = ?) + ? <= 10000
          THEN 1 ELSE 0 END ELSE 0 END`).bind(
          id,
          ...scope,
          commit.idempotencyKey,
          hash,
          JSON.stringify(receipt),
          now,
          ...attemptGuard.values,
          identity.scope.workspaceId,
          identity.scope.userId,
          identity.scope.workspaceId,
          identity.scope.userId,
          identity.agentId,
          identity.scope.workspaceId,
          identity.agentRevision ?? 0,
          input.runId ?? null,
          input.runId ?? null,
          identity.scope.userId,
          identity.scope.workspaceId,
          identity.agentId,
          identity.scope.userId,
          identity.scope.workspaceId,
          identity.scope.workspaceId,
          input.packId,
          JSON.stringify(commit.reads),
          scopeId,
          JSON.stringify(commit.writes),
          scopeId,
          JSON.stringify(commit.writes),
          scopeId,
          input.contextSnapshotId ?? null,
          input.contextSnapshotId ?? null,
          identity.scope.userId,
          identity.scope.workspaceId,
          identity.agentId,
          identity.agentRevision ?? 0,
          input.packId,
          input.target,
          input.runId ?? null,
          input.runId ?? null,
          scopeId,
          commit.writes.filter((write) => reads.get(recordKey(write)) === 0).length,
        ),
      ];
      statements.push(
        ...actionProjectionStatements(env, {
          identity,
          target: input.target,
          packId: input.packId,
          scopeId,
          commit,
          commitId: id,
          now,
        }),
      );
      for (const write of commit.writes)
        statements.push(
          env.DB.prepare(`INSERT INTO control_state_records
        (id, user_id, workspace_id, agent_id, scope_id, namespace, kind, record_key, schema_version, version, data_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, namespace, kind, record_key) DO UPDATE SET version = excluded.version, data_json = excluded.data_json, updated_at = excluded.updated_at`).bind(
            `state-${await sha256Hex(scopeId + recordKey(write))}`,
            ...scope,
            write.namespace,
            write.kind,
            write.key,
            write.schemaVersion,
            reads.get(recordKey(write))! + 1,
            stableJson(write.data),
            now,
          ),
        );
      for (const write of commit.writes) {
        const definition = declaration(write, write.schemaVersion);
        statements.push(
          env.DB.prepare(
            "DELETE FROM control_state_indexes WHERE scope_id = ? AND namespace = ? AND kind = ? AND record_key = ?",
          ).bind(scopeId, write.namespace, write.kind, write.key),
        );
        for (const index of definition.indexes ?? []) {
          const value = write.data[index.field];
          if (value === undefined) continue;
          if (value !== null && !["string", "number", "boolean"].includes(typeof value))
            fail("state_index_invalid", "Indexed fields must be scalar JSON values");
          statements.push(
            env.DB.prepare(
              "INSERT INTO control_state_indexes (id, user_id, workspace_id, agent_id, scope_id, namespace, kind, record_key, index_name, value_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).bind(
              `index-${await sha256Hex(scopeId + recordKey(write) + index.name)}`,
              ...scope,
              write.namespace,
              write.kind,
              write.key,
              index.name,
              stableJson(value),
            ),
          );
        }
      }
      for (const entry of commit.entries ?? [])
        statements.push(
          env.DB.prepare(
            `INSERT INTO control_state_entries (id, user_id, workspace_id, agent_id, scope_id, entry_key, commit_id, type, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            `entry-${await sha256Hex(scopeId + entry.id)}`,
            ...scope,
            entry.id,
            id,
            entry.type,
            stableJson(entry.data),
            now,
          ),
        );
      for (const event of commit.events ?? [])
        statements.push(
          env.DB.prepare(
            `INSERT INTO control_state_outbox (id, user_id, workspace_id, agent_id, scope_id, event_key, commit_id, type, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            `outbox-${await sha256Hex(scopeId + event.id)}`,
            ...scope,
            event.id,
            id,
            event.type,
            stableJson(event.data),
            now,
          ),
        );
      check();
      try {
        await env.DB.batch(statements);
      } catch (error) {
        const concurrent = await receiptFor(commit.idempotencyKey);
        if (concurrent) {
          await requireReadable();
          return replay(concurrent);
        }
        if (
          error instanceof Error &&
          /action_resource|action_projection|control_action_projections/.test(error.message)
        )
          fail(
            "action_projection_conflict",
            "Resource capacity, projection identity or authority changed; inspect the action and reload state",
          );
        if (error instanceof Error && error.message.includes("state_precondition"))
          fail(
            "state_conflict",
            "State, schema, quota or execution authority changed; reload before proposing another commit",
          );
        throw error;
      }
      return receipt;
    },
  };
};
