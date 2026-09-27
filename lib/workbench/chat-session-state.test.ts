import { describe, expect, it } from "vitest";

import {
  activateThreadOptimistically,
  canCreateThreadFromSessionShell,
  createPendingThreadOptimistically,
  enterLocalNewSession,
  hasPendingActiveThread,
  mergeSession,
  removePendingThreads,
  removeThreadsFromSession,
  sessionEventRequiresConnectionRefresh,
  sessionFromEvent,
  shouldIgnoreSessionEvent,
  updateThreadStatusFromEvent,
} from "./chat-session-state";
import type {
  AgentSummary,
  ChatSessionResponse,
  ChatThreadSummary,
  WorkbenchSessionEvent,
} from "./workbench-types";

const workspace = {
  id: "workspace-1",
  name: "Workspace 1",
  status: "active",
  isDefault: true,
};

const agent = (id: string): AgentSummary => ({
  id,
  name: id,
  description: null,
  status: "active",
  isDefault: id === "agent-a",
  isActive: id === "agent-a",
  profile: "default",
  runtime: {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    temperature: 0.4,
    maxTokens: 1200,
    source: "system-default",
  },
  behavior: {
    profile: "default",
    source: "server-preset",
    version: "default",
    instructionId: "preset:default",
  },
});

const thread = (
  id: string,
  active = false,
  threadAgent = agent("agent-a"),
  input: Partial<ChatThreadSummary> = {},
): ChatThreadSummary => {
  const createdAt = id.endsWith("b") ? "2026-06-13T00:01:00.000Z" : "2026-06-13T00:00:00.000Z";
  return {
    threadId: id,
    sessionId: "session-1",
    agentId: threadAgent.id,
    agent: threadAgent,
    status: "active",
    title: id,
    createdAt,
    updatedAt: createdAt,
    isActive: active,
    messageCount: 0,
    ...input,
  };
};

const session = (input: Partial<ChatSessionResponse> = {}): ChatSessionResponse => ({
  ok: true,
  revision: 1,
  workspace,
  activeAgent: agent("agent-a"),
  activeThread: thread("thread-a", true),
  threads: [thread("thread-a", true)],
  ...input,
});

const event = (
  type: WorkbenchSessionEvent["type"],
  data: WorkbenchSessionEvent["data"],
  revision = 2,
): WorkbenchSessionEvent => ({
  id: `event-${type}`,
  type,
  revision,
  createdAt: "2026-06-13T00:00:00.000Z",
  data,
});

