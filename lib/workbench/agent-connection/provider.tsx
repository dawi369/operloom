"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  usePublishWorkbenchSession,
  useWorkbenchSessionEventInvalidation,
} from "@operloom/workbench-react";

import { requestWorkbenchSummaryRefresh } from "@/lib/workbench/admin-summary-events";
import { browserWorkbenchClient } from "@/lib/workbench/browser-client";
import {
  activateThreadOptimistically,
  canCreateThreadFromSessionShell,
  enterLocalNewSession,
  formatCurrentThreadTitle,
  mergeSession,
  removePendingThreads,
  removeThreadsFromSession,
  sessionEventRequiresConnectionRefresh,
  sessionFromEvent,
  shouldIgnoreSessionEvent,
  updateThreadStatusFromEvent,
  type PendingSessionTransition,
} from "@/lib/workbench/chat-session-state";
import { sessionEventShouldRefreshAdminSummary } from "@/lib/workbench/session-event-refresh-policy";
import type {
  AgentSwitchTarget,
  ChatSessionResponse,
  WorkbenchSessionEvent,
} from "@/lib/workbench/workbench-types";
import { sessionContainsThread } from "@/lib/workbench/agent-connection/delete-reconciliation";
import {
  minimumRefreshDelayMs,
  readInitialCachedShell,
  readSession,
  sessionFromCachedShell,
  toConnection,
  tokenRefreshSkewMs,
  warmupFreshMs,
  writeCachedShell,
  type ChatSessionContextValue,
  type LoadSessionInput,
  type OptimisticDeleteRollback,
  type SessionReadSource,
  type SessionStageSource,
  type SessionWarmupSource,
  type WorkbenchAgentConnection,
} from "@/lib/workbench/agent-connection/session-runtime";
import { useArchivedThreadsResource } from "@/lib/workbench/agent-connection/use-archived-threads-resource";
import { useSessionEventStream } from "@/lib/workbench/agent-connection/use-session-event-stream";

export type {
  CachedChatSessionShell,
  WorkbenchAgentConnection,
} from "@/lib/workbench/agent-connection/session-runtime";

const ChatSessionContext = createContext<ChatSessionContextValue | null>(null);

