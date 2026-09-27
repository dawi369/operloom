import {
  runtimeQueryDefaultTimeoutMs,
  runtimeQueryMaxTimeoutMs,
  validateSchemaValue,
  type RuntimeQueryBinding,
  type RuntimeQueryContext,
  type RuntimeRecord,
} from "@operloom/agent-sdk/control-plane";

import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { resolveAgentBehaviorConfig } from "./agent-records";
import { agentSettingsFor } from "./agent-settings";
import { selectAgent, selectMembership } from "./authz-store";
import { isRecord, json, parseJson } from "./http";
import { requireActiveMembership } from "./membership-policy";
import { createRuntimeStatePort } from "./runtime-state";
import type { AgentIdentity, AgentRow, Env } from "./types";

const failure = (status: number, code: string, error: string) =>
  json({ ok: false, code, error }, { status });

const activeAgentRuntime = async (env: Env, identity: AgentIdentity) => {
  const membershipError = requireActiveMembership(
    await selectMembership(env, identity.scope.userId, identity.scope.workspaceId),
  );
  if (membershipError) return membershipError;
  const agent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  const pack = agent?.status === "active" ? resolveAgentBehaviorConfig(agent).pack : null;
  if (!agent || !pack) return null;
  const runtime = resolvePackRuntime(pack.id, pack.version);
  return runtime.runnable ? { agent, pack, runtime } : null;
};

export const handleListRuntimeQueries = async (env: Env, identity: AgentIdentity) => {
  const resolved = await activeAgentRuntime(env, identity);
  if (resolved instanceof Response) return resolved;
  return json({
    ok: true,
    queries: (resolved?.runtime.controlPlane.queries ?? []).map((query) => ({
      id: query.id,
      description: query.description,
      inputSchema: query.inputSchema,
      outputSchema: query.outputSchema,
    })),
  });
};

const queryContext = async (
  env: Env,
  identity: AgentIdentity,
  agent: AgentRow,
  pack: { id: string; version: string },
  runtime: Extract<ReturnType<typeof resolvePackRuntime>, { runnable: true }>,
  signal: AbortSignal,
): Promise<RuntimeQueryContext> => {
  const definitions = runtime.controlPlane.state ?? [];
  const target = agent.effect_target ?? "simulation";
  // Reads use the agent's current generation and effect target; the port's commit is never exposed.
  const state = definitions.length
    ? await createRuntimeStatePort(
        env,
        { ...identity, agentRevision: agent.runtime_revision ?? 0, effectTarget: target },
        { packId: pack.id, target, definitions, signal },
      )
    : undefined;
  return Object.freeze({
    scope: Object.freeze({ ...identity.scope, agentId: identity.agentId }),
    pack: Object.freeze({
      id: pack.id,
      version: pack.version,
      runtimeVersion: runtime.runtimeVersion,
    }),
    settings: agentSettingsFor(agent),
    signal,
    ...(state
      ? {
          state: Object.freeze({
            get: state.get.bind(state),
            list: state.list.bind(state),
          }),
        }
      : {}),
  });
};

export const handleRunRuntimeQuery = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  queryId: string,
) => {
  const resolved = await activeAgentRuntime(env, identity);
  if (resolved instanceof Response) return resolved;
  const binding = resolved?.runtime.controlPlane.queries?.find(
    (query: RuntimeQueryBinding) => query.id === queryId,
  );
  if (!resolved || !binding) return failure(404, "query_not_found", "Query not found");
  const body = parseJson(await request.text());
  const input = isRecord(body) && body.input !== undefined ? body.input : {};
  const inputIssues = isRecord(input)
    ? validateSchemaValue(binding.inputSchema, input)
    : [{ path: "$", message: "must be an object" }];
  if (!isRecord(body) || inputIssues.length)
    return failure(
      400,
      "query_input_invalid",
      `Query input failed validation: ${inputIssues.map((issue) => `${issue.path} ${issue.message}`).join("; ") || "body must be an object"}`,
    );
  const controller = new AbortController();
  const timeoutMs = Math.min(
    binding.timeoutMs ?? runtimeQueryDefaultTimeoutMs,
    runtimeQueryMaxTimeoutMs,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let output: unknown;
  try {
    const context = await queryContext(
      env,
      identity,
      resolved.agent,
      resolved.pack,
      resolved.runtime,
      controller.signal,
    );
    output = await Promise.race([
      Promise.resolve().then(() =>
        binding.execute(structuredClone(input) as RuntimeRecord, context),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error("Query deadline exceeded"), { code: "query_timeout" }));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "query_timeout"
      ? failure(504, "query_timeout", "The query did not finish within its deadline.")
      : failure(502, "query_failed", "The query failed.");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  let normalized: unknown;
  try {
    normalized = JSON.parse(JSON.stringify(output));
  } catch {
    normalized = undefined;
  }
  if (!isRecord(normalized) || validateSchemaValue(binding.outputSchema, normalized).length)
    return failure(502, "query_output_invalid", "The query returned an invalid result.");
  return json({ ok: true, queryId: binding.id, output: normalized });
};
