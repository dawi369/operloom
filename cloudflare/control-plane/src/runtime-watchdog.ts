import { finishPackWorkflowRun, type RuntimeRunIdentity } from "./runtime-run-lifecycle";
import { updateChatRun } from "./chat-boundary-store";
import { sessionCoordinatorStub } from "./session-coordinator";
import type { AgentIdentity, DurableObjectStorage, DurableObjectState, Env } from "./types";

export type RuntimeDeadline = {
  identity: AgentIdentity;
  deadline: number;
} & (
  | { run: RuntimeRunIdentity; workflowType: string; chat?: never }
  | {
      run: { runId: string };
      workflowType?: never;
      chat: { threadId: string; clientTurnId?: string; traceId: string };
    }
);
const storageKey = "runtime-deadlines";

export async function registerRuntimeDeadline(env: Env, input: RuntimeDeadline) {
  const stub = await sessionCoordinatorStub(env, input.identity);
  if (!stub) return; // In-process test harnesses have no Durable Objects.
  const response = await stub.fetch("https://session-agent.internal/run-deadline", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error("Unable to register workflow recovery deadline.");
}

export async function storeRuntimeDeadline(storage: DurableObjectStorage, input: RuntimeDeadline) {
  if (!storage.setAlarm) throw new Error("Durable workflow recovery requires alarms.");
  const pending = (await storage.get<RuntimeDeadline[]>(storageKey)) ?? [];
  const next = [...pending.filter((item) => item.run.runId !== input.run.runId), input];
  // Arm before writing: a crash cannot leave a persisted deadline without an alarm.
  await storage.setAlarm(Math.min(...next.map((item) => item.deadline)));
  await storage.put(storageKey, next);
}

export async function recoverRuntimeDeadlines(
  storage: DurableObjectStorage,
  env: Env,
  now = Date.now(),
) {
  const pending = (await storage.get<RuntimeDeadline[]>(storageKey)) ?? [];
  for (const item of pending.filter((entry) => entry.deadline <= now)) {
    if (item.chat) {
      const message = "Chat execution deadline expired. Your message is saved; retry when ready.";
      await updateChatRun(env, {
        runId: item.run.runId,
        scope: item.identity.scope,
        status: "failed",
        error: message,
        metadata: { errorCode: "runtime_timeout", retryable: true },
      });
      continue;
    }
    await finishPackWorkflowRun(env, item.identity, {
      ...item.run,
      workflowType: item.workflowType,
      ok: false,
      summary: "Workflow execution deadline expired. Review the run before retrying.",
      data: {
        error: {
          code: "runtime_timeout",
          message: "Execution deadline expired.",
          retryable: true,
          redacted: true,
        },
      },
    });
  }
  const remaining = pending.filter((entry) => entry.deadline > now);
  // Re-arm before removing processed entries; terminal writes are idempotent.
  if (remaining.length)
    await storage.setAlarm!(Math.min(...remaining.map((item) => item.deadline)));
  await storage.put(storageKey, remaining);
}

export async function handleRuntimeDeadlineRequest(request: Request, state: DurableObjectState) {
  const input = (await request.json()) as RuntimeDeadline;
  if (
    new URL(request.url).origin !== "https://session-agent.internal" ||
    !input.identity?.scope?.userId ||
    !input.identity.scope.workspaceId ||
    !input.run?.runId ||
    (!input.workflowType && !input.chat?.threadId) ||
    !Number.isFinite(input.deadline)
  ) {
    return new Response("Invalid deadline", { status: 400 });
  }
  await state.blockConcurrencyWhile(() => storeRuntimeDeadline(state.storage, input));
  return new Response(null, { status: 204 });
}