export function ChatSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ChatSessionResponse | null>(() =>
    sessionFromCachedShell(readInitialCachedShell()),
  );
  const [connection, setConnection] = useState<WorkbenchAgentConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSessionStreamConnected, setIsSessionStreamConnected] = useState(false);
  const [latestSessionEvent, setLatestSessionEvent] = useState<WorkbenchSessionEvent | null>(null);
  const [latestChatRunEvent, setLatestChatRunEvent] = useState<WorkbenchSessionEvent | null>(null);
  const [pending, setPending] = useState<PendingSessionTransition | null>({ type: "initial" });
  const [localNewSession, setLocalNewSession] = useState(false);
  const [deletingThreadIds, setDeletingThreadIds] = useState<ReadonlySet<string>>(() => new Set());
  const connectionRef = useRef<WorkbenchAgentConnection | null>(null);
  const localNewSessionRef = useRef(false);
  const loadSessionRef = useRef<((input?: LoadSessionInput) => Promise<void>) | null>(null);
  const warmupPromiseRef = useRef<Promise<void> | null>(null);
  const stagePromiseRef = useRef<Promise<ChatSessionResponse | null> | null>(null);
  const lastWarmupRef = useRef<{ completedAt: number; ok: boolean } | null>(null);
  const deletingThreadIdsRef = useRef<ReadonlySet<string>>(new Set());
  const deleteRollbacksRef = useRef<Map<string, OptimisticDeleteRollback>>(new Map());
  const threadRefreshTimeoutRef = useRef<number | null>(null);
  const workspaceId = session?.workspace?.id;
  usePublishWorkbenchSession(session);
  useWorkbenchSessionEventInvalidation(latestSessionEvent, workspaceId);
  const {
    archivedThreads,
    archivedThreadsError,
    isLoadingArchivedThreads,
    loadArchivedThreads,
    refreshArchivedThreadsIfLoaded,
    setArchivedThreads,
  } = useArchivedThreadsResource({
    workspaceId,
    preload: Boolean(workspaceId && !session?.isStale),
  });

  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  useEffect(() => {
    deletingThreadIdsRef.current = deletingThreadIds;
  }, [deletingThreadIds]);

  const scheduleThreadRefresh = useCallback((source: SessionReadSource, delayMs = 100) => {
    if (threadRefreshTimeoutRef.current !== null) {
      window.clearTimeout(threadRefreshTimeoutRef.current);
    }
    threadRefreshTimeoutRef.current = window.setTimeout(() => {
      threadRefreshTimeoutRef.current = null;
      void loadSessionRef.current?.({ refresh: "threads", refreshSummary: false, source });
    }, delayMs);
  }, []);

  useEffect(
    () => () => {
      if (threadRefreshTimeoutRef.current !== null) {
        window.clearTimeout(threadRefreshTimeoutRef.current);
      }
    },
    [],
  );

  const applySession = useCallback(
    (
      nextSession: ChatSessionResponse,
      input?: { preserveConnection?: boolean; preserveLocalNew?: boolean },
    ) => {
      const filteredSession =
        removeThreadsFromSession(nextSession, deletingThreadIdsRef.current) ?? nextSession;
      let effectiveSession = input?.preserveLocalNew
        ? (enterLocalNewSession(filteredSession) ?? filteredSession)
        : filteredSession;
      const currentConnection = connectionRef.current;
      if (
        input?.preserveConnection &&
        currentConnection &&
        currentConnection.threadId === effectiveSession.activeThread?.threadId &&
        currentConnection.agentId === effectiveSession.activeAgent?.id
      ) {
        effectiveSession = {
          ...effectiveSession,
          connection: currentConnection,
          expiresAt: currentConnection.expiresAt,
        };
      }
      const nextConnection = toConnection(effectiveSession);
      if (!nextConnection && effectiveSession.activeThread) {
        throw new Error("Cloudflare Agent connection response was incomplete");
      }
      connectionRef.current = nextConnection;
      setSession((current) => {
        const merged = mergeSession(current, effectiveSession);
        writeCachedShell(merged);
        return merged;
      });
      setConnection(nextConnection);
      if (effectiveSession.activeThread && !input?.preserveLocalNew) {
        localNewSessionRef.current = false;
        setLocalNewSession(false);
      }
    },
    [],
  );

  const loadSession = useCallback(
    async (input: LoadSessionInput = {}) => {
      const startedAt = performance.now();
      let requestOk = false;
      const transition =
        input.action === "create"
          ? ({ type: "create" } as const)
          : input.action === "activate" && input.threadId
            ? ({ type: "activate", threadId: input.threadId } as const)
            : input.update?.title !== undefined && input.threadId
              ? ({ type: "rename", threadId: input.threadId } as const)
              : input.update?.status === "archived" && input.threadId
                ? ({ type: "archive", threadId: input.threadId } as const)
                : input.update?.status === "active" && input.threadId
                  ? ({ type: "restore", threadId: input.threadId } as const)
                  : input.update?.status === "deleted" && input.threadId
                    ? ({ type: "delete", threadId: input.threadId } as const)
                    : !connectionRef.current && !input.preload
                      ? ({ type: "initial" } as const)
                      : null;

      if (transition) setPending(transition);
      if (input.optimistic && input.action === "activate" && input.threadId) {
        setSession((current) => activateThreadOptimistically(current, input.threadId!));
      }

      try {
        setError(null);
        const nextSession = await readSession(input);
        requestOk = true;
        const preserveLocalNew = localNewSessionRef.current && !input.action && !input.update;
        applySession(nextSession, {
          preserveConnection: input.refresh === "threads",
          preserveLocalNew,
        });
        if (
          input.threadId &&
          (input.update?.status === "active" || input.update?.status === "deleted")
        ) {
          setArchivedThreads((current) =>
            current.filter((thread) => thread.threadId !== input.threadId),
          );
        }
        if (input.update) refreshArchivedThreadsIfLoaded();
        if (input.refreshSummary ?? input.action !== undefined) {
          requestWorkbenchSummaryRefresh({ source: "event" });
        }
        if (nextSession.threadsRefreshRecommended && input.action !== undefined) {
          scheduleThreadRefresh("post-action");
        }
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : "Agent connection failed";
        if (input.action === "create") {
          setSession((current) => removePendingThreads(current));
        }
        if (localNewSessionRef.current && !input.action && !input.update) {
          console.warn("Cloudflare Agent local-new preload failed", nextError);
          return;
        }
        if (
          !connectionRef.current ||
          input.action === "create" ||
          input.action === "activate" ||
          input.update
        ) {
          setError(message);
        } else {
          console.warn("Cloudflare Agent session refresh failed", nextError);
        }
      } finally {
        if (input.preload) {
          const durationMs = Math.round(performance.now() - startedAt);
          lastWarmupRef.current = { completedAt: Date.now(), ok: requestOk };
          if (process.env.NODE_ENV !== "production") {
            console.debug("Cloudflare Agent session warmup", {
              durationMs,
              ok: requestOk,
              source: input.source ?? "new-session",
            });
          }
        }
        if (transition) setPending(null);
      }
    },
    [applySession, refreshArchivedThreadsIfLoaded, scheduleThreadRefresh],
  );

  useEffect(() => {
    loadSessionRef.current = loadSession;
  }, [loadSession]);

  const preloadNewSession = useCallback((source: SessionWarmupSource) => {
    const lastWarmup = lastWarmupRef.current;
    if (warmupPromiseRef.current) return;
    if (lastWarmup?.ok && Date.now() - lastWarmup.completedAt < warmupFreshMs) return;
    const warmupPromise =
      loadSessionRef.current?.({
        refresh: "threads",
        refreshSummary: false,
        preload: true,
        source,
      }) ?? Promise.resolve();
    warmupPromiseRef.current = warmupPromise;
    warmupPromise.finally(() => {
      if (warmupPromiseRef.current === warmupPromise) {
        warmupPromiseRef.current = null;
      }
    });
  }, []);

  const stageNewSession = useCallback(
    async (source: SessionStageSource) => {
      if (stagePromiseRef.current) return stagePromiseRef.current;

      const startedAt = performance.now();
      const stagePromise = (async () => {
        try {
          setError(null);
          const nextSession = await browserWorkbenchClient.session.stageThread({ source });
          applySession(nextSession);
          if (process.env.NODE_ENV !== "production") {
            console.debug("Cloudflare Agent stage thread", {
              durationMs: Math.round(performance.now() - startedAt),
              ok: true,
              source,
            });
          }
          return nextSession;
        } catch (nextError) {
          if (process.env.NODE_ENV !== "production") {
            console.debug("Cloudflare Agent stage thread", {
              durationMs: Math.round(performance.now() - startedAt),
              ok: false,
              source,
            });
          }
          if (localNewSessionRef.current) {
            console.warn("Cloudflare Agent staging failed", nextError);
          } else {
            const message =
              nextError instanceof Error ? nextError.message : "Failed to prepare chat";
            setError(message);
          }
          return null;
        } finally {
          stagePromiseRef.current = null;
        }
      })();

      stagePromiseRef.current = stagePromise;
      return stagePromise;
    },
    [applySession],
  );

  const startNewSession = useCallback(() => {
    localNewSessionRef.current = true;
    setLocalNewSession(true);
    setError(null);
    setPending(null);
    connectionRef.current = null;
    setConnection(null);
    setSession((current) => enterLocalNewSession(current));
    window.setTimeout(() => {
      void stageNewSession("new-session");
    }, 0);
  }, [stageNewSession]);

  const materializeTurn = useCallback(
    async (message: string, clientTurnId = crypto.randomUUID()) => {
      const normalized = message.trim();
      if (!normalized) return;
      const startedAt = performance.now();
      const warmup = lastWarmupRef.current;
      const hadWarmSession = Boolean(warmup?.ok && Date.now() - warmup.completedAt < warmupFreshMs);
      setPending({ type: "materialize" });
      try {
        setError(null);
        const nextSession = await browserWorkbenchClient.session.materializeTurn({
          clientTurnId,
          clientWarmSession: hadWarmSession,
          text: normalized,
        });
        localNewSessionRef.current = false;
        applySession(nextSession, { preserveConnection: true });
        requestWorkbenchSummaryRefresh({ source: "event" });
        if (nextSession.threadsRefreshRecommended) {
          scheduleThreadRefresh("post-materialize");
        }
        if (process.env.NODE_ENV !== "production") {
          console.debug("Cloudflare Agent materialize turn", {
            durationMs: Math.round(performance.now() - startedAt),
            ok: true,
            warmSession: hadWarmSession,
          });
        }
        return nextSession.materializedTurn;
      } catch (nextError) {
        const errorMessage =
          nextError instanceof Error ? nextError.message : "Failed to start chat";
        setError(errorMessage);
        if (process.env.NODE_ENV !== "production") {
          console.debug("Cloudflare Agent materialize turn", {
            durationMs: Math.round(performance.now() - startedAt),
            ok: false,
            warmSession: hadWarmSession,
          });
        }
        throw nextError;
      } finally {
        setPending(null);
      }
    },
    [applySession, scheduleThreadRefresh],
  );

  const switchAgent = useCallback(
    async (agentId: string, target: AgentSwitchTarget, threadId?: string) => {
      const normalizedAgentId = agentId.trim();
      if (!normalizedAgentId) return;
      setPending({ type: "agent_handoff", agentId: normalizedAgentId });
      try {
        setError(null);
        const nextSession = await browserWorkbenchClient.session.switchAgent({
          agentId: normalizedAgentId,
          target,
          threadId,
        });
        if (target === "new_thread") {
          localNewSessionRef.current = true;
          setLocalNewSession(true);
          connectionRef.current = null;
          setConnection(null);
          applySession(nextSession, { preserveLocalNew: true });
        } else {
          localNewSessionRef.current = false;
          setLocalNewSession(false);
          applySession(nextSession);
        }
        requestWorkbenchSummaryRefresh({ source: "event" });
        if (nextSession.threadsRefreshRecommended) {
          scheduleThreadRefresh("post-action");
        }
      } catch (nextError) {
        const errorMessage =
          nextError instanceof Error ? nextError.message : "Failed to switch agent";
        setError(errorMessage);
        throw nextError;
      } finally {
        setPending(null);
      }
    },
    [applySession, scheduleThreadRefresh],
  );

  const restoreOptimisticDelete = useCallback((threadId: string) => {
    const rollback = deleteRollbacksRef.current.get(threadId);
    if (!rollback) return;

    if (rollback.source === "archived") {
      setArchivedThreads((current) => {
        if (current.some((thread) => thread.threadId === rollback.thread.threadId)) return current;
        const next = [...current];
        next.splice(Math.min(rollback.index, next.length), 0, rollback.thread);
        return next;
      });
    } else {
      setSession((current) => {
        const base = current ?? rollback.session;
        if (!base) return current;
        const existing = base.threads ?? [];
        const nextThreads = existing.some((thread) => thread.threadId === rollback.thread.threadId)
          ? existing
          : [
              ...existing.slice(0, rollback.index),
              rollback.thread,
              ...existing.slice(rollback.index),
            ];
        const restoredThreads = rollback.wasActive
          ? nextThreads.map((thread) => ({
              ...thread,
              isActive: thread.threadId === rollback.thread.threadId,
            }))
          : nextThreads;
        const restoredSession: ChatSessionResponse = {
          ...base,
          activeThread: rollback.wasActive ? rollback.activeThread : base.activeThread,
          connection: rollback.wasActive ? rollback.session?.connection : base.connection,
          expiresAt: rollback.wasActive ? rollback.session?.expiresAt : base.expiresAt,
          threads: restoredThreads,
        };
        writeCachedShell(restoredSession);
        return restoredSession;
      });
      if (rollback.wasActive) {
        connectionRef.current = rollback.connection;
        localNewSessionRef.current = rollback.localNewSession;
        setConnection(rollback.connection);
        setLocalNewSession(rollback.localNewSession);
      }
    }
  }, []);

  const deleteThreadOptimistically = useCallback(
    async (threadId: string) => {
      if (deletingThreadIdsRef.current.has(threadId)) return;
      const activeIndex =
        session?.threads?.findIndex((thread) => thread.threadId === threadId) ?? -1;
      const archivedIndex = archivedThreads.findIndex((thread) => thread.threadId === threadId);
      const thread =
        activeIndex >= 0 ? session?.threads?.[activeIndex] : archivedThreads[archivedIndex];
      if (!thread) {
        await loadSession({
          threadId,
          update: { status: "deleted" },
          refreshSummary: true,
        });
        return;
      }

      const wasActive = Boolean(
        activeIndex >= 0 &&
        (session?.activeThread?.threadId === threadId || session?.threads?.[activeIndex]?.isActive),
      );
      deleteRollbacksRef.current.set(threadId, {
        activeThread: session?.activeThread ?? null,
        connection: connectionRef.current,
        index: activeIndex >= 0 ? activeIndex : archivedIndex,
        localNewSession: localNewSessionRef.current,
        session,
        source: activeIndex >= 0 ? "active" : "archived",
        thread,
        wasActive,
      });
      setDeletingThreadIds((current) => {
        const next = new Set(current);
        next.add(threadId);
        deletingThreadIdsRef.current = next;
        return next;
      });

      if (activeIndex >= 0) {
        const threadIds = new Set([threadId]);
        setSession((current) => {
          const next = removeThreadsFromSession(current, threadIds);
          if (next) writeCachedShell(next);
          return next;
        });
      } else {
        setArchivedThreads((current) => current.filter((item) => item.threadId !== threadId));
      }

      if (wasActive) {
        localNewSessionRef.current = true;
        setLocalNewSession(true);
        connectionRef.current = null;
        setConnection(null);
      }

      try {
        setError(null);
        const nextSession = await readSession({
          threadId,
          update: { status: "deleted" },
        });
        applySession(nextSession);
        requestWorkbenchSummaryRefresh({ source: "event" });
        if (nextSession.threadsRefreshRecommended) {
          scheduleThreadRefresh("post-delete");
        }
        deleteRollbacksRef.current.delete(threadId);
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : "Failed to delete chat";
        if (/thread not found/i.test(message)) {
          deleteRollbacksRef.current.delete(threadId);
          scheduleThreadRefresh("post-delete");
          return;
        }

        try {
          const refreshedSession = await readSession({
            refresh: "threads",
            source: "post-delete",
          });
          if (!sessionContainsThread(refreshedSession, threadId)) {
            applySession(refreshedSession);
            deleteRollbacksRef.current.delete(threadId);
            requestWorkbenchSummaryRefresh({ source: "event" });
            return;
          }
        } catch {
          // Preserve the original mutation error and rollback when reconciliation is unavailable.
        }

        restoreOptimisticDelete(threadId);
        deleteRollbacksRef.current.delete(threadId);
        setError(message);
        scheduleThreadRefresh("post-delete");
        throw nextError;
      } finally {
        setDeletingThreadIds((current) => {
          if (!current.has(threadId)) return current;
          const next = new Set(current);
          next.delete(threadId);
          deletingThreadIdsRef.current = next;
          return next;
        });
      }
    },
    [
      applySession,
      archivedThreads,
      loadSession,
      restoreOptimisticDelete,
      scheduleThreadRefresh,
      session,
    ],
  );

  const applySessionEvent = useCallback(
    (event: WorkbenchSessionEvent) => {
      setLatestSessionEvent(event);
      if (event.type.startsWith("chat.run.")) setLatestChatRunEvent(event);

      let shouldRefreshConnection = false;
      let shouldClearConnection = false;
      let refreshedThreadId: string | null = null;
      const eventSession = sessionFromEvent(event);
      if (eventSession) {
        setSession((current) => {
          if (shouldIgnoreSessionEvent(current, event)) return current;
          const passiveSnapshot =
            event.type === "session.snapshot" || event.type === "session.threads.refreshed";
          const effectiveEventSession =
            localNewSessionRef.current && passiveSnapshot
              ? (enterLocalNewSession(eventSession) ?? eventSession)
              : eventSession;
          const filteredEventSession =
            removeThreadsFromSession(effectiveEventSession, deletingThreadIdsRef.current) ??
            effectiveEventSession;
          const merged = mergeSession(current, filteredEventSession);
          writeCachedShell(merged);
          shouldRefreshConnection = sessionEventRequiresConnectionRefresh(
            event,
            merged,
            connectionRef.current,
          );
          refreshedThreadId = merged.activeThread?.threadId ?? null;
          shouldClearConnection =
            Object.prototype.hasOwnProperty.call(filteredEventSession, "activeThread") &&
            filteredEventSession.activeThread === null;
          return merged;
        });
        if (event.type === "session.threads.refreshed") {
          setPending(null);
        }
      } else {
        setSession((current) =>
          shouldIgnoreSessionEvent(current, event)
            ? current
            : updateThreadStatusFromEvent(current, event),
        );
      }

      if (shouldRefreshConnection) {
        if (refreshedThreadId) setPending({ type: "activate", threadId: refreshedThreadId });
        window.setTimeout(() => {
          void loadSessionRef.current?.({ refreshSummary: false });
        }, 0);
      } else if (shouldClearConnection) {
        connectionRef.current = null;
        setConnection(null);
      }

      if (sessionEventShouldRefreshAdminSummary(event.type)) {
        requestWorkbenchSummaryRefresh({
          source: "event",
          minimumGeneratedAt: event.createdAt,
        });
      }
      if (event.type === "session.thread.updated" || event.type === "session.threads.refreshed") {
        refreshArchivedThreadsIfLoaded();
      }
    },
    [refreshArchivedThreadsIfLoaded],
  );

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useSessionEventStream(
    useMemo(
      () => ({
        workspaceId: connection?.workspaceId,
        onConnectedChange: setIsSessionStreamConnected,
        onEvent: applySessionEvent,
      }),
      [applySessionEvent, connection?.workspaceId],
    ),
  );

  useEffect(() => {
    if (!connection?.expiresAt) return;

    const expiresAtMs = Date.parse(connection.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return;

    const refreshDelayMs = Math.max(
      minimumRefreshDelayMs,
      expiresAtMs - Date.now() - tokenRefreshSkewMs,
    );
    const timeout = window.setTimeout(
      () => void loadSession({ refreshSummary: false }),
      refreshDelayMs,
    );
    return () => window.clearTimeout(timeout);
  }, [connection?.expiresAt, loadSession]);

  const value = useMemo<ChatSessionContextValue>(() => {
    const isLocalBlankSession =
      localNewSession ||
      Boolean(!connection && !session?.activeThread && canCreateThreadFromSessionShell(session));
    return {
      session,
      connection,
      error,
      isSessionStreamConnected,
      latestSessionEvent,
      latestChatRunEvent,
      isInitialLoading: pending?.type === "initial" && !connection,
      isTransitioning: pending !== null && pending.type !== "initial",
      pending,
      threads: session?.threads ?? [],
      archivedThreads,
      isLoadingArchivedThreads,
      archivedThreadsError,
      isLocalNewSession: isLocalBlankSession,
      deletingThreadIds,
      createThread: () => {
        void loadSession({
          action: "create",
          title: formatCurrentThreadTitle(),
          refreshSummary: true,
        });
        return Promise.resolve();
      },
      startNewSession,
      preloadNewSession,
      stageNewSession,
      materializeTurn,
      switchAgent,
      activateThread: (threadId: string) =>
        loadSession({
          action: "activate",
          threadId,
          optimistic: true,
          refreshSummary: false,
        }),
      renameThread: (threadId: string, title: string) =>
        loadSession({ threadId, update: { title }, refreshSummary: true }),
      archiveThread: (threadId: string) =>
        loadSession({
          threadId,
          update: { status: "archived" },
          refreshSummary: true,
        }),
      restoreThread: (threadId: string) =>
        loadSession({ threadId, update: { status: "active" }, refreshSummary: true }),
      deleteThread: deleteThreadOptimistically,
      loadArchivedThreads,
      refresh: () => loadSession({ refresh: "threads", refreshSummary: false, source: "manual" }),
      retry: () => loadSession({ refreshSummary: false }),
    };
  }, [
    connection,
    deletingThreadIds,
    deleteThreadOptimistically,
    error,
    isSessionStreamConnected,
    latestChatRunEvent,
    latestSessionEvent,
    isLoadingArchivedThreads,
    archivedThreadsError,
    loadArchivedThreads,
    loadSession,
    localNewSession,
    preloadNewSession,
    stageNewSession,
    startNewSession,
    materializeTurn,
    switchAgent,
    archivedThreads,
    pending,
    session,
  ]);

  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}

export const useWorkbenchAgentConnection = () => {
  const context = useContext(ChatSessionContext);
  if (!context)
    throw new Error("useWorkbenchAgentConnection must be used inside ChatSessionProvider");
  return context;
};
