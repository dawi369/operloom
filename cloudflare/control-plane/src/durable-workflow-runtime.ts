import {
  beginDurableEngineDispatch,
  settleDurableEngineDispatch,
} from "./durable-engine-lifecycle";
import {
  assertSchemaValue,
  defaultConnectionPort,
  type AgentExecutionContext,
  type RuntimeDurableWorkflowContext,
  type RuntimeRecord,
  type RuntimeWorkflowBinding,
} from "@operloom/agent-sdk";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import { createRuntimeStatePort } from "./runtime-state";
import { createSimulationActionPort } from "./runtime-simulation";
import { captureRuntimeContext, contextIsRequired } from "./runtime-context";
import { createRuntimeModelPort } from "./runtime-models";
import { runtimeUsageCapabilitiesEnabled } from "./runtime-usage";
import { executeRuntimeToolBinding } from "./runtime-tool-execution";
import { authorizeWorkflowTools } from "./workflow-tool-policy";
import {
  claimDurableStep,
  completeDurableExecution,
  finishDurableStep,
  loadDurableExecution,
  loadDurableStepOutput,
  requireDurableExecutionAuthority,
  startDurableExecution,
  type DurableExecution,
} from "./durable-execution-store";
import type { DurableAttemptAuthority } from "./durable-attempt-authority";
import type { AgentIdentity, Env } from "./types";
import type { DurableHandlerPin } from "./durable-deployment-probe";
import {
  prepareDurableApproval,
  consumeDurableApproval,
  expireDurableApprovals,
} from "./durable-approvals";

/** Structural adapter keeps Cloudflare-specific classes out of package code and unit tests. */
export type DurableWorkflowEngine = {
  do(
    name: string,
    options: { retries: { limit: number; delay: number }; timeout: number },
    callback: () => Promise<{ stepId: string }>,
  ): Promise<{ stepId: string }>;
  sleepUntil(name: string, timestamp: number): Promise<void>;
  waitForEvent?(name: string, options: { type: string; timeout: number }): Promise<unknown>;
};
const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};
const codeOf = (error: unknown) =>
  error &&
  typeof error === "object" &&
  "code" in error &&
  typeof error.code === "string" &&
  /^[a-zA-Z0-9._:-]{1,128}$/.test(error.code)
    ? error.code
    : "durable_step_failed";
const identityFor = (execution: DurableExecution): AgentIdentity => ({
  scope: { userId: execution.user_id, workspaceId: execution.workspace_id },
  agentId: execution.agent_id,
  agentRevision: execution.agent_revision,
});
export const durableWorkflowDefinitionHash = async (
  runtime: ReturnType<typeof resolvePackRuntime>,
  workflow: RuntimeWorkflowBinding,
) => {
  if (!runtime.runnable || !workflow.durable) return fail("durable_handler_unavailable");
  // Versions are the package's retention contract. Function text additionally detects direct code drift.
  return sha256Hex(
    JSON.stringify({ runtime: runtime.controlPlane, workflow }, (_key, value) =>
      typeof value === "function" ? value.toString() : value,
    ),
  );
};
const resolveExecution = async (env: Env, execution: DurableHandlerPin) => {
  if (env.WORKBENCH_DURABLE_WORKFLOWS_ENABLED !== "true")
    return fail("runtime_capability_disabled");
  const runtime = resolvePackRuntime(execution.pack_id, execution.pack_version);
  if (!runtime.runnable) return fail("durable_handler_unavailable");
  const workflow = runtime.controlPlane.workflows.find(
    (item) => item.type === execution.workflow_type,
  );
  if (!workflow?.durable) return fail("durable_handler_unavailable");
  if (
    runtime.controlPlane.tools.some(
      (tool) => workflow.toolIds.includes(tool.id) && tool.action?.target === "simulation",
    ) &&
    (env.WORKBENCH_SIMULATIONS_ENABLED !== "true" || env.WORKBENCH_TYPED_STATE_ENABLED !== "true")
  )
    return fail("runtime_capability_disabled");
  if (
    !runtimeUsageCapabilitiesEnabled(env, runtime.controlPlane.requirements.capabilities) ||
    (contextIsRequired(runtime) && env.WORKBENCH_CONTEXT_ENABLED !== "true") ||
    (runtime.controlPlane.requirements.capabilities.includes("state.atomic") &&
      env.WORKBENCH_TYPED_STATE_ENABLED !== "true")
  )
    return fail("runtime_capability_disabled");
  const pins = {
    definitionHash: await durableWorkflowDefinitionHash(runtime, workflow),
    workflowVersion: workflow.durable.version,
    runtimeVersion: runtime.runtimeVersion,
  };
  return { runtime, workflow, pins };
};

