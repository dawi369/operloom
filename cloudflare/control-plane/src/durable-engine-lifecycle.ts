import { durableExecutionLiveSql } from "./durable-attempt-authority";
import type { DurableExecution } from "./durable-execution-store";
import type { Env } from "./types";

/** Persist before dispatch: a crash or lost response must not erase a possible late creation. */
export const beginDurableEngineDispatch = async (env: Env, execution: DurableExecution) => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO control_durable_engine_dispatches
      (id,user_id,workspace_id,agent_id,run_id,instance_id,status,created_at,preconditions_met)
     VALUES (?,?,?,?,?,?,'dispatching',?,CASE WHEN EXISTS (
       ${durableExecutionLiveSql("'queued','running'")}
       AND e.instance_id=? AND e.engine_deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM control_durable_engine_dispatches d
         WHERE d.run_id=e.run_id AND d.status='accepted')
     ) THEN 1 ELSE 0 END)`,
  )
    .bind(
      id,
      execution.user_id,
      execution.workspace_id,
      execution.agent_id,
      execution.run_id,
      execution.instance_id,
      now,
      execution.run_id,
      execution.user_id,
      execution.workspace_id,
      execution.agent_id,
      now,
      execution.instance_id,
    )
    .run();
  return id;
};

export const settleDurableEngineDispatch = async (
  env: Env,
  id: string,
  status: "accepted" | "outcome_unknown",
) => {
  await env.DB.prepare(
    `UPDATE control_durable_engine_dispatches SET status=?,settled_at=?
     WHERE id=? AND status='dispatching'`,
  )
    .bind(status, new Date().toISOString(), id)
    .run();
};

/** One bounded page; true means all native identities have confirmed deletion. */
export const purgeDurableEngines = async (env: Env, workspaceId: string) => {
  // Fail before the external action when the workspace is not irreversibly purging.
  if (
    !(await env.DB.prepare(`SELECT 1 FROM workspaces w WHERE id=? AND status='purging'
    AND NOT EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=w.id
      AND f.status='active' AND f.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(workspaceId)
      .first())
  )
    throw new Error("workspace_purge_authority_revoked");
  const pending = await env.DB.prepare(
    `SELECT 1 FROM control_durable_engine_dispatches
     WHERE workspace_id=? AND status!='accepted' LIMIT 1`,
  )
    .bind(workspaceId)
    .first();
  if (pending) throw new Error("durable_engine_dispatch_unresolved");
  const rows = await env.DB.prepare(
    `SELECT instance_id FROM control_durable_executions
     WHERE workspace_id=? AND engine_deleted_at IS NULL ORDER BY run_id LIMIT 25`,
  )
    .bind(workspaceId)
    .all<{ instance_id: string }>();
  if (!rows.results.length) return true;
  if (!env.DURABLE_WORKFLOWS?.deleteBatch) throw new Error("durable_engine_deletion_unavailable");
  const ids = rows.results.map((row) => row.instance_id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    env.DURABLE_WORKFLOWS.deleteBatch(ids),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("durable_engine_deletion_timeout")), 10000);
    }),
  ])
    .catch(() => {
      throw new Error("durable_engine_deletion_unconfirmed");
    })
    .finally(() => clearTimeout(timer));
  // Do not persist provider errors or accept an incomplete/foreign/duplicate result.
  if (!result || !Array.isArray(result.deleted) || !Array.isArray(result.errors))
    throw new Error("durable_engine_deletion_invalid_result");
  const outcomes = new Map<string, boolean>();
  const add = (entry: { id: string }, deleted: boolean) => {
    if (!entry || !ids.includes(entry.id) || outcomes.has(entry.id))
      throw new Error("durable_engine_deletion_invalid_result");
    outcomes.set(entry.id, deleted);
  };
  for (const entry of result.deleted) add(entry, true);
  for (const entry of result.errors) {
    if (!entry || !Number.isInteger(entry.code) || typeof entry.message !== "string")
      throw new Error("durable_engine_deletion_invalid_result");
    add(entry, entry.code === 10400 && entry.message === "workflows.api.error.instance.not_found");
  }
  if (outcomes.size !== ids.length) throw new Error("durable_engine_deletion_invalid_result");
  const deleted = ids.filter((id) => outcomes.get(id));
  if (deleted.length)
    await env.DB.batch(
      deleted.map((id) =>
        env.DB.prepare(
          `UPDATE control_durable_executions SET engine_deleted_at=?
     WHERE workspace_id=? AND instance_id=? AND engine_deleted_at IS NULL`,
        ).bind(new Date().toISOString(), workspaceId, id),
      ),
    );
  if (deleted.length !== ids.length) throw new Error("durable_engine_deletion_incomplete");
  return !(await env.DB.prepare(
    "SELECT 1 FROM control_durable_executions WHERE workspace_id=? AND engine_deleted_at IS NULL LIMIT 1",
  )
    .bind(workspaceId)
    .first());
};
