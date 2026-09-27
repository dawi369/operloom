import {
  createChatSession,
  getLatestChatIntent,
  getLatestChatPolicyDecision,
  getLatestChatRun,
  getLatestChatSession,
  getOwnedChatSession,
  getOwnedChatThread,
  toChatIntentSnapshot,
  toChatPolicyDecisionSnapshot,
  toChatRunSnapshot,
  toChatSessionSnapshot,
  toChatThreadSnapshot,
} from "./chat-boundary-store";
import { toAgentRuntimeMetadata } from "./agent-records";
import { appendControlPlaneEvent } from "./control-plane-events";
import { selectAgent } from "./authz-store";
import { isRecord, json, parseJson } from "./http";
import type { AgentIdentity, Env } from "./types";

export const handleChatBoundarySnapshot = async (
  env: Env,
  identity: AgentIdentity,
  threadId: string,
) => {
  const thread = await getOwnedChatThread(env, identity.scope, threadId);
  if (!thread) return json({ ok: false, error: "Thread not found" }, { status: 404 });

  const session = await getOwnedChatSession(env, identity.scope, thread.session_id);
  const latestRun = await getLatestChatRun(env, identity.scope, threadId);
  const latestIntent = await getLatestChatIntent(env, identity.scope, threadId);
  const latestPolicyDecision = await getLatestChatPolicyDecision(env, identity.scope, threadId);
  return json({
    ok: true,
    session: toChatSessionSnapshot(session),
    thread: toChatThreadSnapshot(thread),
    latestIntent: toChatIntentSnapshot(latestIntent),
    latestPolicyDecision: toChatPolicyDecisionSnapshot(latestPolicyDecision),
    latestRun: toChatRunSnapshot(latestRun),
  });
};

export const handleCreateChatSession = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  const raw = await request.text();
  const parsed = raw ? parseJson(raw) : null;
  const metadata = isRecord(parsed) && isRecord(parsed.metadata) ? parsed.metadata : {};
  const activeAgent = await selectAgent(env, identity.agentId, identity.scope.workspaceId);
  const agentMetadata = toAgentRuntimeMetadata(env, activeAgent, identity.agentId);
  const sessionId = await createChatSession(env, identity, {
    ...metadata,
    agent: agentMetadata,
  });
  await appendControlPlaneEvent(env, identity, {
    type: "chat.session.created",
    summary: "Created chat session.",
    targetType: "chat_session",
    targetId: sessionId,
    data: { source: "sessions-api", agent: agentMetadata },
  });
  const session = await getOwnedChatSession(env, identity.scope, sessionId);
  return json({ ok: true, session: toChatSessionSnapshot(session) }, { status: 201 });
};

export const handleLatestChatSession = async (env: Env, identity: AgentIdentity) => {
  const session = await getLatestChatSession(env, identity.scope);
  return json({ ok: true, session: toChatSessionSnapshot(session) });
};

export const handleGetChatSession = async (
  env: Env,
  identity: AgentIdentity,
  sessionId: string,
) => {
  const session = await getOwnedChatSession(env, identity.scope, sessionId);
  if (!session) return json({ ok: false, error: "Session not found" }, { status: 404 });
  return json({ ok: true, session: toChatSessionSnapshot(session) });
};
