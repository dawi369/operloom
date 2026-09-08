"use client";

import { useEffect, useMemo, useState } from "react";
import { useWorkbenchAgents } from "@operloom/workbench-react";
import {
  BotIcon,
  CheckCircle2Icon,
  Loader2Icon,
  MessageSquarePlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { requestWorkbenchSummaryRefresh } from "@/lib/workbench/admin-summary-events";
import { useWorkbenchAgentConnection } from "@/lib/workbench/use-agent-connection";
import type { AgentSwitchTarget, AgentSummary } from "@/lib/workbench/workbench-types";

export function WorkbenchAgentsPanel({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAgent, setPendingAgent] = useState<AgentSummary | null>(null);
  const [busySwitchTarget, setBusySwitchTarget] = useState<AgentSwitchTarget | null>(null);
  const {
    isLocalNewSession,
    pending: sessionPending,
    session,
    switchAgent,
  } = useWorkbenchAgentConnection();

  const agentsQuery = useWorkbenchAgents(open);
  const agents = agentsQuery.data?.agents ?? [];
  const activeAgentId = agentsQuery.data?.activeAgentId ?? null;
  const loading = agentsQuery.isFetching;
  const loadAgents = async () => {
    setError(null);
    const result = await agentsQuery.refetch();
    if (result.error) {
      setError(result.error instanceof Error ? result.error.message : "Failed to load agents");
    }
  };

  const currentThread = session?.activeThread ?? null;
  const hasCurrentThread = Boolean(currentThread?.status === "active" && !isLocalNewSession);
  const sessionActiveAgent = session?.activeAgent ?? null;
  const effectiveActiveAgentId = sessionActiveAgent?.id ?? activeAgentId;
  const pendingAgentId = pendingAgent?.id ?? null;
  const sortedAgents = useMemo(
    () =>
      [...agents].sort((left, right) => {
        const leftCurrent = left.id === effectiveActiveAgentId ? 0 : 1;
        const rightCurrent = right.id === effectiveActiveAgentId ? 0 : 1;
        if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;
        if (left.status !== right.status) return left.status === "active" ? -1 : 1;
        return left.name.localeCompare(right.name);
      }),
    [agents, effectiveActiveAgentId],
  );

  useEffect(() => {
    if (!open) {
      setPendingAgent(null);
      setBusySwitchTarget(null);
      return;
    }
    if (pendingAgentId && (!hasCurrentThread || pendingAgentId === effectiveActiveAgentId)) {
      setPendingAgent(null);
    }
  }, [effectiveActiveAgentId, hasCurrentThread, open, pendingAgentId]);

  const switchToAgent = async (agent: AgentSummary, target: AgentSwitchTarget) => {
    setBusyAgentId(agent.id);
    setBusySwitchTarget(target);
    setError(null);
    try {
      await switchAgent(
        agent.id,
        target,
        target === "current_thread" ? currentThread?.threadId : undefined,
      );
      setPendingAgent(null);
      await loadAgents();
      requestWorkbenchSummaryRefresh({ source: "event" });
      onOpenChange(false);
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : "Failed to switch agent");
    } finally {
      setBusyAgentId(null);
      setBusySwitchTarget(null);
    }
  };

  const selectAgent = (agent: AgentSummary) => {
    if (agent.status !== "active") return;
    if (hasCurrentThread && agent.id !== effectiveActiveAgentId) {
      setPendingAgent(agent);
      return;
    }
    void switchToAgent(agent, "new_thread");
  };

  const closeFromOverlay = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid h-[min(72vh,36rem)] w-[min(92vw,34rem)] max-w-[calc(100vw-2rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[min(92vw,34rem)]"
        onCloseAutoFocus={onCloseAutoFocus}
        onOverlayMouseDown={closeFromOverlay}
        onOverlayPointerDown={closeFromOverlay}
        onOverlayTouchStart={closeFromOverlay}
      >
        <DialogHeader className="border-border border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <BotIcon className="text-muted-foreground size-4" />
            Agents
          </DialogTitle>
          <DialogDescription>Pick the agent for this chat or your next chat.</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-auto p-4">
          {error ? (
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
              <MessageSquarePlusIcon className="size-3.5 shrink-0" />
              {hasCurrentThread ? "Switch the current chat or start fresh." : "Sets next chat."}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void loadAgents()}
              disabled={loading}
            >
              {loading ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
              Refresh
            </Button>
          </div>

          {loading && !sortedAgents.length ? (
            <p className="text-muted-foreground text-sm">Loading agents.</p>
          ) : sortedAgents.length ? (
            <ol className="space-y-2">
              {sortedAgents.map((agent) => {
                const isCurrentAgent = agent.id === effectiveActiveAgentId;
                const showConfirmation = pendingAgent?.id === agent.id;
                const isBusy =
                  busyAgentId === agent.id ||
                  (sessionPending?.type === "agent_handoff" && sessionPending.agentId === agent.id);
                const isThreadRunning = currentThread?.latestRunStatus === "running";

                return (
                  <li key={agent.id} className="border-border rounded-md border p-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left disabled:cursor-default"
                        disabled={isCurrentAgent || isBusy || agent.status !== "active"}
                        onClick={() => selectAgent(agent)}
                      >
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate font-medium">{agent.name}</span>
                          {isCurrentAgent ? (
                            <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs">
                              <CheckCircle2Icon className="size-3" />
                              {hasCurrentThread ? "current" : "default"}
                            </span>
                          ) : null}
                          {agent.status !== "active" ? (
                            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs">
                              {agent.status}
                            </span>
                          ) : null}
                        </span>
                        <span className="text-muted-foreground mt-1 block truncate text-xs">
                          {agent.profile} / {agent.runtime.model}
                        </span>
                      </button>

                      <Button
                        size="sm"
                        variant={isCurrentAgent ? "secondary" : "outline"}
                        disabled={isCurrentAgent || isBusy || agent.status !== "active"}
                        onClick={() => selectAgent(agent)}
                      >
                        {isBusy && !busySwitchTarget ? (
                          <Loader2Icon className="animate-spin" />
                        ) : null}
                        {isCurrentAgent ? (hasCurrentThread ? "Current" : "Default") : "Pick"}
                      </Button>
                    </div>

                    {showConfirmation ? (
                      <div className="border-border bg-muted/30 mt-3 rounded-md border p-3">
                        <div className="flex flex-col gap-3">
                          <div className="min-w-0">
                            <p className="font-medium">Use {agent.name} here?</p>
                            <p className="text-muted-foreground mt-1 text-xs">
                              Continue keeps this thread. Start new only changes the blank-chat
                              default.
                            </p>
                            {isThreadRunning ? (
                              <p className="text-destructive mt-2 text-xs">
                                Wait for the current response before switching this chat.
                              </p>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              disabled={isThreadRunning || isBusy}
                              onClick={() => void switchToAgent(agent, "current_thread")}
                            >
                              {isBusy && busySwitchTarget === "current_thread" ? (
                                <Loader2Icon className="animate-spin" />
                              ) : null}
                              Continue this chat
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isBusy}
                              onClick={() => void switchToAgent(agent, "new_thread")}
                            >
                              {isBusy && busySwitchTarget === "new_thread" ? (
                                <Loader2Icon className="animate-spin" />
                              ) : null}
                              Start new chat
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8"
                              aria-label="Cancel agent switch"
                              onClick={() => setPendingAgent(null)}
                            >
                              <XIcon className="size-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-muted-foreground text-sm">No workspace agents loaded.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