export const checkDurableHandlerCompatibility = async (env: Env, execution: DurableHandlerPin) => {
  try {
    if (!env.DURABLE_WORKFLOWS) return { ok: false, code: "durable_binding_missing" };
    const { pins } = await resolveExecution(env, execution);
    if (
      pins.definitionHash !== execution.definition_hash ||
      pins.runtimeVersion !== execution.runtime_version ||
      pins.workflowVersion !== execution.workflow_version
    )
      return { ok: false, code: "durable_handler_incompatible" };
    return { ok: true };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
};

export const runDurableWorkflow = async (
  env: Env,
  runId: string,
  engine: DurableWorkflowEngine,
) => {
  const execution = await loadDurableExecution(env, runId);
  if (!execution) return fail("durable_run_unavailable");
  if (execution.status === "closed") return { runId };
  const identity = identityFor(execution),
    { runtime, workflow, pins } = await resolveExecution(env, execution);
  await engine.do("__start", { retries: { limit: 3, delay: 1000 }, timeout: 30000 }, async () => {
    await startDurableExecution(env, identity, runId, pins);
    return { stepId: runId };
  });
  const input = JSON.parse(execution.input_json) as RuntimeRecord;
  const triggerLink = await env.DB.prepare(
    "SELECT dispatch_id FROM control_durable_trigger_links WHERE run_id=?",
  )
    .bind(runId)
    .first<{ dispatch_id: string }>();
  const usedNames = new Set<string>();
  const authority = () => requireDurableExecutionAuthority(env, identity, runId, pins);
  const reserveName = (name: string) => {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(name) ||
      usedNames.has(name) ||
      usedNames.size >= execution.max_steps
    )
      fail("durable_step_name_invalid");
    usedNames.add(name);
  };
  const orchestrator: RuntimeDurableWorkflowContext = {
    async approval(definition) {
      definition = structuredClone(definition);
      if (!engine.waitForEvent) return fail("durable_approval_engine_unavailable");
      reserveName(`approval:${definition.key}`);
      await authority();
      await engine.do(
        `approval:${definition.key}`,
        { retries: { limit: 3, delay: 1000 }, timeout: 30000 },
        async () => {
          await authority();
          const row = await prepareDurableApproval(env, identity, runId, definition);
          return { stepId: row.id };
        },
      );
      // Revalidate the immutable definition even when the engine reuses its reference.
      const row = await prepareDurableApproval(env, identity, runId, definition);
      if (row.status === "requested") {
        try {
          await engine.waitForEvent(`approval-wait:${definition.key}`, {
            type: row.id,
            timeout: Math.max(1000, Date.parse(row.expires_at) - Date.now()),
          });
        } catch {
          await expireDurableApprovals(env);
          return fail("durable_approval_wait_failed");
        }
      }
      await authority();
      return consumeDurableApproval(env, identity, row.id, row.request_hash);
    },
    async step(definition, callback) {
      definition = structuredClone(definition);
      if (
        !Number.isInteger(definition.timeoutMs) ||
        definition.timeoutMs < 1 ||
        definition.timeoutMs > 300000 ||
        !Number.isInteger(definition.maxAttempts) ||
        definition.maxAttempts < 1 ||
        definition.maxAttempts > 5 ||
        (!definition.replaySafe && definition.maxAttempts !== 1)
      )
        return fail("durable_step_invalid");
      reserveName(definition.key);
      await authority();
      // Engine receipts contain only opaque D1 identities, never package data.
      const reference = await engine.do(
        `step:${definition.key}`,
        {
          retries: {
            limit: definition.replaySafe ? Math.max(0, definition.maxAttempts - 1) : 0,
            delay: definition.timeoutMs + 1000,
          },
          timeout: definition.timeoutMs + 15000,
        },
        async () => {
          await authority();
          const claim = await claimDurableStep(env, identity, runId, definition);
          if (!claim.execute) return { stepId: claim.stepId };
          const controller = new AbortController();
          const remaining = Math.max(1, Date.parse(claim.expiresAt) - Date.now());
          const timer = setTimeout(
            () => controller.abort(new Error("durable_step_timeout")),
            remaining,
          );
          const durableAttempt: DurableAttemptAuthority = {
            ...pins,
            configurationHash: execution.configuration_hash,
            runId,
            stepId: claim.stepId,
            attemptId: claim.attemptId,
          };
          try {
            let calls = 0;
            const context: AgentExecutionContext = {
              scope: { ...identity.scope, agentId: identity.agentId },
              pack: {
                id: execution.pack_id,
                version: execution.pack_version,
                runtimeVersion: execution.runtime_version,
              },
              run: {
                id: runId,
                workflowIntentId: execution.workflow_intent_id,
                executionMode: "dry_run",
                source: triggerLink ? "trigger" : "user",
              },
              signal: controller.signal,
              connections: defaultConnectionPort([]),
              actions: {
                async propose() {
                  return fail("durable_action_unavailable");
                },
                async execute() {
                  return fail("durable_action_unavailable");
                },
              },
              managedState: {
                async upsert() {
                  return fail("durable_legacy_port_unavailable");
                },
              },
              events: {
                async append() {
                  return fail("durable_legacy_port_unavailable");
                },
              },
              tools: {
                async invoke(toolId, toolInput) {
                  await authority();
                  if (!workflow.toolIds.includes(toolId)) return fail("tool_binding_unavailable");
                  const binding = runtime.controlPlane.tools.find((tool) => tool.id === toolId);
                  if (!binding) return fail("tool_binding_unavailable");
                  const authorization = await authorizeWorkflowTools(env, identity, {
                    toolNames: [toolId],
                    executionMode: "dry_run",
                    requestedRuntimeMs: binding.timeoutMs,
                    requestedArtifactBytes: binding.maxArtifactBytes,
                  });
                  if (!authorization.ok) return fail("durable_tool_policy_blocked");
                  return executeRuntimeToolBinding({
                    env,
                    identity,
                    binding,
                    toolInput,
                    context,
                    execution: {
                      runId,
                      workflowIntentId: execution.workflow_intent_id,
                      toolCallId: `step-${++calls}-${toolId}`,
                      durableAttempt,
                      packVersion: execution.pack_version,
                      runtimeVersion: execution.runtime_version,
                      bindingVersion: 1,
                      source: "agent-pack",
                    },
                  });
                },
              },
            };
            context.actions.simulate = createSimulationActionPort(env, identity, {
              context,
              toolIds: workflow.toolIds,
              durableAttempt,
            });
            if (contextIsRequired(runtime)) {
              context.context = await captureRuntimeContext(env, identity, {
                runId,
                runKind: "workflow",
                input,
                target: workflow.stateTarget ?? "simulation",
                signal: controller.signal,
                durableAttempt,
              });
              context.context?.assertReady();
            }
            if (env.WORKBENCH_TYPED_STATE_ENABLED === "true")
              context.state = await createRuntimeStatePort(env, identity, {
                packId: execution.pack_id,
                target: workflow.stateTarget ?? "simulation",
                definitions: runtime.controlPlane.state ?? [],
                signal: controller.signal,
                runId,
                durableAttempt,
                contextSnapshotId: context.context?.snapshot.id,
              });
            if (runtime.controlPlane.requirements.capabilities.includes("models.structured"))
              context.models = createRuntimeModelPort(env, identity, {
                runId,
                durableAttempt,
                signal: controller.signal,
                context: context.context,
              });
            controller.signal.throwIfAborted();
            const output = await Promise.race([
              Promise.resolve().then(() => callback(context)),
              new Promise<never>((_, reject) =>
                controller.signal.addEventListener(
                  "abort",
                  () =>
                    reject(
                      Object.assign(new Error("Step deadline exceeded"), {
                        code: "durable_step_timeout",
                      }),
                    ),
                  { once: true },
                ),
              ),
            ]);
            controller.signal.throwIfAborted();
            await authority();
            await finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, {
              status: "completed",
              output,
            });
            return { stepId: claim.stepId };
          } catch (error) {
            await finishDurableStep(env, identity, runId, claim.stepId, claim.attemptId, {
              status: "outcome_unknown",
              errorCode: codeOf(error),
            }).catch(() => undefined);
            throw Object.assign(new Error(codeOf(error)), { code: codeOf(error) });
          } finally {
            clearTimeout(timer);
            controller.abort();
          }
        },
      );
      await authority();
      return loadDurableStepOutput(env, identity, runId, reference.stepId, definition);
    },
    async sleep(key, durationMs) {
      if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 604800000)
        return fail("durable_wait_invalid");
      const result = await orchestrator.step(
        {
          key: `wait:${key}`,
          version: "1",
          payload: { durationMs },
          outputSchema: {
            type: "object",
            required: ["wakeAt"],
            properties: { wakeAt: { type: "integer" } },
          },
          timeoutMs: 10000,
          replaySafe: true,
          maxAttempts: 3,
        },
        () => ({ wakeAt: Math.min(Date.now() + durationMs, Date.parse(execution.deadline)) }),
      );
      await engine.sleepUntil(`wait:${key}`, Number(result.wakeAt));
      await authority();
    },
  };
  try {
    const output = await workflow.durable!.execute(input, orchestrator);
    assertSchemaValue(workflow.outputSchema, output, `${workflow.type} output`);
    await authority();
    await engine.do(
      "__finish",
      { retries: { limit: 3, delay: 1000 }, timeout: 30000 },
      async () => {
        await completeDurableExecution(env, identity, runId, { ok: true, output }, pins);
        return { stepId: runId };
      },
    );
  } catch (error) {
    // Cancellation/revocation must never regain authority through failure publication.
    await engine
      .do("__blocked", { retries: { limit: 3, delay: 1000 }, timeout: 30000 }, async () => {
        await completeDurableExecution(
          env,
          identity,
          runId,
          { ok: false, code: codeOf(error) },
          pins,
        );
        return { stepId: runId };
      })
      .catch(() => undefined);
    throw Object.assign(new Error(codeOf(error)), { code: codeOf(error) });
  }
  return { runId };
};

