import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { parseDataJson } from "./http";
import { createId, toJson, type AgentRow, type D1Result, type Env } from "./types";
import {
  createAgentBehaviorSnapshot,
  type AgentBehaviorAuthoringMetadata,
  type AgentPackTemplateMetadata,
  type AgentBehaviorTemplateId,
} from "./agent-behavior-templates";

export const agentProfiles = ["default", "analyst", "operator"] as const;
export type AgentProfile = (typeof agentProfiles)[number];
export const allowedOpenRouterModels = [
  "deepseek/deepseek-v4-flash",
  "openai/gpt-4.1-mini",
  "openai/gpt-6-luna",
] as const;
export type AllowedOpenRouterModel = (typeof allowedOpenRouterModels)[number];

const defaultModel = "openai/gpt-6-luna";
const defaultTemperature = 0.4;
const defaultMaxTokens = 1200;

export type AgentRuntimeConfig = {
  provider: "openrouter";
  model: string;
  reasoningEffort?: "none";
  temperature: number;
  maxTokens: number;
  source: "agent" | "system-default";
};

export type AgentBehaviorConfig = {
  profile: AgentProfile;
  source: "server-preset" | "template-snapshot";
  version: string;
  instructionId: string;
  format?: "xml";
  templateId?: string;
  authoring?: AgentBehaviorAuthoringMetadata;
  pack?: AgentPackTemplateMetadata;
  preview?: string;
};

const behaviorVersion = "2026-06-07" as const;

const behaviorInstructions = {
  default:
    "You are the default assistant for this workspace. Be clear, practical, and concise. Ask for missing context when it materially affects the answer. Keep responses useful across many project types and avoid assuming a domain that was not provided.",
  analyst:
    "You are operating in analyst mode for this workspace. Emphasize structure, tradeoffs, assumptions, and verification. Prefer careful analysis over speed, but keep conclusions actionable and avoid unnecessary detail.",
  operator:
    "You are operating in operator mode for this workspace. Emphasize direct next actions, execution readiness, blockers, and concise status. Prefer checkable steps and concrete outcomes over broad exploration.",
} satisfies Record<AgentProfile, string>;

const isAgentProfile = (value: string): value is AgentProfile =>
  agentProfiles.includes(value as AgentProfile);

export const isAllowedOpenRouterModel = (value: string): value is AllowedOpenRouterModel =>
  allowedOpenRouterModels.includes(value as AllowedOpenRouterModel);

export const normalizeOpenRouterModel = (value: unknown): AllowedOpenRouterModel | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return isAllowedOpenRouterModel(normalized) ? normalized : null;
};

export const normalizeAgentProfile = (value: unknown): AgentProfile | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isAgentProfile(normalized) ? normalized : null;
};

export const getAgentProfile = (row: AgentRow): AgentProfile => {
  const data = parseDataJson(row.data_json);
  return normalizeAgentProfile(data.profile) ?? "default";
};

const systemDefaultRuntimeConfig = (env: Env): AgentRuntimeConfig => {
  const model = normalizeOpenRouterModel(env.OPENROUTER_MODEL) ?? defaultModel;
  return {
    provider: "openrouter",
    model,
    reasoningEffort: model === "openai/gpt-6-luna" ? "none" : undefined,
    temperature: defaultTemperature,
    maxTokens: defaultMaxTokens,
    source: "system-default",
  };
};

export const resolveAgentRuntimeConfig = (env: Env, row: AgentRow | null): AgentRuntimeConfig => {
  const fallback = systemDefaultRuntimeConfig(env);
  if (!row) return fallback;

  const data = parseDataJson(row.data_json);
  const runtime = data.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return fallback;

  const record = runtime as Record<string, unknown>;
  const provider = record.provider === "openrouter" ? "openrouter" : null;
  const model = normalizeOpenRouterModel(record.model);
  if (!provider || !model) return fallback;

  return {
    provider,
    model,
    reasoningEffort: model === "openai/gpt-6-luna" ? "none" : undefined,
    temperature: defaultTemperature,
    maxTokens: defaultMaxTokens,
    source: "agent",
  };
};

const readBehaviorSnapshot = (row: AgentRow | null) => {
  if (!row) return null;
  const data = parseDataJson(row.data_json);
  const behavior = data.behavior;
  if (!behavior || typeof behavior !== "object" || Array.isArray(behavior)) return null;

  const record = behavior as Record<string, unknown>;
  if (record.source !== "template-snapshot" || record.format !== "xml") return null;
  if (typeof record.prompt !== "string" || !record.prompt.trim()) return null;

  return {
    templateId: typeof record.templateId === "string" ? record.templateId : undefined,
    version: typeof record.version === "string" ? record.version : "unknown",
    authoring:
      record.authoring && typeof record.authoring === "object" && !Array.isArray(record.authoring)
        ? (record.authoring as AgentBehaviorAuthoringMetadata)
        : undefined,
    pack:
      record.pack && typeof record.pack === "object" && !Array.isArray(record.pack)
        ? (record.pack as AgentPackTemplateMetadata)
        : undefined,
    prompt: record.prompt,
  };
};

