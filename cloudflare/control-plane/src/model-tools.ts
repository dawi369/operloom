import { jsonSchema, tool, type ToolSet } from "ai";
import {
  type AgentExecutionContext,
  type RuntimeRecord,
  type RuntimeToolBinding,
} from "@operloom/agent-sdk/control-plane";

import { selectAgent, selectMembership } from "./authz-store";
import { resolveAgentBehaviorConfig } from "./agent-records";
import { readManagedStateVersion, upsertManagedState } from "./managed-state";
import { dispatchWorkbenchSessionEvent } from "./session-coordinator";
import {
  evaluateToolPolicy,
  recordToolPolicyDecision,
  toolPolicyError,
  toolPolicyCatalog,
} from "./tool-policy";
import { parseDataJson } from "./http";
import type { AgentIdentity, Env } from "./types";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import {
  finishPackWorkflowRun,
  recordPackWorkflowToolCall,
  startPackWorkflowRun,
} from "./runtime-run-lifecycle";
import { executeRuntimeToolBinding, runtimeToolFailure } from "./runtime-tool-execution";
import { createBrokeredConnectionPort } from "./connection-broker";
import { createDurableActionPort } from "./action-authority";

type ResolveModelToolsInput = {
  chatRunId: string | null;
  threadId: string;
  traceId: string;
};

type ModelToolExposure = {
  decision: string;
  code: string;
  reason: string;
  fastPath?: boolean;
};

const negativeModelToolCandidateCacheTtlMs = 30_000;
const negativeModelToolCandidateCache = new Map<string, { expiresAtMs: number }>();

const readDataFlag = (data: Record<string, unknown>, name: string, fallback: boolean) =>
  typeof data[name] === "boolean" ? data[name] : fallback;

const modelToolCandidateCacheKey = (identity: AgentIdentity, toolName: string) =>
  [identity.scope.userId, identity.scope.workspaceId, identity.agentId, toolName].join(":");

const readNegativeModelToolCandidateCache = (cacheKey: string, nowMs: number) => {
  const cached = negativeModelToolCandidateCache.get(cacheKey);
  if (!cached) return false;
  if (cached.expiresAtMs <= nowMs) {
    negativeModelToolCandidateCache.delete(cacheKey);
    return false;
  }
  return true;
};

const rememberNegativeModelToolCandidate = (cacheKey: string, nowMs: number) => {
  negativeModelToolCandidateCache.set(cacheKey, {
    expiresAtMs: nowMs + negativeModelToolCandidateCacheTtlMs,
  });
};

const resolvePermissionCandidate = (
  permission: { status: string; data_json: string } | null,
  defaults: NonNullable<(typeof toolPolicyCatalog)[string]>,
) => {
  if (!permission) {
    return defaults.status === "enabled" && defaults.modelVisible && !defaults.requiresApproval;
  }
  if (permission.status !== "enabled") return false;

  const data = parseDataJson(permission.data_json);
  return (
    readDataFlag(data, "modelVisible", defaults.modelVisible) &&
    !readDataFlag(data, "requiresApproval", defaults.requiresApproval)
  );
};

export const resetModelToolCandidateCacheForTests = () => {
  negativeModelToolCandidateCache.clear();
};

export const modelToolKey = (toolId: string) => {
  const normalized = toolId.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "runtime_tool";
};

export const runtimeModelToolBindingsForPack = (pack: {
  id: string;
  version: string;
  tools: readonly { id: string }[];
}) => {
  const runtime = resolvePackRuntime(pack.id, pack.version);
  if (!runtime.runnable) return [];
  return (runtime.controlPlane.tools as readonly RuntimeToolBinding[]).filter(
    (binding) =>
      binding.policy.modelVisible && pack.tools.some((declared) => declared.id === binding.id),
  );
};

