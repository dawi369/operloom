import {
  insertAgent,
  normalizeAgentProfile,
  normalizeOpenRouterModel,
  resolveAgentBehaviorConfig,
  toAgentSummary,
} from "./agent-records";
import {
  agentBehaviorTemplates,
  createAgentBehaviorSnapshotFromTemplate,
  normalizeAgentBehaviorTemplateId,
  toPackTemplate,
  type AgentBehaviorTemplate,
  type AgentBehaviorTemplateId,
} from "./agent-behavior-templates";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";
import type { LocalAgentPackManifest } from "../../../agent-packs";
import { upsertActiveAgentPreference } from "./authz";
import { selectAgent, selectMembership, selectWorkspaceAgents } from "./authz-store";
import { isRecord, json, parseJson } from "./http";
import { requireActiveMembership, requireAdminMembership } from "./membership-policy";
import type { AgentIdentity, Env } from "./types";
import { demoPackAllowed, resolveDemoPolicy } from "./demo-policy";

const agentNameMaxLength = 80;
const agentDescriptionMaxLength = 240;

export const handleListAgentBehaviorTemplates = (env?: Env) =>
  json({
    ok: true,
    templates: resolveDemoPolicy(env ?? ({} as Env))
      ? agentBehaviorTemplates.filter((template) =>
          demoPackAllowed(env!, "pack" in template ? template.pack?.id : undefined),
        )
      : agentBehaviorTemplates,
  });

export const handleListAgents = async (env: Env, identity: AgentIdentity) => {
  const agents = await selectWorkspaceAgents(env, identity.scope.workspaceId);

  return json({
    ok: true,
    activeAgentId: identity.agentId,
    agents: agents.results.map((agent) => toAgentSummary(env, agent, identity.agentId)),
  });
};

export const handleCreateAgent = async (request: Request, env: Env, identity: AgentIdentity) => {
  const currentMembership = await selectMembership(
    env,
    identity.scope.userId,
    identity.scope.workspaceId,
  );
  const adminError = requireAdminMembership(currentMembership);
  if (adminError) return adminError;

  const body = parseJson(await request.text());
  const rawName = isRecord(body) && typeof body.name === "string" ? body.name.trim() : "";
  const name = rawName.slice(0, agentNameMaxLength);
  if (!name) {
    return json({ ok: false, error: "Agent name is required" }, { status: 400 });
  }

  const rawDescription =
    isRecord(body) && typeof body.description === "string" ? body.description.trim() : "";
  const description = rawDescription ? rawDescription.slice(0, agentDescriptionMaxLength) : null;
  const profile = normalizeAgentProfile(isRecord(body) ? body.profile : undefined);
  if (!profile) {
    return json(
      { ok: false, error: "Agent profile must be one of default, analyst, or operator" },
      { status: 400 },
    );
  }
  const rawModel = isRecord(body) ? body.model : undefined;
  const normalizedModel = rawModel === undefined ? undefined : normalizeOpenRouterModel(rawModel);
  if (rawModel !== undefined && !normalizedModel) {
    return json(
      {
        ok: false,
        error: "Agent model must be one of deepseek/deepseek-v4-flash or openai/gpt-4.1-mini",
      },
      { status: 400 },
    );
  }
  const model = normalizedModel ?? undefined;
  const rawBehaviorTemplateId = isRecord(body) ? body.behaviorTemplateId : undefined;
  const behaviorTemplateId =
    rawBehaviorTemplateId === undefined
      ? undefined
      : normalizeAgentBehaviorTemplateId(rawBehaviorTemplateId);
  if (rawBehaviorTemplateId !== undefined && !behaviorTemplateId) {
    return json(
      {
        ok: false,
        error: `Agent behavior template must be one of ${agentBehaviorTemplates
          .map((template) => template.id)
          .join(", ")}`,
      },
      { status: 400 },
    );
  }

  const inserted = await insertAgent(env, {
    workspaceId: identity.scope.workspaceId,
    userId: identity.scope.userId,
    name,
    description,
    profile,
    model,
    behaviorTemplateId: behaviorTemplateId ?? undefined,
  });
  const agent = await selectAgent(env, inserted.agentId, identity.scope.workspaceId);
  if (!agent) {
    return json({ ok: false, error: "Created agent not found" }, { status: 500 });
  }

  const activate = isRecord(body) && body.activate === true;
  if (activate) {
    await upsertActiveAgentPreference(env, {
      userId: identity.scope.userId,
      workspaceId: identity.scope.workspaceId,
      agentId: agent.id,
      reason: "agent-created",
    });
  }

  return json(
    {
      ok: true,
      activeAgentId: activate ? agent.id : identity.agentId,
      agent: toAgentSummary(env, agent, activate ? agent.id : identity.agentId),
    },
    { status: 201 },
  );
};

