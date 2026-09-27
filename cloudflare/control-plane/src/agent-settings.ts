import {
  resolveRuntimeSettings,
  validateSchemaValue,
  type RuntimeRecord,
  type RuntimeSettings,
  type RuntimeSettingsDefinition,
} from "@operloom/agent-sdk/control-plane";

import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { resolveAgentBehaviorConfig } from "./agent-records";
import { selectAgent, selectMembership } from "./authz-store";
import { isRecord, json, parseDataJson, parseJson } from "./http";
import { requireActiveMembership, requireAdminMembership } from "./membership-policy";
import { runtimeStateCanonicalJson } from "./runtime-state";
import { createId, toJson, type AgentIdentity, type AgentRow, type Env } from "./types";

const emptySettingsSchema = { type: "object", properties: {}, additionalProperties: false };

export const agentSettingsDefinition = (
  agent: AgentRow | null,
): RuntimeSettingsDefinition | undefined => {
  const pack = resolveAgentBehaviorConfig(agent).pack;
  if (!pack) return undefined;
  const runtime = resolvePackRuntime(pack.id, pack.version);
  return runtime.runnable ? runtime.controlPlane.settings : undefined;
};

const storedOverrides = (agent: AgentRow | null) => parseDataJson(agent?.settings_json ?? "{}");

/** Effective settings from one agent row: pack defaults overlaid with stored editable values. */
export const agentSettingsFor = (agent: AgentRow | null): RuntimeSettings =>
  resolveRuntimeSettings(agentSettingsDefinition(agent), {
    version: agent?.settings_version ?? 0,
    values: storedOverrides(agent),
  });

export const currentAgentSettings = async (env: Env, identity: AgentIdentity) =>
  agentSettingsFor(await selectAgent(env, identity.agentId, identity.scope.workspaceId));

/** Run metadata fields that pin the settings a run was admitted with. */
export const settingsPin = (settings: RuntimeSettings) => ({
  settingsVersion: settings.version,
  settings: settings.values,
});

const pinnedSettingsOf = (data: Record<string, unknown>): RuntimeSettings | null =>
  typeof data.settingsVersion === "number" &&
  Number.isSafeInteger(data.settingsVersion) &&
  isRecord(data.settings)
    ? Object.freeze({ version: data.settingsVersion, values: data.settings })
    : null;

/** Settings pinned by a control run; runs admitted without a pin observe the current settings. */
export const readRunSettings = async (
  env: Env,
  identity: AgentIdentity,
  runId: string,
): Promise<RuntimeSettings> => {
  const row = await env.DB.prepare(
    "SELECT data_json FROM control_runs WHERE id = ? AND user_id = ? AND workspace_id = ? AND agent_id = ?",
  )
    .bind(runId, identity.scope.userId, identity.scope.workspaceId, identity.agentId)
    .first<{ data_json: string }>();
  return (
    (row && pinnedSettingsOf(parseDataJson(row.data_json))) ??
    (await currentAgentSettings(env, identity))
  );
};

/** Only operator-editable keys are exposed to the model. */
export const editableSettingsValues = (
  definition: RuntimeSettingsDefinition,
  settings: RuntimeSettings,
): RuntimeRecord =>
  Object.fromEntries(
    definition.editable
      .filter((key) => Object.prototype.hasOwnProperty.call(settings.values, key))
      .map((key) => [key, settings.values[key]]),
  );

const settingsState = (agent: AgentRow) => {
  const definition = agentSettingsDefinition(agent);
  const settings = agentSettingsFor(agent);
  return {
    ok: true,
    agentId: agent.id,
    version: settings.version,
    values: settings.values,
    editable: definition?.editable ?? [],
    schema: definition?.schema ?? emptySettingsSchema,
  };
};