const buildRuntimeModelTool = (input: {
  binding: RuntimeToolBinding;
  env: Env;
  identity: AgentIdentity;
  membership: Awaited<ReturnType<typeof selectMembership>>;
  pack: NonNullable<ReturnType<typeof resolveAgentBehaviorConfig>["pack"]>;
  runtimeVersion: string;
  request: ResolveModelToolsInput;
}) =>
  tool({
    description: input.binding.description,
    inputSchema: jsonSchema<RuntimeRecord>(input.binding.inputSchema),
    execute: async (toolInput) => {
      const callPolicy = await evaluateToolPolicy(input.env, input.identity, {
        membership: input.membership,
        toolName: input.binding.id,
        executionMode: "dry_run",
        surface: "model_tool_call",
      });
      const policyDecisionId = await recordToolPolicyDecision(input.env, input.identity, {
        toolName: input.binding.id,
        surface: "model_tool_call",
        result: callPolicy,
        data: {
          action: "model.tool.call",
          chatRunId: input.request.chatRunId,
          threadId: input.request.threadId,
          traceId: input.request.traceId,
          packId: input.pack.id,
          packVersion: input.pack.version,
          runtimeVersion: input.runtimeVersion,
          adapterVersion: input.binding.adapterVersion,
          transport: input.binding.transport,
        },
      });
      if (callPolicy.decision === "block") {
        return {
          ok: false,
          error: toolPolicyError(callPolicy),
          policyDecisionId,
        };
      }

      const started = await startPackWorkflowRun(input.env, input.identity, {
        workflowType: `tool.${input.binding.id}`,
        policyReference: input.binding.policy.reference,
        displayName: input.binding.description,
        packId: input.pack.id,
        toolInput,
        executionMode: "dry_run",
        engine: "cloudflare",
        source: "model",
        runtimeMetadata: {
          packVersion: input.pack.version,
          runtimeVersion: input.runtimeVersion,
          bindingVersion: 1,
          transports: [input.binding.transport],
          parentRunId: input.request.chatRunId,
          traceId: input.request.traceId,
        },
      });
      const toolCallId = `${started.runId}-tool-${input.binding.id.replaceAll(".", "-")}`;

      const controller = new AbortController();
      const timeout = setTimeout(
        () =>
          controller.abort(
            Object.assign(new Error("Runtime tool timed out."), {
              code: "runtime_timeout",
            }),
          ),
        input.binding.timeoutMs,
      );
      const context: AgentExecutionContext = {
        scope: { ...input.identity.scope, agentId: input.identity.agentId },
        pack: {
          id: input.pack.id,
          version: input.pack.version,
          runtimeVersion: input.runtimeVersion,
        },
        run: {
          id: started.runId,
          workflowIntentId: started.workflowIntentId,
          executionMode: "dry_run",
          source: "user",
        },
        signal: controller.signal,
        connections: createBrokeredConnectionPort(
          input.env,
          input.identity,
          input.pack.connections,
        ),
        actions: createDurableActionPort(input.env, input.identity, {
          packId: input.pack.id,
          packVersion: input.pack.version,
          runtimeVersion: input.runtimeVersion,
          bindingVersion: 1,
          runId: started.runId,
          workflowIntentId: started.workflowIntentId,
          toolCallId,
        }),
        tools: {
          async invoke() {
            throw Object.assign(new Error("Nested model-tool invocation is disabled."), {
              code: "nested_tool_invocation_disabled",
            });
          },
        },
        managedState: {
          async upsert(state) {
            const expectedVersion =
              state.expectedVersion ??
              (await readManagedStateVersion(input.env, input.identity, {
                namespace: state.namespace,
                stateType: state.stateType,
                stateKey: state.stateKey,
              }));
            const result = await upsertManagedState(input.env, input.identity, {
              ...state,
              expectedVersion,
            });
            if (!result.ok) {
              throw Object.assign(new Error("Managed-state compare-and-set conflict."), {
                code: "managed_state_version_conflict",
              });
            }
            return { id: result.state.id, version: result.state.version };
          },
        },
        events: {
          async append(type, summary, data) {
            await dispatchWorkbenchSessionEvent(input.env, input.identity, {
              type: "admin.summary.invalidated",
              data: {
                reason: "runtime-model-tool-event",
                runtimeEventType: type,
                summary,
                toolName: input.binding.id,
                traceId: input.request.traceId,
                ...data,
              },
            });
          },
        },
      };

      try {
        const result = await executeRuntimeToolBinding({
          env: input.env,
          identity: input.identity,
          binding: input.binding,
          toolInput,
          context,
          execution: {
            runId: started.runId,
            workflowIntentId: started.workflowIntentId,
            toolCallId,
            packVersion: input.pack.version,
            runtimeVersion: input.runtimeVersion,
            bindingVersion: 1,
            policyDecisionId,
            traceId: input.request.traceId,
            callbackUrl: input.env.WORKBENCH_CALLBACK_URL,
            source: "model",
          },
        });
        const artifactBytes = (result.artifacts ?? []).reduce(
          (total, artifact) => total + JSON.stringify(artifact.data).length,
          0,
        );
        const boundedResult =
          artifactBytes <= input.binding.maxArtifactBytes
            ? result
            : runtimeToolFailure(
                Object.assign(new Error("Runtime artifact limit exceeded."), {
                  code: "artifact_limit_exceeded",
                }),
              );
        await recordPackWorkflowToolCall(input.env, input.identity, {
          ...started,
          toolCallId,
          toolName: input.binding.id,
          status: boundedResult.ok ? "completed" : "failed",
          inputSummary: `Invoke ${input.binding.id}`,
          outputSummary: boundedResult.summary,
          data: {
            packId: input.pack.id,
            packVersion: input.pack.version,
            runtimeVersion: input.runtimeVersion,
            bindingVersion: 1,
            adapterVersion: input.binding.adapterVersion,
            transport: input.binding.transport,
            policyDecisionId,
            ...(boundedResult.ok
              ? { output: boundedResult.output }
              : { error: boundedResult.error }),
          },
        });
        const artifacts = (boundedResult.artifacts ?? []).map((artifact, index) => ({
          id: `${started.runId}-artifact-${index + 1}`,
          kind: artifact.kind,
          uri: `d1://control-plane/${started.runId}/${artifact.kind}-${index + 1}.json`,
          title: artifact.title,
          mimeType: artifact.mimeType,
          sizeBytes: JSON.stringify(artifact.data).length,
          data: artifact.data,
        }));
        const finished = await finishPackWorkflowRun(input.env, input.identity, {
          ...started,
          workflowType: `tool.${input.binding.id}`,
          ok: boundedResult.ok,
          summary: boundedResult.summary,
          artifacts,
          data: {
            packId: input.pack.id,
            packVersion: input.pack.version,
            runtimeVersion: input.runtimeVersion,
            bindingVersion: 1,
            adapterVersion: input.binding.adapterVersion,
            transport: input.binding.transport,
            policyDecisionId,
            parentRunId: input.request.chatRunId,
          },
        });
        if (!finished.applied) {
          return {
            ...runtimeToolFailure(
              Object.assign(new Error("Run publication authority was revoked."), {
                code: "run_terminal",
              }),
            ),
            toolName: input.binding.id,
            policyDecisionId,
            run: { ...started, status: "cancelled" },
          };
        }
        return {
          ...boundedResult,
          toolName: input.binding.id,
          policyDecisionId,
          runtimeVersion: input.runtimeVersion,
          adapterVersion: input.binding.adapterVersion,
          run: { ...started, status: boundedResult.ok ? "completed" : "failed" },
        };
      } catch (error) {
        return {
          ...runtimeToolFailure(error),
          toolName: input.binding.id,
          policyDecisionId,
          runtimeVersion: input.runtimeVersion,
          adapterVersion: input.binding.adapterVersion,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  });

export const hasModelVisibleToolCandidate = async (
  env: Env,
  identity: AgentIdentity,
  toolName: string,
) => {
  const defaults = toolPolicyCatalog[toolName];
  if (!defaults) return false;

  const cacheKey = modelToolCandidateCacheKey(identity, toolName);
  const nowMs = Date.now();
  if (readNegativeModelToolCandidateCache(cacheKey, nowMs)) return false;

  const agent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  const pack = resolveAgentBehaviorConfig(agent).pack;
  if (pack && !pack.tools.some((tool) => tool.id === toolName)) {
    rememberNegativeModelToolCandidate(cacheKey, nowMs);
    return false;
  }

  const permission = await env.DB.prepare(
    `SELECT status, data_json
     FROM tool_permissions
     WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND tool_id = ?
     LIMIT 1`,
  )
    .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, toolName)
    .first<{ status: string; data_json: string }>();

  const hasCandidate = resolvePermissionCandidate(permission, defaults);
  if (!hasCandidate) {
    rememberNegativeModelToolCandidate(cacheKey, nowMs);
    return false;
  }
  negativeModelToolCandidateCache.delete(cacheKey);
  return true;
};

export const resolveModelVisibleTools = async (
  env: Env,
  identity: AgentIdentity,
  input: ResolveModelToolsInput,
): Promise<{ tools: ToolSet; exposure: ModelToolExposure }> => {
  const agent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  const pack = resolveAgentBehaviorConfig(agent).pack;
  const runtime = pack ? resolvePackRuntime(pack.id, pack.version) : null;
  const genericBindings = pack ? runtimeModelToolBindingsForPack(pack) : [];
  const candidateFlags = await Promise.all(
    genericBindings.map((binding) => hasModelVisibleToolCandidate(env, identity, binding.id)),
  );
  if (!candidateFlags.some(Boolean)) {
    return {
      tools: {},
      exposure: {
        decision: "block",
        code: "no_model_visible_tools",
        reason: "No model-visible tools are enabled for this agent.",
        fastPath: true,
      },
    };
  }

  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  const allowedBindings: RuntimeToolBinding[] = [];
  let firstBlockedPolicy: Awaited<ReturnType<typeof evaluateToolPolicy>> | null = null;
  for (const [index, binding] of genericBindings.entries()) {
    if (!candidateFlags[index]) continue;
    const policy = await evaluateToolPolicy(env, identity, {
      membership,
      toolName: binding.id,
      executionMode: "dry_run",
      surface: "model_exposure",
    });
    if (policy.decision === "allow") allowedBindings.push(binding);
    else firstBlockedPolicy ??= policy;
  }
  if (allowedBindings.length === 0) {
    return {
      tools: {},
      exposure: {
        decision: "block",
        code: firstBlockedPolicy?.code ?? "no_model_visible_tools",
        reason: firstBlockedPolicy?.reason ?? "No model-visible tools are enabled for this agent.",
      },
    };
  }

  const runtimeTools =
    pack && runtime?.runnable
      ? Object.fromEntries(
          allowedBindings.map((binding) => [
            modelToolKey(binding.id),
            buildRuntimeModelTool({
              binding,
              env,
              identity,
              membership,
              pack,
              runtimeVersion: runtime.runtimeVersion,
              request: input,
            }),
          ]),
        )
      : {};

  return {
    exposure: {
      decision: "allow",
      code: "allowed",
      reason: `${allowedBindings.length} model-visible runtime tool(s) are enabled.`,
    },
    tools: runtimeTools,
  };
};