export const resolveAgentBehaviorConfig = (
  row: AgentRow | null,
  options?: { includePreview?: boolean },
): AgentBehaviorConfig => {
  const profile = row ? getAgentProfile(row) : "default";
  const snapshot = readBehaviorSnapshot(row);
  if (snapshot) {
    const instructionId = snapshot.templateId
      ? `agent-behavior-${snapshot.templateId}-${snapshot.version}`
      : `agent-behavior-template-${profile}-${snapshot.version}`;
    return {
      profile,
      source: "template-snapshot",
      version: snapshot.version,
      instructionId,
      format: "xml",
      templateId: snapshot.templateId,
      authoring: snapshot.authoring,
      pack: snapshot.pack,
      ...(options?.includePreview ? { preview: snapshot.prompt } : {}),
    };
  }

  return {
    profile,
    source: "server-preset",
    version: behaviorVersion,
    instructionId: `agent-behavior-${profile}`,
  };
};

export const toAgentBehaviorMetadata = (config: AgentBehaviorConfig): AgentBehaviorConfig => {
  const { preview: _preview, ...metadata } = config;
  return metadata;
};

export const resolveAgentBehaviorInstruction = (row: AgentRow | null) => {
  const snapshot = readBehaviorSnapshot(row);
  if (snapshot) return snapshot.prompt;
  return behaviorInstructions[resolveAgentBehaviorConfig(row).profile];
};

export const toAgentSummary = (env: Env, row: AgentRow, activeAgentId: string) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  profile: getAgentProfile(row),
  runtime: resolveAgentRuntimeConfig(env, row),
  behavior: resolveAgentBehaviorConfig(row, { includePreview: true }),
  isDefault: row.is_default === 1,
  isActive: row.id === activeAgentId,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toAgentRuntimeMetadata = (env: Env, row: AgentRow | null, fallbackAgentId: string) =>
  row
    ? {
        id: row.id,
        name: row.name,
        profile: getAgentProfile(row),
        runtime: resolveAgentRuntimeConfig(env, row),
        behavior: toAgentBehaviorMetadata(resolveAgentBehaviorConfig(row)),
        isDefault: row.is_default === 1,
      }
    : {
        id: fallbackAgentId,
        profile: "default" satisfies AgentProfile,
        runtime: resolveAgentRuntimeConfig(env, null),
        behavior: toAgentBehaviorMetadata(resolveAgentBehaviorConfig(null)),
      };

export const insertAgent = async (
  env: Env,
  input: {
    workspaceId: string;
    userId: string;
    name: string;
    description: string | null;
    profile: AgentProfile;
    model?: AllowedOpenRouterModel;
    behaviorTemplateId?: AgentBehaviorTemplateId;
    behaviorSnapshot?: ReturnType<typeof createAgentBehaviorSnapshot>;
    agentId?: string;
    provisionedBy?: "manual" | "agent_pack";
    idempotent?: boolean;
  },
) => {
  const timestamp = new Date().toISOString();
  const agentId = input.agentId ?? createId("agent");
  const runtime = input.model
    ? {
        provider: "openrouter",
        model: input.model,
        temperature: defaultTemperature,
        maxTokens: defaultMaxTokens,
      }
    : undefined;
  const behavior =
    input.behaviorSnapshot ?? createAgentBehaviorSnapshot(input.profile, input.behaviorTemplateId);
  const module = behavior.pack
    ? resolvePackRuntime(behavior.pack.id, behavior.pack.version)
    : undefined;
  const runtimeModuleSnapshot =
    module?.runnable &&
    module.controlPlane.requirements.capabilities.includes("context.snapshots.v2")
      ? { runtimeVersion: module.runtimeVersion, requirements: module.controlPlane.requirements }
      : undefined;
  const result = (await env.DB.prepare(
    `${input.idempotent ? "INSERT OR IGNORE" : "INSERT"} INTO agents (
       id, workspace_id, name, description, status, is_default, created_by_user_id,
       data_json, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)`,
  )
    .bind(
      agentId,
      input.workspaceId,
      input.name,
      input.description,
      input.userId,
      toJson({
        profile: input.profile,
        provisionedBy: input.provisionedBy ?? "manual",
        behavior,
        ...(runtimeModuleSnapshot ? { runtimeModuleSnapshot } : {}),
        ...(runtime ? { runtime } : {}),
      }),
      timestamp,
      timestamp,
    )
    .run()) as D1Result;
  return { agentId, created: (result.meta?.changes ?? 0) > 0 };
};
