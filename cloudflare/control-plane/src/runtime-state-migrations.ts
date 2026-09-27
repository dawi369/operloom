import {
  assertRuntimeStateMigrations,
  assertSchemaValue,
  transformRuntimeState,
  type RuntimeStateDefinition,
  type RuntimeStateMigration,
} from "@operloom/agent-sdk";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import {
  runtimeStateCanonicalJson,
  runtimeStateScopeId,
  validateRuntimeStateDefinitions,
} from "./runtime-state";
import type { AgentIdentity, Env } from "./types";

type MigrationRow = {
  id: string;
  migration_key: string;
  scope_id: string;
  namespace: string;
  kind: string;
  plan_hash: string;
  plan_json: string;
  from_version: number;
  to_version: number;
  status: "running" | "completed";
  revision: number;
  processed: number;
  after_key: string;
};
export const stateMigrationSummary = (row: MigrationRow) => ({
  id: row.migration_key,
  planId: (JSON.parse(row.plan_json) as { migration: { id: string } }).migration.id,
  namespace: row.namespace,
  kind: row.kind,
  fromVersion: row.from_version,
  toVersion: row.to_version,
  status: row.status,
  revision: row.revision,
  processed: row.processed,
});
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
const authority = `EXISTS (SELECT 1 FROM memberships m
  JOIN users u ON u.id = m.user_id AND u.status = 'active'
  JOIN workspaces w ON w.id = m.workspace_id AND w.status = 'active'
  JOIN agents a ON a.workspace_id = w.id AND a.id = ? AND a.status = 'active' AND a.data_json = ?
  WHERE m.user_id = ? AND m.workspace_id = ? AND m.status = 'active' AND lower(m.role) IN ('admin','owner'))`;
type ScopeInput = { packId: string; target: "simulation" | "external"; agentSnapshot: string };
const migrationScope = async (env: Env, identity: AgentIdentity, input: ScopeInput) => {
  const authorityBindings = [
    identity.agentId,
    input.agentSnapshot,
    identity.scope.userId,
    identity.scope.workspaceId,
  ];
  if (
    !(await env.DB.prepare(`SELECT 1 WHERE ${authority}`)
      .bind(...authorityBindings)
      .first())
  )
    fail("state_scope_denied", "Current migration authority is revoked");
  const scopeId = await runtimeStateScopeId(identity, input.packId, input.target);
  return {
    scopeId,
    authorityBindings,
    actor: [identity.scope.userId, identity.scope.workspaceId, identity.agentId],
  };
};

