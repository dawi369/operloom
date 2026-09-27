import {
  assertSchemaValue,
  type AgentExecutionContext,
  type RuntimeSimulationCommit,
  type RuntimeSimulationReceipt,
} from "@operloom/agent-sdk";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import { selectMembership } from "./authz-store";
import { contextIsRequired } from "./runtime-context";
import { evaluateToolPolicy } from "./tool-policy";
import { createRuntimeStatePort, runtimeStateCanonicalJson } from "./runtime-state";
import type { DurableAttemptAuthority } from "./durable-attempt-authority";
import type { AgentIdentity, Env } from "./types";

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

/** Platform-owned simulation commit; no connection, runner or action executor is called. */
export const createSimulationActionPort = (
  env: Env,
  identity: AgentIdentity,
  input: {
    context: AgentExecutionContext;
    toolIds: readonly string[];
    durableAttempt?: DurableAttemptAuthority;
  },
) => {
  const pack = { ...input.context.pack },
    run = { ...input.context.run },
    signal = input.context.signal;
  const toolIds = [...input.toolIds];
  return async (incoming: RuntimeSimulationCommit): Promise<RuntimeSimulationReceipt> => {
    const context = input.context;
    signal.throwIfAborted();
    const plan = structuredClone(incoming);
    if (
      !plan ||
      "preconditions" in plan ||
      "expiresAt" in plan ||
      typeof plan.toolId !== "string" ||
      typeof plan.type !== "string" ||
      plan.type.length < 1 ||
      plan.type.length > 128 ||
      typeof plan.summary !== "string" ||
      !plan.summary.trim() ||
      plan.summary.length > 240 ||
      typeof plan.idempotencyKey !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(plan.idempotencyKey) ||
      !Array.isArray(plan.decisions) ||
      plan.decisions.length > 15 ||
      !plan.state ||
      !Array.isArray(plan.state.reads) ||
      !Array.isArray(plan.state.writes)
    )
      return fail(
        "simulation_plan_invalid",
        "Simulation requires a bounded explicit proposal and state transition",
      );
    const runtime = resolvePackRuntime(pack.id, pack.version);
    if (!runtime.runnable || runtime.runtimeVersion !== pack.runtimeVersion)
      return fail("runtime_incompatible", "Simulation runtime is unavailable");
    const binding = runtime.controlPlane.tools.find((item) => item.id === plan.toolId);
    if (
      !toolIds.includes(plan.toolId) ||
      binding?.action?.target !== "simulation" ||
      binding.transport !== "cloudflare_inline"
    )
      return fail(
        "action_target_mismatch",
        "This workflow does not declare the simulation binding",
      );
    assertSchemaValue(binding.action.proposalSchema, plan.preview, "simulation proposal");
    assertSchemaValue(binding.action.resultSchema, plan.output, "simulation result");
    if (contextIsRequired(runtime) && !context.context)
      return fail("context_blocked", "Required simulation evidence is unavailable");
    context.context?.assertReady();
    const membership = await selectMembership(
      env,
      identity.scope.userId,
      identity.scope.workspaceId,
    );
    const policy = await evaluateToolPolicy(env, identity, {
      toolName: binding.id,
      membership,
      surface: "workflow",
      executionMode: "dry_run",
    });
    if (policy.decision !== "allow" || !membership)
      return fail("simulation_policy_blocked", policy.reason);
    const stableKey = `simulation:${await sha256Hex(runtimeStateCanonicalJson([binding.id, plan.idempotencyKey]))}`;
    const evidence = {
      target: "simulation",
      toolId: binding.id,
      actionType: plan.type,
      summary: plan.summary,
      preview: plan.preview,
      output: plan.output,
      decisionIds: plan.decisions.map((item) => item.id),
      packId: pack.id,
      packVersion: pack.version,
      runtimeVersion: pack.runtimeVersion,
      adapterVersion: binding.adapterVersion,
      runId: run.id,
      snapshotId: context.context?.snapshot.id ?? null,
    };
    const state = await createRuntimeStatePort(env, identity, {
      packId: pack.id,
      target: "simulation",
      definitions: runtime.controlPlane.state ?? [],
      runId: run.id,
      signal: signal,
      contextSnapshotId: context.context?.snapshot.id,
      durableAttempt: input.durableAttempt,
      simulationAuthority: {
        toolId: binding.id,
        membershipRole: membership.role,
        permission: policy.permission,
      },
    });
    const receipt = await state.commit({
      idempotencyKey: stableKey,
      reads: plan.state.reads,
      writes: plan.state.writes,
      entries: [
        ...plan.decisions.map((item) => ({
          id: item.id,
          type: "decision" as const,
          data: item.data,
        })),
        { id: stableKey, type: "effect", data: evidence },
      ],
      events: [
        {
          id: stableKey,
          type: "simulation.committed",
          data: {
            toolId: binding.id,
            runId: run.id,
            effectId: stableKey,
            target: "simulation",
          },
        },
      ],
    });
    return {
      target: "simulation",
      status: "committed",
      effectId: stableKey,
      receipt,
      output: plan.output,
    };
  };
};
