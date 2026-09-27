import { internalErrorResponse, json } from "./http";
import { sessionCoordinatorName } from "./session-coordinator";
import type { AgentIdentity, Env } from "./types";

type SessionAction =
  | "get"
  | "list"
  | "create"
  | "stageThread"
  | "materializeTurn"
  | "activate"
  | "update"
  | "switchAgent";
type AgentSwitchTarget = "current_thread" | "new_thread";
type ThreadListStatus = "active" | "archived";
type ThreadMutationStatus = "active" | "archived" | "deleted";

const normalizeAgentSwitchTarget = (target: unknown): AgentSwitchTarget =>
  target === "new_thread" ? "new_thread" : "current_thread";

const agentHostFromRequest = (request: Request) => {
  const url = new URL(request.url);
  return url.origin;
};

const coordinatorResponse = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  input: {
    action: SessionAction | "stream";
    threadId?: string;
    refresh?: "threads";
    status?: ThreadListStatus;
    title?: string;
    message?: string;
    clientTurnId?: string;
    after?: string;
    update?: {
      title?: string;
      status?: ThreadMutationStatus;
      fallbackTitle?: string;
    };
    agentSwitch?: {
      agentId?: string;
      target?: AgentSwitchTarget;
    };
  },
) => {
  if (!env.SessionAgent) {
    return internalErrorResponse(
      "SessionAgent binding is not configured",
      new Error("SessionAgent binding is not configured"),
    );
  }

  const name = await sessionCoordinatorName(identity);
  const stub = env.SessionAgent.get(env.SessionAgent.idFromName(name));
  const response = await stub.fetch("https://session-agent.internal/session", {
    method: "POST",
    body: JSON.stringify({
      action: input.action,
      identity,
      threadId: input.threadId,
      refresh: input.refresh,
      status: input.status,
      title: input.title,
      message: input.message,
      clientTurnId: input.clientTurnId,
      after: input.after,
      update: input.update,
      agentSwitch: input.agentSwitch,
      agentHost: agentHostFromRequest(request),
    }),
  });
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    },
  });
};

export const handleChatSession = async (request: Request, env: Env, identity: AgentIdentity) =>
  coordinatorResponse(request, env, identity, {
    action: "get",
    refresh: new URL(request.url).searchParams.get("refresh") === "threads" ? "threads" : undefined,
  });

export const handleListChatSessionThreads = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) =>
  coordinatorResponse(request, env, identity, {
    action: "list",
    status: new URL(request.url).searchParams.get("status") === "archived" ? "archived" : "active",
  });

export const handleChatSessionStream = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  if (!env.SessionAgent) {
    return internalErrorResponse(
      "SessionAgent binding is not configured",
      new Error("SessionAgent binding is not configured"),
    );
  }

  const name = await sessionCoordinatorName(identity);
  const url = new URL(request.url);
  const after =
    url.searchParams.get("after")?.trim() ||
    request.headers.get("Last-Event-ID")?.trim() ||
    undefined;
  const stub = env.SessionAgent.get(env.SessionAgent.idFromName(name));
  const response = await stub.fetch("https://session-agent.internal/session", {
    method: "POST",
    body: JSON.stringify({
      action: "stream",
      identity,
      agentHost: agentHostFromRequest(request),
      after,
    }),
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "content-type": response.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
};

export const handleCreateChatSessionThread = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  const body = (await request.json().catch(() => ({}))) as { title?: unknown };
  return coordinatorResponse(request, env, identity, {
    action: "create",
    title: typeof body.title === "string" ? body.title : undefined,
  });
};

export const handleStageChatSessionThread = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) =>
  coordinatorResponse(request, env, identity, {
    action: "stageThread",
  });

export const handleMaterializeChatSessionTurn = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  const body = (await request.json().catch(() => ({}))) as {
    clientTurnId?: unknown;
    message?: unknown;
  };
  if (typeof body.message !== "string") {
    return json({ ok: false, error: "message is required" }, { status: 400 });
  }
  if (
    typeof body.clientTurnId !== "string" ||
    !body.clientTurnId.trim() ||
    body.clientTurnId.length > 128
  ) {
    return json({ ok: false, error: "clientTurnId is required" }, { status: 400 });
  }
  return coordinatorResponse(request, env, identity, {
    action: "materializeTurn",
    clientTurnId: body.clientTurnId,
    message: body.message,
  });
};

export const handleActivateChatSessionThread = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  threadId: string,
) => {
  if (!threadId.trim()) {
    return json({ ok: false, error: "threadId is required" }, { status: 400 });
  }
  return coordinatorResponse(request, env, identity, { action: "activate", threadId });
};

export const handleUpdateChatSessionThread = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
  threadId: string,
) => {
  if (!threadId.trim()) {
    return json({ ok: false, error: "threadId is required" }, { status: 400 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    title?: unknown;
    status?: unknown;
    fallbackTitle?: unknown;
  };
  return coordinatorResponse(request, env, identity, {
    action: "update",
    threadId,
    update: {
      title: typeof body.title === "string" ? body.title : undefined,
      status:
        body.status === "active" || body.status === "archived" || body.status === "deleted"
          ? body.status
          : undefined,
      fallbackTitle: typeof body.fallbackTitle === "string" ? body.fallbackTitle : undefined,
    },
  });
};

export const handleSwitchChatSessionAgent = async (
  request: Request,
  env: Env,
  identity: AgentIdentity,
) => {
  const body = (await request.json().catch(() => ({}))) as {
    agentId?: unknown;
    target?: unknown;
    threadId?: unknown;
  };
  if (typeof body.agentId !== "string" || !body.agentId.trim()) {
    return json({ ok: false, error: "agentId is required" }, { status: 400 });
  }
  return coordinatorResponse(request, env, identity, {
    action: "switchAgent",
    threadId: typeof body.threadId === "string" ? body.threadId : undefined,
    agentSwitch: {
      agentId: body.agentId,
      target: normalizeAgentSwitchTarget(body.target),
    },
  });
};
