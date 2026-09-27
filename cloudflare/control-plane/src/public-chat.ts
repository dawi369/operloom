import { selectAgent } from "./authz-store";
import { publicChatContracts } from "../../../packages/client/src/public-chat-contracts";
import { createChatSession, getOwnedChatThread, storeChatThread } from "./chat-boundary-store";
import {
  deriveThreadAgentInstanceName,
  resolveThreadAgentInstanceName,
} from "./chat-agent-connection-context";
import { signAgentConnectionClaims } from "./agent-connection-token";
import { json } from "./http";
import { createId, type AgentIdentity, type Env } from "./types";

/** Explicit threads avoid session-selected targets entirely. */
export const handleCreatePublicThread = async (env: Env, identity: AgentIdentity) => {
  const threadId = createId("cf-thread");
  const sessionId = await createChatSession(env, identity, { source: "public-api" });
  const instanceName = await deriveThreadAgentInstanceName({ ...identity.scope, threadId });
  await storeChatThread(env, identity, sessionId, threadId, {
    runtime: "cloudflare-agent-chat",
    instanceName,
  });
  return json({ ok: true, threadId, sessionId, agentId: identity.agentId }, { status: 201 });
};

export const handlePublicThreadOperation = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  threadId: string,
  operation: "turns" | "messages" | "cancel",
) => {
  const thread = await getOwnedChatThread(env, identity.scope, threadId);
  if (!thread || thread.agent_id !== identity.agentId || thread.status !== "active")
    return json({ ok: false, error: "Thread not found" }, { status: 404 });
  const agent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  if (!agent || agent.status !== "active")
    return json({ ok: false, error: "Agent is not active" }, { status: 403 });
  const secret = env.OPERLOOM_AGENT_CONNECTION_SECRET;
  if (!secret || !env.ThreadChatAgent)
    return json({ ok: false, error: "Chat runtime is not configured" }, { status: 503 });
  const instanceName = await resolveThreadAgentInstanceName(thread);
  const token = await signAgentConnectionClaims(secret, {
    v: 1,
    exp: Math.floor(Date.now() / 1000) + 60,
    nonce: crypto.randomUUID(),
    ...identity.scope,
    agentId: identity.agentId,
    accountId: identity.accountId,
    accountSource: identity.accountSource,
    agentUpdatedAt: agent.updated_at,
    agentRevision: agent.runtime_revision ?? 0,
    effectTarget: agent.effect_target ?? "simulation",
    threadId,
    sessionId: thread.session_id,
    instanceName,
    runtime: "cloudflare-agent-chat",
  });
  const stub = env.ThreadChatAgent.get(env.ThreadChatAgent.idFromName(instanceName));
  if (operation === "messages") {
    const transcript = await stub.fetch(
      `https://thread-agent.internal/internal/public-messages?token=${encodeURIComponent(token)}`,
    );
    if (!transcript.ok) return transcript;
    const body = (await transcript.json()) as Record<string, unknown>;
    const run = await env.DB.prepare(
      "SELECT id, status FROM chat_runs WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND thread_id = ? ORDER BY started_at DESC, id DESC LIMIT 1",
    )
      .bind(identity.scope.userId, identity.scope.workspaceId, identity.agentId, threadId)
      .first<{ id: string; status: string }>();
    return json({ ...body, run });
  }
  if (operation === "cancel")
    return stub.fetch("https://thread-agent.internal/internal/thread-cancel", {
      method: "POST",
      headers: { "x-operloom-agent-secret": secret },
    });
  const parsed = publicChatContracts["POST /chat/threads/{id}/turns"].request.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return json(
      {
        ok: false,
        code: "invalid_turn",
        error: "Provide text of 1–8000 characters and an optional bounded clientTurnId",
      },
      { status: 400 },
    );
  const body = parsed.data;
  const clientTurnId = request.headers.get("idempotency-key") ?? body?.clientTurnId;
  if (
    !body ||
    typeof body.text !== "string" ||
    !body.text.trim() ||
    body.text.length > 8000 ||
    typeof clientTurnId !== "string" ||
    !clientTurnId.trim() ||
    clientTurnId.length > 128
  )
    return json(
      { ok: false, code: "invalid_turn", error: "Provide bounded text and an idempotency key" },
      { status: 400 },
    );
  if (body.clientTurnId && body.clientTurnId !== clientTurnId)
    return json(
      {
        ok: false,
        code: "idempotency_conflict",
        error: "Turn identity does not match idempotency key",
      },
      { status: 409 },
    );
  const response = await stub.fetch("https://thread-agent.internal/internal/programmatic-submit", {
    method: "POST",
    body: JSON.stringify({
      token,
      threadId,
      sessionId: thread.session_id,
      message: body.text,
      clientTurnId,
    }),
  });
  return new Response(response.body, {
    status: response.ok ? 202 : response.status,
    headers: response.headers,
  });
};