describe("chat-session-state", () => {
  it("replaces stale state with a full snapshot", () => {
    const incoming = session({
      revision: 11,
      partial: false,
      activeThread: thread("thread-b", true),
      threads: [thread("thread-b", true)],
    });

    const merged = mergeSession(session({ revision: 10 }), incoming);

    expect(merged.revision).toBe(11);
    expect(merged.activeThread?.threadId).toBe("thread-b");
    expect(merged.threads?.map((item) => item.threadId)).toEqual(["thread-b"]);
  });

  it("removes an optimistic deleted active thread and clears its connection", () => {
    const current = session({
      connection: {
        agentHost: "https://agent.example.com",
        agentName: "ThreadChatAgent",
        instanceName: "thread-a",
        token: "token",
        threadId: "thread-a",
        workspaceId: workspace.id,
        agentId: "agent-a",
      },
      expiresAt: "2026-06-13T00:10:00.000Z",
      threads: [thread("thread-a", true), thread("thread-b")],
    });

    const next = removeThreadsFromSession(current, new Set(["thread-a"]));

    expect(next?.activeThread).toBeNull();
    expect(next?.connection).toBeUndefined();
    expect(next?.expiresAt).toBeUndefined();
    expect(next?.threads?.map((item) => item.threadId)).toEqual(["thread-b"]);
    expect(next?.threads?.[0]?.isActive).toBe(false);
  });

  it("removes an optimistic deleted inactive thread without clearing active connection", () => {
    const current = session({
      connection: {
        agentHost: "https://agent.example.com",
        agentName: "ThreadChatAgent",
        instanceName: "thread-a",
        token: "token",
        threadId: "thread-a",
        workspaceId: workspace.id,
        agentId: "agent-a",
      },
      threads: [thread("thread-a", true), thread("thread-b")],
    });

    const next = removeThreadsFromSession(current, new Set(["thread-b"]));

    expect(next?.activeThread?.threadId).toBe("thread-a");
    expect(next?.connection?.threadId).toBe("thread-a");
    expect(next?.threads?.map((item) => item.threadId)).toEqual(["thread-a"]);
  });

  it("merges a token-free thread-created event into display state", () => {
    const newAgent = agent("agent-b");
    const nextThread = thread("thread-b", true, newAgent);
    const incoming = sessionFromEvent(
      event("session.thread.created", {
        workspace,
        activeAgent: newAgent,
        activeThread: nextThread,
        threads: [nextThread],
      }),
    );

    expect(incoming?.connection).toBeUndefined();

    const merged = mergeSession(session(), incoming!);

    expect(merged.activeThread?.threadId).toBe("thread-b");
    expect(merged.threads?.map((item) => item.threadId)).toEqual(["thread-b", "thread-a"]);
    expect(
      sessionEventRequiresConnectionRefresh(
        event("session.thread.created", { activeThread: nextThread }),
        merged,
        { threadId: "thread-a", agentId: "agent-a", workspaceId: workspace.id },
      ),
    ).toBe(true);
  });

  it("marks thread activation events as requiring connection reconciliation", () => {
    const nextThread = thread("thread-b", true, agent("agent-b"));
    const merged = mergeSession(
      session({ threads: [thread("thread-a", false), nextThread] }),
      sessionFromEvent(
        event("session.thread.activated", {
          workspace,
          activeAgent: nextThread.agent,
          activeThread: nextThread,
          threads: [nextThread],
        }),
      )!,
    );

    expect(
      sessionEventRequiresConnectionRefresh(
        event("session.thread.activated", { activeThread: nextThread }),
        merged,
        { threadId: "thread-a", agentId: "agent-a", workspaceId: workspace.id },
      ),
    ).toBe(true);
  });

  it("merges current-thread agent handoffs and refreshes a same-thread connection", () => {
    const nextAgent = agent("agent-b");
    const handoff = {
      id: "handoff-1",
      threadId: "thread-a",
      fromAgentId: "agent-a",
      fromAgentName: "Agent A",
      toAgentId: "agent-b",
      toAgentName: "Agent B",
      target: "current_thread" as const,
      createdAt: "2026-06-13T00:02:00.000Z",
    };
    const handedOffThread = thread("thread-a", true, nextAgent, {
      agentHandoff: handoff,
      updatedAt: handoff.createdAt,
    });
    const handoffEvent = event("session.agent.handoff", {
      workspace,
      activeAgent: nextAgent,
      activeThread: handedOffThread,
      threads: [handedOffThread],
      agentHandoff: handoff,
      transition: { type: "agent_handoff", startedAt: handoff.createdAt },
    });

    const incoming = sessionFromEvent(handoffEvent);
    const merged = mergeSession(
      session({
        connection: {
          agentHost: "https://agent.example.com",
          agentName: "ThreadChatAgent",
          instanceName: "thread-a",
          token: "token-a",
          threadId: "thread-a",
          workspaceId: workspace.id,
          agentId: "agent-a",
        },
      }),
      incoming!,
    );

    expect(merged.activeAgent?.id).toBe("agent-b");
    expect(merged.activeThread?.threadId).toBe("thread-a");
    expect(merged.activeThread?.agentId).toBe("agent-b");
    expect(merged.agentHandoff).toEqual(handoff);
    expect(merged.activeThread?.agentHandoff).toEqual(handoff);
    expect(
      sessionEventRequiresConnectionRefresh(handoffEvent, merged, {
        threadId: "thread-a",
        agentId: "agent-a",
        workspaceId: workspace.id,
      }),
    ).toBe(true);
    expect(
      sessionEventRequiresConnectionRefresh(handoffEvent, merged, {
        threadId: "thread-a",
        agentId: "agent-b",
        workspaceId: workspace.id,
      }),
    ).toBe(false);
  });

  it("merges a thread rename without changing thread identity", () => {
    const renamedThread = thread("thread-a", true, agent("agent-a"), {
      title: "Renamed chat",
    });
    const merged = mergeSession(
      session(),
      sessionFromEvent(
        event("session.thread.updated", {
          workspace,
          activeAgent: renamedThread.agent,
          activeThread: renamedThread,
          threads: [renamedThread],
          thread: renamedThread,
          transition: { type: "rename" },
        }),
      )!,
    );

    expect(merged.activeThread?.threadId).toBe("thread-a");
    expect(merged.activeThread?.title).toBe("Renamed chat");
    expect(merged.threads?.map((item) => item.threadId)).toEqual(["thread-a"]);
  });

  it("preserves a local display title when a partial event falls back to New chat", () => {
    const currentThread = thread("thread-a", true, agent("agent-a"), {
      title: "6:37:10 PM",
    });
    const fallbackThread = thread("thread-a", true, agent("agent-a"), {
      title: "New chat",
      updatedAt: "2026-06-13T00:02:00.000Z",
    });

    const merged = mergeSession(
      session({
        activeThread: currentThread,
        threads: [currentThread],
      }),
      sessionFromEvent(
        event("session.thread.activated", {
          workspace,
          activeAgent: fallbackThread.agent,
          activeThread: fallbackThread,
          threads: [fallbackThread],
        }),
      )!,
    );

    expect(merged.activeThread?.title).toBe("6:37:10 PM");
    expect(merged.threads?.[0]?.title).toBe("6:37:10 PM");
  });

  it("does not preserve a display title across different threads", () => {
    const currentThread = thread("thread-a", true, agent("agent-a"), {
      title: "6:37:10 PM",
    });
    const nextThread = thread("thread-b", true, agent("agent-a"), {
      title: "New chat",
    });

    const merged = mergeSession(
      session({
        activeThread: currentThread,
        threads: [currentThread],
      }),
      sessionFromEvent(
        event("session.thread.activated", {
          workspace,
          activeAgent: nextThread.agent,
          activeThread: nextThread,
          threads: [nextThread],
        }),
      )!,
    );

    expect(merged.activeThread?.threadId).toBe("thread-b");
    expect(merged.activeThread?.title).toBe("New chat");
  });

  it("removes archived threads from the active display list", () => {
    const fallbackThread = thread("thread-b", true);
    const archivedThread = thread("thread-a", false, agent("agent-a"), {
      status: "archived",
      title: "Archived chat",
    });
    const merged = mergeSession(
      session({
        activeThread: thread("thread-a", true),
        threads: [thread("thread-a", true), fallbackThread],
      }),
      sessionFromEvent(
        event("session.thread.updated", {
          workspace,
          activeAgent: fallbackThread.agent,
          activeThread: fallbackThread,
          threads: [fallbackThread],
          thread: archivedThread,
          transition: { type: "archive" },
        }),
      )!,
    );

    expect(merged.activeThread?.threadId).toBe("thread-b");
    expect(merged.threads?.map((item) => item.threadId)).toEqual(["thread-b"]);
    expect(
      sessionEventRequiresConnectionRefresh(
        event("session.thread.updated", { transition: { type: "archive" } }),
        merged,
        { threadId: "thread-a", agentId: "agent-a", workspaceId: workspace.id },
      ),
    ).toBe(true);
  });

  it("restores archived threads into the active display list", () => {
    const restoredThread = thread("thread-a", false, agent("agent-a"), {
      title: "Restored chat",
    });
    const fallbackThread = thread("thread-b", true);
    const merged = mergeSession(
      session({
        activeThread: fallbackThread,
        threads: [fallbackThread],
      }),
      sessionFromEvent(
        event("session.thread.updated", {
          workspace,
          activeAgent: fallbackThread.agent,
          activeThread: fallbackThread,
          threads: [restoredThread, fallbackThread],
          thread: restoredThread,
          transition: { type: "restore" },
        }),
      )!,
    );

    expect(merged.activeThread?.threadId).toBe("thread-b");
    expect(merged.threads?.map((item) => item.threadId)).toEqual(["thread-b", "thread-a"]);
  });

  it("removes soft-deleted threads from active and archived display state", () => {
    const fallbackThread = thread("thread-b", true);
    const deletedThread = thread("thread-a", false, agent("agent-a"), {
      status: "deleted",
      title: "Deleted chat",
    });
    const merged = mergeSession(
      session({
        activeThread: thread("thread-a", true),
        threads: [thread("thread-a", true), fallbackThread],
      }),
      sessionFromEvent(
        event("session.thread.updated", {
          workspace,
          activeAgent: fallbackThread.agent,
          activeThread: fallbackThread,
          threads: [fallbackThread],
          thread: deletedThread,
          transition: { type: "delete" },
        }),
      )!,
    );

    expect(merged.activeThread?.threadId).toBe("thread-b");
    expect(merged.threads?.map((item) => item.threadId)).toEqual(["thread-b"]);
  });

  it("clears active thread when a session event explicitly carries activeThread null", () => {
    const current = session({
      activeThread: thread("thread-a", true),
      threads: [thread("thread-a", true)],
    });
    const incoming = sessionFromEvent(
      event("session.thread.updated", {
        workspace,
        activeAgent: agent("agent-a"),
        activeThread: null,
        threads: [],
        transition: { type: "delete" },
      }),
    );

    const merged = mergeSession(current, incoming!);

    expect(merged.activeThread).toBeNull();
    expect(merged.threads).toEqual([]);
    expect(
      sessionEventRequiresConnectionRefresh(event("session.thread.updated", {}), merged, null),
    ).toBe(false);
  });

  it("identifies stale session events", () => {
    expect(
      shouldIgnoreSessionEvent(session({ revision: 5 }), event("session.snapshot", {}, 4)),
    ).toBe(true);
  });

  it("identifies stale lifecycle events so old rows cannot be resurrected", () => {
    const staleEvent = event(
      "session.thread.updated",
      {
        thread: thread("thread-a"),
        threads: [thread("thread-a")],
        transition: { type: "restore" },
      },
      4,
    );

    expect(
      shouldIgnoreSessionEvent(
        session({
          revision: 5,
          activeThread: thread("thread-b", true),
          threads: [thread("thread-b", true)],
        }),
        staleEvent,
      ),
    ).toBe(true);
  });

  it("removes a failed pending new-chat row", () => {
    const withPending = createPendingThreadOptimistically(
      session(),
      () => "fixed-id",
      () => "2026-06-13T00:00:00.000Z",
      "12:00 AM",
    );

    expect(withPending?.activeThread?.threadId).toBe("pending-thread-fixed-id");
    expect(withPending?.activeThread?.title).toBe("12:00 AM");

    const cleaned = removePendingThreads(withPending);

    expect(cleaned?.activeThread?.threadId).toBe("thread-a");
    expect(cleaned?.threads?.map((item) => item.threadId)).toEqual(["thread-a"]);
  });

  it("detects pending active new-chat state for local-first shell switching", () => {
    const withPending = createPendingThreadOptimistically(
      session(),
      () => "fixed-id",
      () => "2026-06-13T00:00:00.000Z",
      "12:00 AM",
    );

    expect(hasPendingActiveThread(withPending)).toBe(true);
    expect(hasPendingActiveThread(session())).toBe(false);
  });

  it("allows new-chat creation from a cached workspace and active agent shell", () => {
    expect(canCreateThreadFromSessionShell(session())).toBe(true);
    expect(canCreateThreadFromSessionShell(session({ activeAgent: null }))).toBe(false);
    expect(canCreateThreadFromSessionShell(session({ workspace: null }))).toBe(false);
    expect(canCreateThreadFromSessionShell(null)).toBe(false);
  });

  it("enters a local new-session shell without creating a visible thread", () => {
    const next = enterLocalNewSession(
      session({
        connection: {
          agentHost: "https://example.com",
          agentName: "thread-chat-agent",
          instanceName: "agent-instance",
          token: "token",
          threadId: "thread-a",
          sessionId: "session-1",
          workspaceId: workspace.id,
          agentId: "agent-a",
        },
        threads: [thread("thread-a", true), thread("thread-b")],
      }),
    );

    expect(next?.activeThread).toBeNull();
    expect(next?.connection).toBeUndefined();
    expect(next?.threads?.map((item) => [item.threadId, item.isActive])).toEqual([
      ["thread-a", false],
      ["thread-b", false],
    ]);
  });

  it("updates run status only for the matching thread", () => {
    const next = updateThreadStatusFromEvent(
      session({
        threads: [thread("thread-a", true), thread("thread-b")],
      }),
      event("chat.run.started", { threadId: "thread-b" }),
      () => "2026-06-13T00:00:00.000Z",
    );

    expect(next?.threads?.find((item) => item.threadId === "thread-a")?.latestRunStatus).toBe(
      undefined,
    );
    expect(next?.threads?.find((item) => item.threadId === "thread-b")?.latestRunStatus).toBe(
      "running",
    );
  });

  it("optimistically activates a cached thread", () => {
    const next = activateThreadOptimistically(
      session({ threads: [thread("thread-a", true), thread("thread-b")] }),
      "thread-b",
    );

    expect(next?.activeThread?.threadId).toBe("thread-b");
    expect(next?.pending).toEqual({ type: "activate", threadId: "thread-b" });
  });
});
