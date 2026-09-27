import { assertSchemaValue, type RuntimeStateDefinition } from "@operloom/agent-sdk";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import {
  publicUpgradeContracts,
  type PackageUpgradeResponse,
} from "../../../packages/workbench-client/src/public-upgrade-contracts";
import {
  createAgentBehaviorSnapshotFromTemplate,
  toPackTemplate,
} from "./agent-behavior-templates";
import { resolveAgentBehaviorConfig } from "./agent-records";
import { runtimeUsageCapabilitiesEnabled } from "./runtime-usage";
import { demoPackAllowed } from "./demo-policy";
import { json } from "./http";
import { runtimeStateCanonicalJson, validateRuntimeStateDefinitions } from "./runtime-state";
import type { AgentIdentity, AgentRow, Env } from "./types";

const authority = `SELECT a.* FROM agents a
  JOIN workspaces w ON w.id = a.workspace_id AND w.status = 'active'
  JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ? AND m.status = 'active' AND lower(m.role) IN ('owner','admin')
  JOIN users u ON u.id = m.user_id AND u.status = 'active'
  WHERE a.workspace_id = ? AND a.id = ? AND a.status = 'active'`;
const actor = (identity: AgentIdentity) => [
  identity.scope.userId,
  identity.scope.workspaceId,
  identity.agentId,
];
const failure = (status: number, code: string, error: string) =>
  json({ ok: false, code, error }, { status });
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
type UpgradeAgent = AgentRow & { upgrade_validation_revision: number };
const installedManifest = (env: Env, packId: string) => {
  const entry = agentManifestRegistry[packId as keyof typeof agentManifestRegistry];
  return entry &&
    (!entry.conformanceOnly ||
      env.WORKBENCH_E2E_MODE === "true" ||
      env.WORKBENCH_CONFORMANCE_MODE === "true") &&
    demoPackAllowed(env, packId)
    ? entry.module
    : null;
};