export const startRuntimeStateMigration = async (
  env: Env,
  identity: AgentIdentity,
  input: ScopeInput & {
    definitions: readonly RuntimeStateDefinition[];
    migration: RuntimeStateMigration;
  },
) => {
  const { scopeId, actor, authorityBindings } = await migrationScope(env, identity, input);
  validateRuntimeStateDefinitions(input.definitions);
  assertRuntimeStateMigrations(input.definitions, [input.migration]);
  const migration = input.migration;
  const definitions = input.definitions.filter(
    (definition) =>
      definition.namespace === migration.namespace &&
      definition.kind === migration.kind &&
      [migration.fromVersion, migration.toVersion].includes(definition.schemaVersion),
  );
  const plan = runtimeStateCanonicalJson({ migration, definitions });
  if (new TextEncoder().encode(plan).length > 65536)
    fail("state_migration_invalid", "Pinned migration plan exceeds 64 KiB");
  const hash = await sha256Hex(plan);
  const id = `migration-${await sha256Hex(runtimeStateCanonicalJson([scopeId, migration.id]))}`;
  const read = () =>
    env.DB.prepare("SELECT * FROM control_state_migrations WHERE id = ? AND scope_id = ?")
      .bind(id, scopeId)
      .first<MigrationRow>();
  const replay = async (row: MigrationRow) => {
    const wasReviewed =
      row.plan_hash === hash ||
      (await env.DB.prepare(`SELECT 1 FROM control_state_migration_repairs
      WHERE migration_id = ? AND (previous_plan_json = ? OR replacement_plan_json = ?) LIMIT 1`)
        .bind(row.id, plan, plan)
        .first());
    if (!wasReviewed)
      fail(
        "idempotency_conflict",
        "Migration identity already pins different schemas or transformations",
      );
    return stateMigrationSummary(row);
  };
  const previous = await read();
  if (previous) return replay(previous);
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO control_state_migrations
        (id,user_id,workspace_id,agent_id,scope_id,migration_key,plan_hash,plan_json,namespace,kind,from_version,to_version,status,created_at,updated_at,preconditions_met)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?, CASE WHEN ${authority}
          AND NOT EXISTS (SELECT 1 FROM control_state_schema_heads WHERE scope_id = ? AND namespace = ? AND kind = ? AND (status != 'active' OR schema_version != ?))
          AND NOT EXISTS (SELECT 1 FROM control_state_records WHERE scope_id = ? AND namespace = ? AND kind = ? AND schema_version != ?)
          THEN 1 ELSE 0 END)`).bind(
        id,
        ...actor,
        scopeId,
        migration.id,
        hash,
        plan,
        migration.namespace,
        migration.kind,
        migration.fromVersion,
        migration.toVersion,
        now,
        now,
        ...authorityBindings,
        scopeId,
        migration.namespace,
        migration.kind,
        migration.fromVersion,
        scopeId,
        migration.namespace,
        migration.kind,
        migration.fromVersion,
      ),
      env.DB.prepare(`INSERT INTO control_state_schema_heads
        (scope_id,namespace,kind,user_id,workspace_id,agent_id,schema_version,status,migration_id)
        VALUES (?,?,?,?,?,?,?,'migrating',?) ON CONFLICT(scope_id,namespace,kind)
        DO UPDATE SET status = 'migrating', migration_id = excluded.migration_id`).bind(
        scopeId,
        migration.namespace,
        migration.kind,
        ...actor,
        migration.fromVersion,
        id,
      ),
      env.DB.prepare(`INSERT INTO control_plane_events
        (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
        VALUES (?,?,?,?,'state.migration_started','State schema migration started.','stateMigration',?,?,?)`).bind(
        `${id}:start`,
        ...actor,
        id,
        JSON.stringify({ migrationId: migration.id, target: input.target, planHash: hash }),
        now,
      ),
    ]);
  } catch (error) {
    const concurrent = await read();
    if (concurrent) return replay(concurrent);
    if (String(error).includes("state_migration_precondition"))
      fail(
        "state_migration_conflict",
        "Schema, migration or authority changed; refresh before retrying",
      );
    throw error;
  }
  return stateMigrationSummary((await read())!);
};

/** Replace only the unprocessed suffix. Preserve completed records, schemas, cursor and history. */
export const repairRuntimeStateMigration = async (
  env: Env,
  identity: AgentIdentity,
  input: ScopeInput & {
    migrationId: string;
    expectedRevision: number;
    idempotencyKey: string;
    replacement: RuntimeStateMigration;
    definitions: readonly RuntimeStateDefinition[];
  },
) => {
  const { scopeId, actor, authorityBindings } = await migrationScope(env, identity, input);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.idempotencyKey)
  )
    fail("state_migration_invalid", "Repair requires a bounded command key and explicit revision");
  validateRuntimeStateDefinitions(input.definitions);
  assertRuntimeStateMigrations(input.definitions, [input.replacement]);
  const row = await env.DB.prepare(
    "SELECT * FROM control_state_migrations WHERE scope_id = ? AND migration_key = ?",
  )
    .bind(scopeId, input.migrationId)
    .first<MigrationRow>();
  if (!row) return fail("state_migration_missing", "Migration not found");
  const replacement = input.replacement;
  const definitions = input.definitions.filter(
    (definition) =>
      definition.namespace === replacement.namespace &&
      definition.kind === replacement.kind &&
      [replacement.fromVersion, replacement.toVersion].includes(definition.schemaVersion),
  );
  const plan = runtimeStateCanonicalJson({ migration: replacement, definitions });
  if (new TextEncoder().encode(plan).length > 65536)
    fail("state_migration_invalid", "Pinned repair plan exceeds 64 KiB");
  const hash = await sha256Hex(plan);
  const requestHash = await sha256Hex(runtimeStateCanonicalJson([input.expectedRevision, hash]));
  const readReceipt = () =>
    env.DB.prepare(
      "SELECT request_hash,receipt_json FROM control_state_migration_repairs WHERE migration_id = ? AND idempotency_key = ?",
    )
      .bind(row.id, input.idempotencyKey)
      .first<{ request_hash: string; receipt_json: string }>();
  const replay = (receipt: { request_hash: string; receipt_json: string }) => {
    if (receipt.request_hash !== requestHash)
      fail("idempotency_conflict", "Repair command key was used with different content");
    return JSON.parse(receipt.receipt_json) as ReturnType<typeof stateMigrationSummary>;
  };
  const previous = await readReceipt();
  if (previous) return replay(previous);
  if (row.status !== "running" || row.revision !== input.expectedRevision)
    fail("state_migration_conflict", "Refresh migration progress before repair");
  const oldPlan = JSON.parse(row.plan_json) as {
    migration: RuntimeStateMigration;
    definitions: RuntimeStateDefinition[];
  };
  const ordered = (values: readonly RuntimeStateDefinition[]) =>
    [...values].sort((a, b) => a.schemaVersion - b.schemaVersion);
  if (
    replacement.id === oldPlan.migration.id ||
    replacement.namespace !== row.namespace ||
    replacement.kind !== row.kind ||
    replacement.fromVersion !== row.from_version ||
    replacement.toVersion !== row.to_version ||
    runtimeStateCanonicalJson(ordered(definitions)) !==
      runtimeStateCanonicalJson(ordered(oldPlan.definitions))
  )
    fail(
      "state_migration_invalid",
      "Repair needs a new reviewed plan ID with unchanged source/destination schemas and indexes",
    );
  const result = stateMigrationSummary({ ...row, plan_json: plan, revision: row.revision + 1 });
  const now = new Date().toISOString();
  const id = `migration-repair-${await sha256Hex(runtimeStateCanonicalJson([row.id, input.idempotencyKey]))}`;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO control_state_migration_repairs
        (id,user_id,workspace_id,agent_id,migration_id,idempotency_key,request_hash,previous_plan_json,replacement_plan_json,expected_revision,receipt_json,created_at,preconditions_met)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ${authority}
          AND EXISTS (SELECT 1 FROM control_state_migrations WHERE id = ? AND revision = ? AND plan_hash = ? AND status = 'running')
          AND EXISTS (SELECT 1 FROM control_state_schema_heads WHERE migration_id = ? AND status = 'migrating')
          THEN 1 ELSE 0 END)`).bind(
        id,
        ...actor,
        row.id,
        input.idempotencyKey,
        requestHash,
        row.plan_json,
        plan,
        row.revision,
        JSON.stringify(result),
        now,
        ...authorityBindings,
        row.id,
        row.revision,
        row.plan_hash,
        row.id,
      ),
      env.DB.prepare(
        "UPDATE control_state_migrations SET plan_hash = ?,plan_json = ?,revision = revision + 1,updated_at = ? WHERE id = ?",
      ).bind(hash, plan, now, row.id),
      env.DB.prepare(`INSERT INTO control_plane_events
        (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
        VALUES (?,?,?,?,'state.migration_repaired','Reviewed migration repair accepted.','stateMigration',?,?,?)`).bind(
        id,
        ...actor,
        row.id,
        JSON.stringify({ ...result, repairId: id, previousPlanId: oldPlan.migration.id }),
        now,
      ),
    ]);
  } catch (error) {
    const concurrent = await readReceipt();
    if (concurrent) {
      await migrationScope(env, identity, input);
      return replay(concurrent);
    }
    if (String(error).includes("state_migration_repair_precondition"))
      fail("state_migration_conflict", "Migration or repair authority changed");
    throw error;
  }
  return result;
};