/** Stable instance IDs recover response loss between D1 admission and engine creation. */
export const startDurableWorkflowEngine = async (env: Env, execution: DurableExecution) => {
  if (!env.DURABLE_WORKFLOWS || env.WORKBENCH_DURABLE_WORKFLOWS_ENABLED !== "true")
    return fail("runtime_capability_disabled");
  if (execution.status === "closed") return;
  const current = await requireDurableExecutionAuthority(
    env,
    identityFor(execution),
    execution.run_id,
  );
  const acknowledged = await env.DB.prepare(
    "SELECT 1 FROM control_durable_engine_dispatches WHERE run_id=? AND status='accepted' LIMIT 1",
  )
    .bind(current.run_id)
    .first();
  if (current.status === "started" || acknowledged) {
    const instance = await env.DURABLE_WORKFLOWS.get(current.instance_id);
    if ((await instance.status()).status === "unknown")
      return fail("durable_engine_status_unknown");
    return;
  }
  const dispatchId = await beginDurableEngineDispatch(env, current);
  try {
    const created = await env.DURABLE_WORKFLOWS.create({
      id: current.instance_id,
      params: { runId: current.run_id },
    });
    if (created.id !== current.instance_id) throw new Error("durable_engine_identity_mismatch");
  } catch (error) {
    await settleDurableEngineDispatch(env, dispatchId, "outcome_unknown");
    try {
      const existing = await env.DURABLE_WORKFLOWS.get(execution.instance_id);
      const status = await existing.status();
      if (status.status !== "unknown") return;
    } catch {
      /* Creation may have failed before reaching the engine. Leave the startup intent pending. */
    }
    throw error;
  }
  await settleDurableEngineDispatch(env, dispatchId, "accepted");
};
