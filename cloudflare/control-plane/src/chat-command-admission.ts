import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import { publicChatContracts } from "../../../packages/workbench-client/src/public-chat-contracts";
import { json } from "./http";
import type { AgentIdentity, Env } from "./types";

export type ChatCommand = {
  id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  thread_id: string;
  instance_name: string;
  turn_id: string;
  payload_hash: string;
  agent_revision: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  run_id: string | null;
  error_code: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};
const fail = (code: string, error: string, status = 409): never => {
  throw Object.assign(new Error(error), { code, status });
};
const authority = `SELECT 1 FROM agents a
 JOIN workspaces w ON w.id = a.workspace_id AND w.status = 'active'
 JOIN memberships m ON m.workspace_id = w.id AND m.status = 'active'
 JOIN users u ON u.id = m.user_id AND u.status = 'active'
 JOIN chat_threads t ON t.agent_id = a.id AND t.workspace_id = w.id AND t.user_id = u.id AND t.status IN ('active','draft')
 WHERE a.id = ? AND a.workspace_id = ? AND m.user_id = ? AND t.thread_id = ?
 AND a.status = 'active' AND a.runtime_revision = ?`;
const authorityValues = (identity: AgentIdentity, threadId: string) => [
  identity.agentId,
  identity.scope.workspaceId,
  identity.scope.userId,
  threadId,
  identity.agentRevision ?? 0,
];
export const chatCommandId = async (identity: AgentIdentity, threadId: string, turnId: string) =>
  `chat-command-${await sha256Hex(JSON.stringify([identity.scope.userId, identity.scope.workspaceId, threadId, turnId]))}`;
export const readChatCommand = (env: Env, id: string) =>
  env.DB.prepare("SELECT * FROM control_chat_commands WHERE id = ?").bind(id).first<ChatCommand>();

/** Reserve before touching the transcript; the upgrade transaction sees this row. */
export const reserveChatCommand = async (
  env: Env,
  identity: AgentIdentity,
  input: {
    threadId: string;
    instanceName: string;
    turnId: string;
    payloadHash: string;
  },
) => {
  if (
    !input.turnId.trim() ||
    input.turnId.length > 128 ||
    !/^[a-f0-9]{64}$/.test(input.payloadHash)
  )
    fail("invalid_turn", "Invalid command identity or payload hash", 400);
  const id = await chatCommandId(identity, input.threadId, input.turnId);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const prior = await readChatCommand(env, id);
  if (!prior) {
    try {
      await env.DB.prepare(`INSERT INTO control_chat_commands
        (id,user_id,workspace_id,agent_id,thread_id,instance_name,turn_id,payload_hash,agent_revision,status,created_at,updated_at,expires_at,preconditions_met)
        VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,CASE WHEN EXISTS (${authority})
          AND (SELECT COUNT(*) FROM control_chat_commands WHERE user_id = ? AND workspace_id = ? AND thread_id = ?) < 10000
          THEN 1 ELSE 0 END) ON CONFLICT(id) DO NOTHING`)
        .bind(
          id,
          identity.scope.userId,
          identity.scope.workspaceId,
          identity.agentId,
          input.threadId,
          input.instanceName,
          input.turnId,
          input.payloadHash,
          identity.agentRevision ?? 0,
          now,
          now,
          expiresAt,
          ...authorityValues(identity, input.threadId),
          identity.scope.userId,
          identity.scope.workspaceId,
          input.threadId,
        )
        .run();
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: control_chat_commands\.user_id/.test(error.message)
      )
        fail(
          "chat_command_busy",
          "A command is already active for this thread. Inspect or cancel it before submitting another",
        );
      if (error instanceof Error && error.message.includes("chat_command_precondition"))
        fail(
          "chat_command_admission_denied",
          "Current command authority changed or the thread command limit was reached",
        );
      throw error;
    }
  }
  const row = prior ?? (await readChatCommand(env, id));
  if (
    !row ||
    row.agent_id !== identity.agentId ||
    row.instance_name !== input.instanceName ||
    row.payload_hash !== input.payloadHash
  )
    fail("idempotency_conflict", "Turn key was already bound to different content or an agent");
  if (
    !(await env.DB.prepare(authority)
      .bind(...authorityValues(identity, input.threadId))
      .first())
  )
    fail("chat_command_admission_denied", "Current command authority changed");
  return row!;
};