const managedPackAgentId = async (workspaceId: string, packId: string, packVersion: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${workspaceId}:${packId}:${packVersion}`),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `agent-pack-${hash.slice(0, 24)}`;
};

export const handleInstantiateAgentPack = async (
  env: Env,
  identity: AgentIdentity,
  packId: string,
) => {
  const currentMembership = await selectMembership(
    env,
    identity.scope.userId,
    identity.scope.workspaceId,
  );
  const adminError = requireAdminMembership(currentMembership);
  if (adminError) return adminError;

  const installedTemplate = (agentBehaviorTemplates as AgentBehaviorTemplate[]).find(
    (candidate) => candidate.pack?.id === packId,
  );
  const compiledEntry = agentManifestRegistry[packId as keyof typeof agentManifestRegistry];
  const conformanceTemplate =
    !installedTemplate &&
    compiledEntry?.conformanceOnly &&
    (env.WORKBENCH_E2E_MODE === "true" || env.WORKBENCH_CONFORMANCE_MODE === "true")
      ? toPackTemplate(compiledEntry.module as LocalAgentPackManifest)
      : undefined;
  const template = installedTemplate ?? conformanceTemplate;
  if (!template?.pack) {
    return json({ ok: false, error: "Agent pack not found" }, { status: 404 });
  }
  if (!demoPackAllowed(env, packId)) {
    return json(
      { ok: false, error: "Agent pack is unavailable in the public demo." },
      { status: 403 },
    );
  }

  const agents = await selectWorkspaceAgents(env, identity.scope.workspaceId);
  const currentVersionAgent = agents.results.find((agent) => {
    if (agent.status !== "active") return false;
    const behavior = resolveAgentBehaviorConfig(agent);
    return (
      behavior.pack?.id === packId &&
      behavior.authoring?.kind === "local_agent_pack" &&
      behavior.authoring.packVersion === template.version
    );
  });
  if (currentVersionAgent) {
    return json({
      ok: true,
      created: false,
      packId,
      packVersion: template.version,
      agent: toAgentSummary(env, currentVersionAgent, identity.agentId),
    });
  }

  const agentId = await managedPackAgentId(identity.scope.workspaceId, packId, template.version);
  const inserted = await insertAgent(env, {
    workspaceId: identity.scope.workspaceId,
    userId: identity.scope.userId,
    name: template.name,
    description: template.description,
    profile: template.profile,
    behaviorTemplateId: template.id as AgentBehaviorTemplateId,
    ...(conformanceTemplate
      ? { behaviorSnapshot: createAgentBehaviorSnapshotFromTemplate(conformanceTemplate) }
      : {}),
    agentId,
    provisionedBy: "agent_pack",
    idempotent: true,
  });
  const agent = await selectAgent(env, agentId, identity.scope.workspaceId);
  if (!agent) {
    return json({ ok: false, error: "Managed agent pack instance not found" }, { status: 500 });
  }

  return json(
    {
      ok: true,
      created: inserted.created,
      packId,
      packVersion: template.version,
      agent: toAgentSummary(env, agent, identity.agentId),
    },
    { status: inserted.created ? 201 : 200 },
  );
};

export const handleActivateAgent = async (env: Env, identity: AgentIdentity, agentId: string) => {
  const currentMembership = await selectMembership(
    env,
    identity.scope.userId,
    identity.scope.workspaceId,
  );
  const membershipError = requireActiveMembership(currentMembership);
  if (membershipError) return membershipError;

  const agent = await selectAgent(env, agentId, identity.scope.workspaceId);
  if (!agent) {
    return json({ ok: false, error: "Agent not found" }, { status: 404 });
  }
  if (agent.status !== "active") {
    return json({ ok: false, error: "Agent is not active" }, { status: 403 });
  }
  if (!demoPackAllowed(env, resolveAgentBehaviorConfig(agent).pack?.id)) {
    return json({ ok: false, error: "Agent is unavailable in the public demo." }, { status: 403 });
  }

  await upsertActiveAgentPreference(env, {
    userId: identity.scope.userId,
    workspaceId: identity.scope.workspaceId,
    agentId: agent.id,
    reason: "agent-activated",
  });

  return json({
    ok: true,
    activeAgentId: agent.id,
    agent: toAgentSummary(env, agent, agent.id),
  });
};
