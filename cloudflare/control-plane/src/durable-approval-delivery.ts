import { expireDurableApprovals, type DurableApprovalRow } from "./durable-approvals";
import type { Env } from "./types";

const clock = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const due = `p.status='approved' AND p.consumed_at IS NULL AND p.expires_at>${clock}
 AND p.wake_next_at<=${clock} AND (p.wake_lease_expires_at IS NULL OR p.wake_lease_expires_at<=${clock})
 AND EXISTS (SELECT 1 FROM control_runs r WHERE r.id=p.run_id AND r.workspace_id=p.workspace_id AND r.status='waiting')
 AND NOT EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id=p.workspace_id
   AND f.status='active' AND f.lease_expires_at>${clock})`;

export const deliverDurableApprovalWakes = async (env: Env, approvalId?: string) => {
  if (!approvalId) await expireDurableApprovals(env);
  if (env.WORKBENCH_DURABLE_WORKFLOWS_ENABLED !== "true" || !env.DURABLE_WORKFLOWS)
    return { selected: 0, delivered: 0 };
  const rows = await env.DB.prepare(`SELECT p.id FROM control_durable_approvals p WHERE ${due}
    AND (? IS NULL OR p.id=?) ORDER BY p.wake_next_at,p.id LIMIT 16`)
    .bind(approvalId ?? null, approvalId ?? null)
    .all<{ id: string }>();
  let delivered = 0;
  const deliver = async (id: string) => {
    const lease = crypto.randomUUID();
    await env.DB.prepare(`UPDATE control_durable_approvals SET wake_lease_id=?,
      wake_lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),wake_attempts=wake_attempts+1
      WHERE id IN (SELECT p.id FROM control_durable_approvals p WHERE p.id=? AND ${due})`)
      .bind(lease, id)
      .run();
    const row = await env.DB.prepare(
      "SELECT * FROM control_durable_approvals WHERE id=? AND wake_lease_id=?",
    )
      .bind(id, lease)
      .first<DurableApprovalRow>();
    if (!row) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let success = false;
    try {
      await Promise.race([
        (async () => {
          const instance = await env.DURABLE_WORKFLOWS!.get(row.run_id);
          if (!instance.sendEvent) throw new Error("durable_event_unavailable");
          await instance.sendEvent({ type: row.id, payload: { approvalId: row.id } });
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("durable_event_timeout")), 5000);
        }),
      ]);
      success = true;
    } catch {
      /* Keep a bounded platform code, never provider exception content. */
    } finally {
      clearTimeout(timer);
    }
    const next = new Date(
      Date.now() + Math.min(900000, 30000 * 2 ** Math.min(5, row.wake_attempts - 1)),
    ).toISOString();
    await env.DB.prepare(`UPDATE control_durable_approvals SET wake_lease_id=NULL,wake_lease_expires_at=NULL,
      wake_next_at=CASE WHEN consumed_at IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM control_runs r WHERE r.id=run_id AND r.status='waiting') THEN NULL ELSE ? END,
      wake_error_code=? WHERE id=? AND wake_lease_id=?`)
      .bind(success ? null : next, success ? null : "durable_approval_wake_retry", id, lease)
      .run();
    if (success) delivered++;
  };
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, rows.results.length) }, async () => {
      while (nextIndex < rows.results.length) await deliver(rows.results[nextIndex++]!.id);
    }),
  );
  return { selected: rows.results.length, delivered };
};