export const advanceRuntimeStateMigration = async (
  env: Env,
  identity: AgentIdentity,
  input: ScopeInput & { migrationId: string; expectedRevision: number },
) => {
  const { scopeId, actor, authorityBindings } = await migrationScope(env, identity, input);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    fail("state_migration_invalid", "Expected revision must be a nonnegative integer");
  const row = await env.DB.prepare(
    "SELECT * FROM control_state_migrations WHERE scope_id = ? AND migration_key = ?",
  )
    .bind(scopeId, input.migrationId)
    .first<MigrationRow>();
  if (!row) return fail("state_migration_missing", "Migration not found");
  const receipt = () =>
    env.DB.prepare(
      "SELECT receipt_json FROM control_state_migration_steps WHERE migration_id = ? AND expected_revision = ?",
    )
      .bind(row.id, input.expectedRevision)
      .first<{ receipt_json: string }>();
  const previous = await receipt();
  if (previous)
    return JSON.parse(previous.receipt_json) as ReturnType<typeof stateMigrationSummary>;
  if (row.status !== "running" || row.revision !== input.expectedRevision)
    fail("state_migration_conflict", "Refresh migration progress before advancing");
  const plan = JSON.parse(row.plan_json) as {
    migration: RuntimeStateMigration;
    definitions: RuntimeStateDefinition[];
  };
  const from = plan.definitions.find(
    (definition) => definition.schemaVersion === row.from_version,
  )!;
  const to = plan.definitions.find((definition) => definition.schemaVersion === row.to_version)!;
  const rows =
    await env.DB.prepare(`SELECT id, record_key, version, data_json FROM control_state_records
    WHERE scope_id = ? AND namespace = ? AND kind = ? AND record_key > ? ORDER BY record_key LIMIT 17`)
      .bind(scopeId, row.namespace, row.kind, row.after_key)
      .all<{ id: string; record_key: string; version: number; data_json: string }>();
  let bytes = 0;
  const selected = [];
  for (const record of rows.results.slice(0, 16)) {
    let data;
    try {
      const source = JSON.parse(record.data_json);
      assertSchemaValue(from.schema, source, "migration source");
      data = transformRuntimeState(plan.migration, to, source);
    } catch {
      return fail(
        "state_migration_transform_invalid",
        "Source or transformed record failed its pinned schema or transformation",
      );
    }
    const serialized = runtimeStateCanonicalJson(data);
    const size = new TextEncoder().encode(serialized).length;
    if (size > 65536) fail("state_migration_invalid", "Migrated record exceeds 64 KiB");
    if (bytes + size > 65536 && selected.length) break;
    bytes += size;
    selected.push({ ...record, data, serialized });
  }
  const completed = rows.results.length === selected.length;
  const result = stateMigrationSummary({
    ...row,
    revision: row.revision + 1,
    processed: row.processed + selected.length,
    status: completed ? "completed" : "running",
  });
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(`INSERT INTO control_state_migration_steps
    (id,user_id,workspace_id,agent_id,migration_id,expected_revision,receipt_json,created_at,preconditions_met)
    VALUES (?,?,?,?,?,?,?,?,CASE WHEN ${authority}
      AND EXISTS (SELECT 1 FROM control_state_migrations WHERE id = ? AND revision = ? AND status = 'running')
      AND EXISTS (SELECT 1 FROM control_state_schema_heads WHERE migration_id = ? AND status = 'migrating')
      AND NOT EXISTS (SELECT 1 FROM json_each(?) expected LEFT JOIN control_state_records r ON r.id = json_extract(expected.value,'$.id')
        WHERE r.version IS NULL OR r.version != json_extract(expected.value,'$.version') OR r.schema_version != ?)
      THEN 1 ELSE 0 END)`).bind(
      `${row.id}:${row.revision}`,
      ...actor,
      row.id,
      row.revision,
      JSON.stringify(result),
      now,
      ...authorityBindings,
      row.id,
      row.revision,
      row.id,
      JSON.stringify(selected.map(({ id, version }) => ({ id, version }))),
      row.from_version,
    ),
  ];
  for (const record of selected) {
    statements.push(
      env.DB.prepare(
        `UPDATE control_state_records SET schema_version = ?, version = version + 1, data_json = ?, updated_at = ? WHERE id = ?`,
      ).bind(row.to_version, record.serialized, now, record.id),
    );
    statements.push(
      env.DB.prepare(
        "DELETE FROM control_state_indexes WHERE scope_id = ? AND namespace = ? AND kind = ? AND record_key = ?",
      ).bind(scopeId, row.namespace, row.kind, record.record_key),
    );
    for (const index of to.indexes ?? []) {
      const value = record.data[index.field];
      if (value === undefined) continue;
      if (value !== null && !["string", "number", "boolean"].includes(typeof value))
        fail("state_index_invalid", "Migrated index must be scalar");
      statements.push(
        env.DB.prepare(`INSERT INTO control_state_indexes
        (id,user_id,workspace_id,agent_id,scope_id,namespace,kind,record_key,index_name,value_json) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
          `index-${await sha256Hex(scopeId + runtimeStateCanonicalJson([row.namespace, row.kind, record.record_key]) + index.name)}`,
          ...actor,
          scopeId,
          row.namespace,
          row.kind,
          record.record_key,
          index.name,
          runtimeStateCanonicalJson(value),
        ),
      );
    }
  }
  statements.push(
    env.DB.prepare(
      "UPDATE control_state_migrations SET revision = ?, processed = ?, status = ?, after_key = ?, updated_at = ? WHERE id = ?",
    ).bind(
      result.revision,
      result.processed,
      result.status,
      selected.at(-1)?.record_key ?? row.after_key,
      now,
      row.id,
    ),
  );
  if (completed)
    statements.push(
      env.DB.prepare(
        "UPDATE control_state_schema_heads SET status = 'active', schema_version = ? WHERE migration_id = ?",
      ).bind(row.to_version, row.id),
    );
  statements.push(
    env.DB.prepare(`INSERT INTO control_plane_events
    (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
    VALUES (?,?,?,?,'state.migration_progress','State schema migration advanced.','stateMigration',?,?,?)`).bind(
      `${row.id}:step:${row.revision}`,
      ...actor,
      row.id,
      JSON.stringify(result),
      now,
    ),
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const concurrent = await receipt();
    if (concurrent) return JSON.parse(concurrent.receipt_json) as typeof result;
    if (String(error).includes("state_migration_step_precondition"))
      fail("state_migration_conflict", "Migration progress or authority changed");
    throw error;
  }
  return result;
};
