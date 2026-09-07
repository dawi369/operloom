"use client";

import { useEffect, useMemo } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  ActivityIcon,
  AlertCircleIcon,
  BotIcon,
  Building2Icon,
  CloudIcon,
  CpuIcon,
  HistoryIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  WrenchIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { deriveRuntimeState } from "@/lib/workbench/chat-runtime-live-state";
import { useAdminSummaryResource } from "@/lib/workbench/use-admin-summary-resource";
import { useWorkbenchAgentConnection } from "@/lib/workbench/use-agent-connection";
import { hasWorkbenchSessionAccess } from "@/lib/workbench/session-access";
import { cn } from "@/lib/utils";

export function WorkbenchRuntimeHint({
  onOpenAdmin,
  onOpenCapabilities,
  onOpenHistory,
}: {
  onOpenAdmin: () => void;
  onOpenCapabilities: () => void;
  onOpenHistory: () => void;
}) {
  const {
    summary,
    error: summaryError,
    refreshSummary,
    clearSummary,
    syncStatus: summarySyncStatus,
  } = useAdminSummaryResource();
  const { user, loading } = useAuth();
  const {
    connection,
    error,
    session,
    pending,
    latestSessionEvent,
    latestChatRunEvent,
    isInitialLoading,
    isSessionStreamConnected,
    retry,
  } = useWorkbenchAgentConnection();
  const hasSessionAccess = hasWorkbenchSessionAccess({
    hasWorkOsUser: Boolean(user),
    session,
    sessionError: error,
  });

  useEffect(() => {
    if (loading) return;
    if (!hasSessionAccess) {
      clearSummary();
      return;
    }

    void refreshSummary({ source: "initial" });
  }, [clearSummary, hasSessionAccess, loading, refreshSummary]);

  const liveRuntime = deriveRuntimeState({
    session,
    connection,
    error,
    isSessionStreamConnected,
    latestSessionEvent,
    latestChatRunEvent,
    pending,
    isInitialLoading,
    summary,
    summaryError,
    authLoading: loading,
  });
  const hasError = Boolean(error ?? liveRuntime.errorMessage);
  const activeAgent = session?.activeAgent ?? summary?.activeAgent ?? null;
  const workspaceName = session?.workspace?.name ?? summary?.workspace?.name ?? "Workspace";
  const agentLabel =
    liveRuntime.activeAgentLabel ??
    (activeAgent ? `${activeAgent.name} / ${activeAgent.profile}` : null);
  const modelLabel = liveRuntime.modelLabel ?? activeAgent?.runtime.model ?? null;

  const statusClassName = useMemo(() => {
    switch (liveRuntime.chatTone) {
      case "completed":
        return "border-emerald-200 bg-emerald-50 text-emerald-700";
      case "running":
        return "border-sky-200 bg-sky-50 text-sky-700";
      case "failed":
        return "border-destructive/30 bg-destructive/10 text-destructive";
      default:
        return "border-border bg-muted text-foreground";
    }
  }, [liveRuntime.chatTone]);

  return (
    <div
      className="workbench-surface border-border text-muted-foreground hidden w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-xs md:flex"
      data-summary-sync-status={summarySyncStatus}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium tracking-wide uppercase",
            statusClassName,
          )}
        >
          {liveRuntime.chatLabel}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-xs"
            onClick={onOpenCapabilities}
          >
            <WrenchIcon className="size-3.5" />
            Tools
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-xs"
            onClick={onOpenHistory}
          >
            <HistoryIcon className="size-3.5" />
            History
          </Button>
          {hasError ? (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-destructive hover:text-destructive"
                onClick={() => void retry()}
                title="Reconnect"
              >
                <RefreshCwIcon className="size-3.5" />
                <span className="sr-only">Reconnect</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive h-6 gap-1 px-1.5 text-xs"
                onClick={onOpenAdmin}
              >
                <AlertCircleIcon className="size-3.5" />
                Details
              </Button>
            </>
          ) : null}
        </span>
      </div>
      <details className="group">
        <summary className="cursor-pointer rounded-sm py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Runtime details
        </summary>
        <div className="mt-1 flex flex-col gap-1.5">
          <RuntimeHintRow
            icon={CloudIcon}
            label="Cloudflare"
            value={liveRuntime.cloudflareStatus}
            tone={liveRuntime.cloudflareTone}
          />
          <RuntimeHintRow icon={Building2Icon} label="Workspace" value={workspaceName} />
          <RuntimeHintRow icon={BotIcon} label="Agent" value={agentLabel ?? "Agent"} />
          <RuntimeHintRow icon={CpuIcon} label="Model" value={modelLabel ?? "System default"} />
          <RuntimeHintRow
            icon={MessageSquareIcon}
            label="Thread"
            value={
              liveRuntime.activeThreadTitle || liveRuntime.activeThreadId || "Waiting for Worker"
            }
          />
          <RuntimeHintRow icon={ActivityIcon} label="Source" value={liveRuntime.sourceLabel} />
        </div>
      </details>
      {session?.isStale ? (
        <div className="text-muted-foreground text-[11px]">
          Cached shell is visible; chat actions unlock after Cloudflare returns a live token.
        </div>
      ) : liveRuntime.summaryIsStale ? (
        <div className="text-muted-foreground flex items-center justify-between gap-2 text-[11px]">
          <span>
            {summarySyncStatus === "exhausted"
              ? "Live updates are connected; details refresh is delayed."
              : "Live updates are connected; synchronizing refreshed details."}
          </span>
          {summarySyncStatus === "exhausted" ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-[11px]"
              onClick={() =>
                void refreshSummary({
                  source: "manual",
                  force: true,
                  minimumGeneratedAt: latestSessionEvent?.createdAt,
                })
              }
            >
              Refresh
            </Button>
          ) : null}
        </div>
      ) : isSessionStreamConnected ? (
        <div className="text-muted-foreground text-[11px]">Live session updates connected.</div>
      ) : connection ? (
        <div className="text-muted-foreground text-[11px]">
          Agent token is ready; opening the session event stream.
        </div>
      ) : liveRuntime.errorMessage ? (
        <div className="text-destructive text-[11px]">{liveRuntime.errorMessage}</div>
      ) : null}
    </div>
  );
}

function RuntimeHintRow({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Building2Icon;
  label: string;
  value: string;
  tone?: "completed" | "running" | "failed";
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          tone === "completed" && "text-emerald-600",
          tone === "running" && "text-sky-600",
          tone === "failed" && "text-destructive",
        )}
      />
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right">{value}</span>
    </div>
  );
}
