import type { Env } from "./types";

/** Reuses D1 and the existing scheduler. Publication and acknowledgement are one transaction. */
export const deliverRuntimeStateEvents = async (env: Env) => {
  if (env.WORKBENCH_TYPED_STATE_ENABLED !== "true") return { delivered: 0, deferred: 0 };
  const pending = await env.DB.prepare(`SELECT o.id FROM control_state_outbox o
    JOIN workspaces w ON w.id = o.workspace_id AND w.status = 'active'
    JOIN users u ON u.id = o.user_id AND u.status = 'active'
    JOIN memberships m ON m.user_id = o.user_id AND m.workspace_id = o.workspace_id AND m.status = 'active'
    JOIN agents a ON a.id = o.agent_id AND a.workspace_id = o.workspace_id AND a.status = 'active'
    WHERE o.status = 'pending' ORDER BY o.created_at, o.id LIMIT 100`).all<{ id: string }>();
  let delivered = 0;
  let deferred = 0;
  for (const { id } of pending.results) {
    try {
      const now = new Date().toISOString();
      const result = await env.DB.batch([
        env.DB.prepare(`INSERT INTO control_plane_events
          (id, user_id, workspace_id, agent_id, type, summary, target_type, target_id, data_json, created_at)
          SELECT 'state-event:' || o.id, o.user_id, o.workspace_id, o.agent_id, o.type,
            'Committed application state changed.', 'stateCommit', o.commit_id,
            json_object('commitId', o.commit_id, 'scopeId', o.scope_id, 'eventId', o.event_key, 'payload', json(o.data_json)), ?
          FROM control_state_outbox o
          JOIN workspaces w ON w.id = o.workspace_id AND w.status = 'active'
          JOIN users u ON u.id = o.user_id AND u.status = 'active'
          JOIN memberships m ON m.user_id = o.user_id AND m.workspace_id = o.workspace_id AND m.status = 'active'
          JOIN agents a ON a.id = o.agent_id AND a.workspace_id = o.workspace_id AND a.status = 'active'
          WHERE o.id = ? AND o.status = 'pending'
          ON CONFLICT(id) DO NOTHING`).bind(now, id),
        env.DB.prepare(`UPDATE control_state_outbox SET status = 'delivered', delivered_at = ?, attempts = attempts + 1
          WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM control_plane_events e WHERE e.id = 'state-event:' || control_state_outbox.id)`).bind(
          now,
          id,
        ),
      ]);
      delivered += result[1]?.meta?.changes ?? 0;
    } catch {
      // Export fencing and transient D1 outages preserve the intent for the next bounded tick.
      deferred++;
      // A poison intent must not indefinitely occupy the bounded backlog window.
      // Export fences can reject this write too; that leaves the attempt unconsumed.
      await env.DB.prepare(`UPDATE control_state_outbox
        SET attempts = attempts + 1, status = CASE WHEN attempts >= 7 THEN 'failed' ELSE 'pending' END
        WHERE id = ? AND status = 'pending'`)
        .bind(id)
        .run()
        .catch(() => {});
    }
  }
  return { delivered, deferred };
};