/** Preflight is read-only. The transaction subsequently checks its database-maintained epoch. */
const validateRetainedState = async (
  env: Env,
  identity: AgentIdentity,
  definitions: readonly RuntimeStateDefinition[],
) => {
  validateRuntimeStateDefinitions(definitions);
  const definitionFor = (row: { namespace: string; kind: string; schema_version: number }) =>
    definitions.find(
      (d) =>
        d.namespace === row.namespace &&
        d.kind === row.kind &&
        d.schemaVersion === row.schema_version,
    ) ??
    fail(
      "agent_upgrade_state_incompatible",
      "The destination must retain every stored schema version; run reviewed migrations first.",
    );
  const scope = [identity.scope.workspaceId, identity.agentId];
  const heads =
    await env.DB.prepare(`SELECT DISTINCT namespace, kind, schema_version, status FROM control_state_schema_heads
    WHERE workspace_id = ? AND agent_id = ? LIMIT 65`)
      .bind(...scope)
      .all<{ namespace: string; kind: string; schema_version: number; status: string }>();
  if (heads.results.length > 64)
    fail(
      "agent_upgrade_validation_limit",
      "Too many retained schema heads for one upgrade command.",
    );
  for (const head of heads.results) {
    if (head.status !== "active")
      fail("agent_runtime_revision_busy", "Finish active state migrations before upgrading.");
    definitionFor(head);
  }
  let after = "",
    count = 0,
    bytes = 0;
  for (;;) {
    const page = await env.DB.prepare(`SELECT r.*,
      (SELECT json_group_array(json_object('name', i.index_name, 'value', json(i.value_json)))
        FROM control_state_indexes i WHERE i.scope_id = r.scope_id AND i.namespace = r.namespace
          AND i.kind = r.kind AND i.record_key = r.record_key) AS indexes_json
      FROM control_state_records r WHERE r.workspace_id = ? AND r.agent_id = ? AND r.id > ? ORDER BY r.id LIMIT 16`)
      .bind(...scope, after)
      .all<{
        id: string;
        namespace: string;
        kind: string;
        schema_version: number;
        data_json: string;
        indexes_json: string;
      }>();
    for (const row of page.results) {
      bytes += new TextEncoder().encode(row.data_json).length;
      if (++count > 10000 || bytes > 32 * 1024 * 1024)
        fail(
          "agent_upgrade_validation_limit",
          "Upgrade exceeds the 10,000-record or 32 MiB validation bound; no changes were applied.",
        );
      const definition = definitionFor(row);
      const data = JSON.parse(row.data_json);
      try {
        assertSchemaValue(definition.schema, data, "retained state");
      } catch {
        fail(
          "agent_upgrade_state_incompatible",
          "Retained state does not validate against the destination schema; run a reviewed migration first.",
        );
      }
      const expected = (definition.indexes ?? [])
        .filter((index) => data[index.field] !== undefined)
        .map((index) => ({ name: index.name, value: data[index.field] }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const actual = (JSON.parse(row.indexes_json) as { name: string; value: unknown }[]).sort(
        (a, b) => a.name.localeCompare(b.name),
      );
      if (runtimeStateCanonicalJson(expected) !== runtimeStateCanonicalJson(actual))
        fail(
          "agent_upgrade_indexes_incompatible",
          "Retained indexes differ from the destination; rebuild them through a reviewed migration first.",
        );
    }
    if (page.results.length < 16) break;
    after = page.results.at(-1)!.id;
  }
};

export const handleAgentPackageUpgrade = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  if (env.WORKBENCH_PACKAGE_UPGRADES_ENABLED !== "true")
    return failure(404, "runtime_capability_disabled", "Package upgrades are disabled");
  const parsed = publicUpgradeContracts["POST /workbench/package-upgrades"].request.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return failure(
      400,
      "agent_upgrade_invalid",
      "Specify targetVersion, expectedRevision and idempotencyKey",
    );
  const input = parsed.data;
  if (
    request.headers.has("idempotency-key") &&
    request.headers.get("idempotency-key") !== input.idempotencyKey
  )
    return failure(400, "agent_upgrade_invalid", "Header and body idempotency keys must match");
  const hash = await sha256Hex(runtimeStateCanonicalJson(input));
  const readAgent = () =>
    env.DB.prepare(authority)
      .bind(...actor(identity))
      .first<UpgradeAgent>();
  const receiptFor = () =>
    env.DB.prepare(`SELECT request_hash, receipt_json FROM control_agent_upgrades
    WHERE workspace_id = ? AND agent_id = ? AND user_id = ? AND idempotency_key = ?`)
      .bind(
        identity.scope.workspaceId,
        identity.agentId,
        identity.scope.userId,
        input.idempotencyKey,
      )
      .first<{ request_hash: string; receipt_json: string }>();
  const replay = async (receipt: { request_hash: string; receipt_json: string }) => {
    if (!(await readAgent()))
      return failure(403, "agent_upgrade_denied", "Current workspace admin authority is required");
    return receipt.request_hash === hash
      ? json({ ok: true, upgrade: JSON.parse(receipt.receipt_json) })
      : failure(
          409,
          "idempotency_conflict",
          "This upgrade key was already used with different content",
        );
  };
  const agent = await readAgent();
  if (!agent)
    return failure(403, "agent_upgrade_denied", "Current workspace admin authority is required");
  const previous = await receiptFor();
  if (previous) return replay(previous);
  if ((agent.runtime_revision ?? 0) !== input.expectedRevision)
    return failure(
      409,
      "agent_runtime_revision_conflict",
      "Refresh the agent revision before upgrading",
    );
  const oldPack = resolveAgentBehaviorConfig(agent).pack;
  if (!oldPack)
    return failure(422, "agent_package_missing", "Only package-backed agents can be upgraded");
  const manifest = installedManifest(env, oldPack.id);
  if (!manifest || manifest.version !== input.targetVersion)
    return failure(
      422,
      "agent_upgrade_target_missing",
      "The exact destination package version must be installed in the trusted registry",
    );
  if (oldPack.version === input.targetVersion)
    return failure(409, "agent_upgrade_unchanged", "This agent already uses the requested version");
  const runtime = resolvePackRuntime(oldPack.id, input.targetVersion);
  if (!runtime.runnable)
    return failure(
      422,
      runtime.reason,
      "The destination runtime is incompatible with this backend",
    );
  if (
    runtime.controlPlane.requirements.capabilities.some((capability) =>
      capability.startsWith("state."),
    ) &&
    env.WORKBENCH_TYPED_STATE_ENABLED !== "true"
  )
    return failure(
      422,
      "runtime_capability_disabled",
      "The destination requires enabled typed state",
    );
  if (
    runtime.controlPlane.requirements.capabilities.includes("context.snapshots.v2") &&
    env.WORKBENCH_CONTEXT_ENABLED !== "true"
  )
    return failure(
      422,
      "runtime_capability_disabled",
      "The destination requires enabled scoped context",
    );
  if (!runtimeUsageCapabilitiesEnabled(env, runtime.controlPlane.requirements.capabilities))
    return failure(
      422,
      "runtime_capability_disabled",
      "The destination requires enabled model and resource-budget capabilities",
    );
  try {
    await validateRetainedState(env, identity, runtime.controlPlane.state ?? []);
    const triggers = await env.DB.prepare(
      `SELECT workflow_type, input_json FROM control_triggers WHERE workspace_id = ? AND agent_id = ? LIMIT 1001`,
    )
      .bind(identity.scope.workspaceId, identity.agentId)
      .all<{ workflow_type: string; input_json: string }>();
    if (triggers.results.length > 1000)
      fail("agent_upgrade_validation_limit", "Too many triggers for one upgrade command");
    for (const trigger of triggers.results) {
      const workflow = runtime.controlPlane.workflows.find(
        (item) => item.type === trigger.workflow_type,
      );
      if (!workflow)
        fail(
          "agent_upgrade_trigger_incompatible",
          "The destination must retain configured trigger workflows",
        );
      try {
        assertSchemaValue(workflow!.inputSchema, JSON.parse(trigger.input_json), "trigger input");
      } catch {
        fail(
          "agent_upgrade_trigger_incompatible",
          "Update incompatible trigger inputs before upgrading",
        );
      }
    }
    const snapshot = JSON.stringify({
      ...JSON.parse(agent.data_json),
      behavior: createAgentBehaviorSnapshotFromTemplate(toPackTemplate(manifest)),
      runtimeModuleSnapshot: {
        apiVersion: runtime.controlPlane.apiVersion,
        runtimeVersion: runtime.controlPlane.runtimeVersion,
        requirements: runtime.controlPlane.requirements,
        context: (runtime.controlPlane.context ?? []).map(
          ({ resolve: _resolve, ...metadata }) => metadata,
        ),
        state: runtime.controlPlane.state ?? [],
        stateMigrations: runtime.controlPlane.stateMigrations ?? [],
        workflows: runtime.controlPlane.workflows.map((workflow) => ({
          type: workflow.type,
          inputSchema: workflow.inputSchema,
        })),
      },
    });
    if (
      [snapshot, agent.data_json].some(
        (value) => new TextEncoder().encode(value).length > 256 * 1024,
      )
    )
      fail("agent_upgrade_validation_limit", "A package snapshot exceeds 256 KiB");
    const now = new Date().toISOString();
    const id = `upgrade-${crypto.randomUUID()}`;
    const result: PackageUpgradeResponse["upgrade"] = {
      id,
      agentId: agent.id,
      packId: oldPack.id,
      fromVersion: oldPack.version,
      toVersion: input.targetVersion,
      fromRevision: input.expectedRevision,
      toRevision: input.expectedRevision + 1,
      committedAt: now,
    };
    const snapshotStatement = (revision: number, version: string, data: string) =>
      env.DB.prepare(`INSERT INTO control_agent_snapshots
      (id, workspace_id, agent_id, revision, pack_id, pack_version, snapshot_json, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, agent_id, revision) DO NOTHING`).bind(
        `${agent.id}:${revision}`,
        identity.scope.workspaceId,
        agent.id,
        revision,
        oldPack.id,
        version,
        data,
        identity.scope.userId,
        now,
      );
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO control_agent_upgrades
        (id, workspace_id, agent_id, user_id, idempotency_key, request_hash, receipt_json, created_at, preconditions_met)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN EXISTS (${authority}
          AND a.runtime_revision = ? AND a.upgrade_validation_revision = ? AND a.data_json = ?)
          AND NOT EXISTS (SELECT 1 FROM control_agent_snapshots WHERE workspace_id = ? AND agent_id = ? AND revision = ? AND snapshot_json != ?)
          AND NOT EXISTS (SELECT 1 FROM control_agent_snapshots WHERE workspace_id = ? AND agent_id = ? AND revision = ?)
          THEN 1 ELSE 0 END`).bind(
        id,
        identity.scope.workspaceId,
        agent.id,
        identity.scope.userId,
        input.idempotencyKey,
        hash,
        JSON.stringify(result),
        now,
        ...actor(identity),
        input.expectedRevision,
        agent.upgrade_validation_revision,
        agent.data_json,
        identity.scope.workspaceId,
        agent.id,
        input.expectedRevision,
        agent.data_json,
        identity.scope.workspaceId,
        agent.id,
        input.expectedRevision + 1,
      ),
      snapshotStatement(input.expectedRevision, oldPack.version, agent.data_json),
      env.DB.prepare(
        `UPDATE agents SET data_json = ?, runtime_revision = runtime_revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?`,
      ).bind(snapshot, now, agent.id, identity.scope.workspaceId),
      snapshotStatement(result.toRevision, result.toVersion, snapshot),
      env.DB.prepare(`INSERT INTO control_audit_events (id, user_id, workspace_id, action, summary, target_type, target_id, data_json, created_at)
        VALUES (?, ?, ?, 'agent.package_upgraded', 'Agent package upgraded explicitly.', 'agent', ?, ?, ?)`).bind(
        id,
        identity.scope.userId,
        identity.scope.workspaceId,
        agent.id,
        JSON.stringify(result),
        now,
      ),
      env.DB.prepare(`INSERT INTO control_plane_events (id, user_id, workspace_id, agent_id, type, summary, target_type, target_id, data_json, created_at)
        VALUES (?, ?, ?, ?, 'agent.package_upgraded', 'Agent package upgraded explicitly.', 'agent', ?, ?, ?)`).bind(
        id,
        ...actor(identity),
        agent.id,
        JSON.stringify(result),
        now,
      ),
    ]);
    return json({ ok: true, upgrade: result });
  } catch (error) {
    const concurrent = await receiptFor();
    if (concurrent) return replay(concurrent);
    const message = String(error);
    const code = [
      "agent_runtime_revision_busy",
      "workspace_export_in_progress",
      "agent_upgrade_precondition",
    ].find((value) => message.includes(value));
    if (code)
      return failure(
        409,
        code === "agent_upgrade_precondition" ? "agent_upgrade_conflict" : code,
        "Upgrade authority or state changed, or work is active. Refresh canonical state before retrying; no upgrade was applied.",
      );
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error instanceof Error &&
      String(error.code).startsWith("agent_")
    )
      return failure(422, String(error.code), error.message);
    return failure(
      500,
      "agent_upgrade_failed",
      "Upgrade failed; inspect canonical history before retrying",
    );
  }
};

export const handleAgentPackageSnapshots = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  if (env.WORKBENCH_PACKAGE_UPGRADES_ENABLED !== "true")
    return failure(404, "runtime_capability_disabled", "Package upgrades are disabled");
  const agent = await env.DB.prepare(authority)
    .bind(...actor(identity))
    .first<UpgradeAgent>();
  if (!agent)
    return failure(403, "agent_upgrade_denied", "Current workspace admin authority is required");
  const pack = resolveAgentBehaviorConfig(agent).pack;
  if (!pack) return failure(404, "agent_package_missing", "This agent has no package snapshot");
  const params = new URL(request.url).searchParams;
  const parsed = publicUpgradeContracts["GET /workbench/package-snapshots"].query.safeParse(
    Object.fromEntries(params),
  );
  if (!parsed.success || params.getAll("beforeRevision").length > 1)
    return failure(
      400,
      "agent_snapshot_query_invalid",
      "beforeRevision must be a nonnegative integer",
    );
  const before = parsed.data.beforeRevision ?? Number.MAX_SAFE_INTEGER;
  const rows =
    await env.DB.prepare(`SELECT * FROM control_agent_snapshots WHERE workspace_id = ? AND agent_id = ? AND revision < ?
    AND EXISTS (${authority}) ORDER BY revision DESC LIMIT 17`)
      .bind(identity.scope.workspaceId, agent.id, before, ...actor(identity))
      .all<{
        revision: number;
        pack_id: string;
        pack_version: string;
        snapshot_json: string;
        created_at: string;
      }>();
  return json(
    publicUpgradeContracts["GET /workbench/package-snapshots"].response.parse({
      ok: true,
      agentId: agent.id,
      currentRevision: agent.runtime_revision ?? 0,
      currentVersion: pack.version,
      availableVersion: installedManifest(env, pack.id)?.version ?? null,
      snapshots: rows.results.slice(0, 16).map((row) => ({
        revision: row.revision,
        packId: row.pack_id,
        packVersion: row.pack_version,
        snapshot: JSON.parse(row.snapshot_json),
        createdAt: row.created_at,
      })),
      ...(rows.results.length > 16 ? { nextBeforeRevision: rows.results[15]!.revision } : {}),
    }),
  );
};