export const acceptChatCommand = async (
  env: Env,
  identity: AgentIdentity,
  command: ChatCommand,
) => {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE control_chat_commands SET accepted_at = COALESCE(accepted_at, ?), updated_at = ?
    WHERE id = ? AND status = 'pending' AND expires_at > ? AND agent_revision = ? AND EXISTS (${authority})`)
    .bind(
      now,
      now,
      command.id,
      now,
      identity.agentRevision ?? 0,
      ...authorityValues(identity, command.thread_id),
    )
    .run();
  const row = await readChatCommand(env, command.id);
  if (!row?.accepted_at || row.status !== "pending")
    fail(
      "chat_command_closed",
      "Command acceptance was interrupted. Inspect its outcome before submitting a new key",
    );
  return row;
};

/** Terminal updates fence late admission, close a linked run and publish via D1 triggers. */
export const finishChatCommand = async (
  env: Env,
  id: string,
  status: "completed" | "failed" | "cancelled",
  errorCode: string | null = null,
  expiredBefore?: string,
) => {
  const now = new Date().toISOString();
  const predicate = `id = ? AND status IN ('pending','running')${expiredBefore ? " AND expires_at <= ?" : ""}`;
  const values = [id, ...(expiredBefore ? [expiredBefore] : [])];
  await env.DB.batch([
    env.DB.prepare(`UPDATE chat_runs SET status = ?, updated_at = ?,
      completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
      failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END,
      metadata_json = json_set(metadata_json, '$.errorCode', ?)
      WHERE status = 'running' AND id IN (SELECT run_id FROM control_chat_commands WHERE ${predicate})`).bind(
      status,
      now,
      status,
      now,
      status,
      now,
      errorCode,
      ...values,
    ),
    env.DB.prepare(
      `UPDATE control_chat_commands SET status = ?, error_code = ?, updated_at = ? WHERE ${predicate}`,
    ).bind(status, errorCode, now, ...values),
  ]);
};

export const cancelThreadChatCommands = async (env: Env, instanceName: string) => {
  const rows = await env.DB.prepare(
    "SELECT id FROM control_chat_commands WHERE instance_name = ? AND status IN ('pending','running') LIMIT 100",
  )
    .bind(instanceName)
    .all<{ id: string }>();
  for (const row of rows.results)
    await finishChatCommand(env, row.id, "cancelled", "chat_cancelled");
};

export const expireChatCommands = async (env: Env, now = new Date()) => {
  const rows = await env.DB.prepare(`SELECT c.id FROM control_chat_commands c
    WHERE c.status IN ('pending','running') AND c.expires_at <= ?
    AND NOT EXISTS (SELECT 1 FROM control_workspace_write_fences f WHERE f.workspace_id = c.workspace_id
      AND f.status = 'active' AND f.lease_expires_at > ?)
    ORDER BY c.expires_at,c.id LIMIT 100`)
    .bind(now.toISOString(), now.toISOString())
    .all<{ id: string }>();
  for (const row of rows.results)
    await finishChatCommand(env, row.id, "failed", "chat_command_timeout", now.toISOString());
  return { inspected: rows.results.length };
};

export const handleGetChatCommand = async (env: Env, identity: AgentIdentity, id: string) => {
  const row = await env.DB.prepare(`SELECT c.* FROM control_chat_commands c
    JOIN workspaces w ON w.id = c.workspace_id AND w.status = 'active'
    JOIN users u ON u.id = c.user_id AND u.status = 'active'
    JOIN memberships m ON m.user_id = c.user_id AND m.workspace_id = c.workspace_id AND m.status = 'active'
    JOIN agents a ON a.id = c.agent_id AND a.workspace_id = c.workspace_id AND a.status = 'active'
    WHERE c.id = ? AND c.user_id = ? AND c.workspace_id = ? AND c.agent_id = ?`)
    .bind(id, identity.scope.userId, identity.scope.workspaceId, identity.agentId)
    .first<ChatCommand>();
  if (!row)
    return json(
      { ok: false, code: "chat_command_not_found", error: "Chat command not found" },
      { status: 404 },
    );
  return json(
    publicChatContracts["GET /chat/commands/{id}"].response.parse({
      ok: true,
      command: {
        id: row.id,
        threadId: row.thread_id,
        messageId: row.turn_id,
        status: row.status,
        runId: row.run_id,
        acceptedAt: row.accepted_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        errorCode: row.error_code,
      },
    }),
  );
};