export const handleGetAgentSettings = async (
  env: Env,
  identity: AgentIdentity,
  agentId: string,
) => {
  const membershipError = requireActiveMembership(
    await selectMembership(env, identity.scope.userId, identity.scope.workspaceId),
  );
  if (membershipError) return membershipError;
  const agent = await selectAgent(env, agentId, identity.scope.workspaceId);
  if (!agent) return json({ ok: false, error: "Agent not found" }, { status: 404 });
  return json(settingsState(agent));
};

/** Settings are data, not an execution generation: runs keep their pinned values and the revision is unchanged. */
export const handleUpdateAgentSettings = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  agentId: string,
) => {
  const adminError = requireAdminMembership(
    await selectMembership(env, identity.scope.userId, identity.scope.workspaceId),
  );
  if (adminError) return adminError;
  const body = parseJson(await request.text());
  const values = isRecord(body) ? body.values : undefined;
  const expectedVersion = isRecord(body) ? body.expectedVersion : undefined;
  if (
    !isRecord(values) ||
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  )
    return json(
      { ok: false, code: "invalid_settings", error: "values and expectedVersion are required" },
      { status: 400 },
    );
  const agent = await selectAgent(env, agentId, identity.scope.workspaceId);
  if (!agent) return json({ ok: false, error: "Agent not found" }, { status: 404 });
  const definition = agentSettingsDefinition(agent);
  const rejected = Object.keys(values).filter((key) => !definition?.editable.includes(key));
  if (rejected.length || !definition)
    return json(
      {
        ok: false,
        code: "settings_not_editable",
        error: `Settings are not editable: ${rejected.join(", ") || "none declared"}`,
      },
      { status: 400 },
    );
  const conflict = (current: AgentRow) =>
    json(
      {
        ...settingsState(current),
        ok: false,
        code: "settings_version_conflict",
        error: "Agent settings changed",
      },
      { status: 409 },
    );
  if ((agent.settings_version ?? 0) !== expectedVersion) return conflict(agent);
  const stored = Object.fromEntries(
    Object.entries({ ...storedOverrides(agent), ...values }).filter(([key]) =>
      definition.editable.includes(key),
    ),
  );
  const issues = validateSchemaValue(definition.schema, { ...definition.defaults, ...stored });
  if (issues.length)
    return json(
      {
        ok: false,
        code: "settings_invalid",
        error: `Settings failed validation: ${issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`,
      },
      { status: 400 },
    );
  const current = agentSettingsFor(agent).values;
  const changedKeys = Object.keys(values).filter(
    (key) => runtimeStateCanonicalJson(current[key]) !== runtimeStateCanonicalJson(values[key]),
  );
  if (!changedKeys.length) return json(settingsState(agent));
  const storedJson = JSON.stringify(stored);
  const nextVersion = expectedVersion + 1;
  const timestamp = new Date().toISOString();
  const [update] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE agents SET settings_json = ?, settings_version = ?
       WHERE id = ? AND workspace_id = ? AND status = 'active' AND settings_version = ?`,
    ).bind(storedJson, nextVersion, agent.id, identity.scope.workspaceId, expectedVersion),
    env.DB.prepare(
      `INSERT INTO control_plane_events (
         id, user_id, workspace_id, agent_id, type, summary, target_type, target_id, data_json, created_at
       )
       SELECT ?, ?, ?, ?, 'agent.settings.changed', ?, 'agent', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM agents WHERE id = ? AND workspace_id = ? AND settings_version = ? AND settings_json = ?
       )`,
    ).bind(
      createId("cf-event"),
      identity.scope.userId,
      identity.scope.workspaceId,
      agent.id,
      `Settings changed: ${changedKeys.join(", ")}`,
      agent.id,
      toJson({ changedKeys, version: nextVersion, actorUserId: identity.scope.userId }),
      timestamp,
      agent.id,
      identity.scope.workspaceId,
      nextVersion,
      storedJson,
    ),
  ]);
  const updated = await selectAgent(env, agent.id, identity.scope.workspaceId);
  if (!updated) return json({ ok: false, error: "Agent not found" }, { status: 404 });
  if (!update?.meta?.changes) return conflict(updated);
  return json(settingsState(updated));
};
