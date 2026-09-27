import { startDurableWorkflowEngine } from "./durable-workflow-runtime";
import {
  claimDurableRecovery,
  closeDurableRecovery,
  durableRecoveryFenceReason,
  listDueDurableRecoveries,
  releaseDurableRecovery,
  settleClosedDurableAttempts,
  type DurableRecovery,
  type RecoveryReason,
} from "./durable-recovery-store";
import type { Env } from "./types";

const terminalEngine = new Set(["errored", "terminated", "complete"]);
const knownEngine = new Set([
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waitingForPause",
  "unknown",
]);
const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("durable_engine_timeout")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const reconcile = async (env: Env, row: DurableRecovery) => {
  let engineStatus: string | null = null;
  let errorCode: string | null = null;
  let done = false;
  let closed = false;
  try {
    const fenced = await durableRecoveryFenceReason(env, row);
    if (fenced) {
      closed = await closeDurableRecovery(env, row, fenced);
    }
    if (!env.DURABLE_WORKFLOWS) throw new Error("durable_engine_unavailable");
    let instance: Awaited<ReturnType<NonNullable<Env["DURABLE_WORKFLOWS"]>["get"]>>;
    try {
      instance = await bounded(() => env.DURABLE_WORKFLOWS!.get(row.instance_id));
    } catch {
      // get() can throw for a never-created instance. A stable create is safe only while D1 is still pending.
      if (
        !closed &&
        row.status === "pending" &&
        env.WORKBENCH_DURABLE_WORKFLOWS_ENABLED === "true"
      ) {
        await bounded(() => startDurableWorkflowEngine(env, row));
        await releaseDurableRecovery(env, row, {
          engineStatus: null,
          errorCode: null,
          done: false,
        });
        return { closed, deferred: false };
      }
      throw new Error("durable_engine_unavailable");
    }
    const observed = await bounded(() => instance.status());
    engineStatus = knownEngine.has(observed.status) ? observed.status : "unknown";
    const current =
      await env.DB.prepare(`SELECT e.status,r.status run_status FROM control_durable_executions e
      JOIN control_runs r ON r.id=e.run_id WHERE e.run_id=? AND e.recovery_lease_id=?`)
        .bind(row.run_id, row.recovery_lease_id)
        .first<{ status: string; run_status: string }>();
    if (!current) return { closed, deferred: false };
    if (current.status !== "closed" && terminalEngine.has(engineStatus)) {
      const reason: RecoveryReason =
        engineStatus === "complete"
          ? "durable_projection_missing"
          : engineStatus === "errored"
            ? "durable_engine_errored"
            : "durable_engine_terminated";
      closed = await closeDurableRecovery(env, row, reason);
    }
    if (current.status === "closed" || closed) {
      await settleClosedDurableAttempts(env, row);
      if (terminalEngine.has(engineStatus)) done = true;
      else if (engineStatus !== "unknown") {
        // Canonical closure is already durable. Termination cannot authorize or replay work.
        await bounded(() => instance.terminate());
        // Observe the terminal status on a later pass, including a lost termination response.
      } else errorCode = "durable_engine_status_unknown";
    } else if (current.status === "pending" && engineStatus === "unknown") {
      if (env.WORKBENCH_DURABLE_WORKFLOWS_ENABLED === "true")
        await bounded(() => startDurableWorkflowEngine(env, row));
      else errorCode = "runtime_capability_disabled";
    } else if (engineStatus === "unknown") errorCode = "durable_engine_status_unknown";
  } catch {
    // Provider exception text can contain package data or credentials. Retain only this platform code.
    errorCode = "durable_recovery_retry";
  }
  await releaseDurableRecovery(env, row, { engineStatus, errorCode, done });
  return { closed, deferred: errorCode !== null };
};

/** Bounded, leased reconciliation; no engine restart or package-effect replay. */
export const recoverDurableExecutions = async (env: Env) => {
  const summary = { selected: 0, claimed: 0, closed: 0, deferred: 0, failed: 0 };
  const rows = (await listDueDurableRecoveries(env)).results;
  summary.selected = rows.length;
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (index < rows.length) {
        const { run_id: runId } = rows[index++];
        try {
          const row = await claimDurableRecovery(env, runId);
          if (!row) continue;
          summary.claimed++;
          const result = await reconcile(env, row);
          if (result.closed) summary.closed++;
          if (result.deferred) summary.deferred++;
        } catch {
          // Export fences and lease loss leave the row retryable. Other tenants still progress.
          summary.failed++;
        }
      }
    }),
  );
  return summary;
};
