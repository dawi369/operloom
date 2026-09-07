"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useApprovalAction,
  useProposalAction,
  useRunAction,
  useWorkbenchActions,
  useWorkbenchArtifacts,
  useWorkbenchRun,
  useWorkbenchRuns,
} from "@operloom/workbench-react";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleStopIcon,
  ClipboardIcon,
  ExternalLinkIcon,
  FileTextIcon,
  HistoryIcon,
  Loader2Icon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CopyId,
  EmptyPanelText,
  StatusPill,
  StatusRow,
} from "@/components/workbench/dev-monitor-primitives";
import { RuntimeArtifactContent } from "@/components/workbench/runtime-artifact-content";
import {
  buildArtifactPreview,
  countHistoryRuns,
  filterHistoryRuns,
  historyFilters,
  isOpenableArtifactUri,
  resolveFocusedRunId,
  searchHistoryRuns,
  type HistoryFilter,
  type HistoryFocusRequest,
} from "@/lib/workbench/history-surface";
import { cn } from "@/lib/utils";
import type {
  ArtifactSummary,
  ExecutionHistoryRunSummary,
  ExecutionRunSnapshot,
} from "@/lib/workbench/workbench-types";

type ActionProposalSummary = {
  id: string;
  toolId: string;
  status: string;
  summary: string;
  externalReference?: string;
  createdAt: string;
  ledger: Array<{
    sequence: number;
    status: string;
    summary: string;
    externalReference?: string;
    createdAt: string;
  }>;
};

const attentionActionStatuses = new Set(["proposed", "approved", "failed", "outcome_unknown"]);
const runHistoryTitle = (run: ExecutionHistoryRunSummary) =>
  run.displayName ?? run.summary ?? "Untitled run";

const formatAge = (value?: string) => {
  if (!value) return "Time unknown";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Time unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const formatBytes = (value?: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

export function WorkbenchHistoryPanel({
  open,
  focus,
  showTechnicalDetails = false,
  onOpenChange,
  onCloseAutoFocus,
  onFocusConsumed,
}: {
  open: boolean;
  focus?: HistoryFocusRequest | null;
  showTechnicalDetails?: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onFocusConsumed?: () => void;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<HistoryFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedRunId, setHighlightedRunId] = useState<string | null>(null);
  const [highlightedArtifactId, setHighlightedArtifactId] = useState<string | null>(null);
  const [historyActionError, setHistoryActionError] = useState<string | null>(null);
  const [runActionError, setRunActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const selectedRunIdRef = useRef<string | null>(null);
  const runsQuery = useWorkbenchRuns({ limit: 20, enabled: open });
  const artifactsQuery = useWorkbenchArtifacts({ limit: 20, enabled: open });
  const actionsQuery = useWorkbenchActions({ limit: 20, enabled: open });
  const runQuery = useWorkbenchRun(selectedRunId, { enabled: open });
  const { mutateAsync: cancelRun } = useRunAction("cancel");
  const { mutateAsync: retryRun } = useRunAction("retry");
  const { mutateAsync: approveRequest } = useApprovalAction("approve");
  const { mutateAsync: denyRequest } = useApprovalAction("deny");
  const { mutateAsync: executeProposal } = useProposalAction("execute");
  const { mutateAsync: reconcileProposal } = useProposalAction("reconcile");
  const { refetch: refetchRuns } = runsQuery;
  const { refetch: refetchArtifacts } = artifactsQuery;
  const { refetch: refetchActions } = actionsQuery;
  const runs = (runsQuery.data?.runs ?? []) as ExecutionHistoryRunSummary[];
  const artifacts = (artifactsQuery.data?.artifacts ?? []) as ArtifactSummary[];
  const actions = (actionsQuery.data?.proposals ?? []) as ActionProposalSummary[];
  const selectedRunSnapshot = (runQuery.data?.snapshot ?? null) as ExecutionRunSnapshot | null;
  const isLoadingHistory =
    runsQuery.isFetching || artifactsQuery.isFetching || actionsQuery.isFetching;
  const isLoadingRun = runQuery.isFetching;
  const historyError =
    historyActionError ??
    (runsQuery.error ?? artifactsQuery.error ?? actionsQuery.error)?.message ??
    null;
  const runError = runActionError ?? runQuery.error?.message ?? null;

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const searchedRuns = useMemo(() => searchHistoryRuns(runs, searchQuery), [runs, searchQuery]);
  const filteredRuns = useMemo(
    () => filterHistoryRuns(searchedRuns, activeFilter),
    [activeFilter, searchedRuns],
  );
  const filterCounts = useMemo(() => countHistoryRuns(searchedRuns), [searchedRuns]);
  const selectedRunArtifacts = useMemo(() => {
    if (!selectedRun?.artifactIds?.length) return [];
    const artifactIds = new Set(selectedRun.artifactIds);
    return artifacts.filter((artifact) => artifactIds.has(artifact.id));
  }, [artifacts, selectedRun?.artifactIds]);
  const attentionActions = useMemo(
    () => actions.filter((action) => attentionActionStatuses.has(action.status)),
    [actions],
  );

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  const loadHistory = useCallback(async () => {
    setHistoryActionError(null);
    try {
      const [runsResult] = await Promise.all([refetchRuns(), refetchArtifacts(), refetchActions()]);
      return runsResult.data?.runs ?? [];
    } catch (error) {
      setHistoryActionError(error instanceof Error ? error.message : "Failed to load history");
      return null;
    }
  }, [refetchActions, refetchArtifacts, refetchRuns]);

  const inspectRun = useCallback((runId: string) => {
    setSelectedRunId(runId);
    setRunActionError(null);
  }, []);

  const performRunAction = useCallback(
    async (action: "cancel" | "retry") => {
      if (!selectedRunId) return;
      setBusyAction(action);
      setRunActionError(null);
      try {
        await (action === "cancel" ? cancelRun : retryRun)(selectedRunId);
        const loadedRuns = await loadHistory();
        const nextRunId =
          action === "retry" ? (loadedRuns?.[0]?.id ?? selectedRunId) : selectedRunId;
        inspectRun(nextRunId);
      } catch (actionError) {
        setRunActionError(
          actionError instanceof Error ? actionError.message : `Failed to ${action} run`,
        );
      } finally {
        setBusyAction(null);
      }
    },
    [cancelRun, inspectRun, loadHistory, retryRun, selectedRunId],
  );

  const decideApproval = useCallback(
    async (approvalId: string, action: "approve" | "deny") => {
      setBusyAction(`${action}:${approvalId}`);
      setRunActionError(null);
      try {
        await (action === "deny" ? denyRequest : approveRequest)({
          approvalId,
          reason: "Denied from History",
        });
        await loadHistory();
      } catch (approvalError) {
        setRunActionError(
          approvalError instanceof Error ? approvalError.message : `Failed to ${action} approval`,
        );
      } finally {
        setBusyAction(null);
      }
    },
    [approveRequest, denyRequest, loadHistory],
  );

  const performProposalAction = useCallback(
    async (proposalId: string, action: "execute" | "reconcile") => {
      setBusyAction(`proposal:${action}:${proposalId}`);
      setHistoryActionError(null);
      try {
        await (action === "execute" ? executeProposal : reconcileProposal)(proposalId);
        await loadHistory();
      } catch (error) {
        setHistoryActionError(
          error instanceof Error ? error.message : `Failed to ${action} action`,
        );
      } finally {
        setBusyAction(null);
      }
    },
    [executeProposal, loadHistory, reconcileProposal],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const refresh = async () => {
      const loadedRuns = await loadHistory();
      if (cancelled || !loadedRuns) return;
      const runId = focus
        ? resolveFocusedRunId(loadedRuns, focus)
        : (selectedRunIdRef.current ?? loadedRuns[0]?.id ?? null);
      if (runId) {
        setHighlightedRunId(focus ? runId : null);
        inspectRun(runId);
      }
      setHighlightedArtifactId(focus?.artifactId ?? null);
      if (focus) onFocusConsumed?.();
    };
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [focus, inspectRun, loadHistory, onFocusConsumed, open]);

  const closeFromOverlay = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-0 right-0 left-auto flex h-dvh max-h-dvh w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 p-0 sm:w-[min(92vw,64rem)] sm:max-w-[min(92vw,64rem)]"
        onCloseAutoFocus={onCloseAutoFocus}
        onOverlayMouseDown={closeFromOverlay}
        onOverlayPointerDown={closeFromOverlay}
        onOverlayTouchStart={closeFromOverlay}
      >
        <DialogHeader className="border-border border-b px-5 py-4">
          <div className="flex items-start justify-between gap-4 pr-8">
            <span>
              <DialogTitle className="flex items-center gap-2 text-base">
                <HistoryIcon className="text-muted-foreground size-4" /> Workbench History
              </DialogTitle>
              <DialogDescription>What ran, what it produced, and what needs you.</DialogDescription>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh history"
              onClick={() => void loadHistory()}
              disabled={isLoadingHistory}
            >
              {isLoadingHistory ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            </Button>
          </div>
        </DialogHeader>

        {historyError ? (
          <div className="border-destructive/30 bg-destructive/10 text-destructive border-b px-5 py-2 text-sm">
            {historyError}
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 md:grid-cols-[21rem_minmax(0,1fr)]">
          <aside className="border-border min-h-0 overflow-y-auto border-b p-4 md:border-r md:border-b-0">
            <label className="relative block">
              <SearchIcon className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4" />
              <input
                type="search"
                aria-label="Search history"
                className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring h-9 w-full rounded-md border pr-3 pl-8 text-sm outline-none focus-visible:ring-2"
                value={searchQuery}
                placeholder="Search history"
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-1">
              {historyFilters.map((filter) => (
                <Button
                  key={filter.id}
                  type="button"
                  size="sm"
                  variant={activeFilter === filter.id ? "secondary" : "ghost"}
                  onClick={() => setActiveFilter(filter.id)}
                >
                  {filter.label} {filterCounts[filter.id]}
                </Button>
              ))}
            </div>

            <div className="mt-4">
              {isLoadingHistory && !runs.length ? (
                <EmptyPanelText>Loading history.</EmptyPanelText>
              ) : filteredRuns.length ? (
                <ol className="space-y-1">
                  {filteredRuns.map((run) => (
                    <li key={run.id}>
                      <button
                        type="button"
                        aria-label={`Open ${runHistoryTitle(run)}`}
                        disabled={isLoadingRun && selectedRunId === run.id}
                        onClick={() => void inspectRun(run.id)}
                        className={cn(
                          "focus-visible:ring-ring w-full rounded-md px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2",
                          highlightedRunId === run.id
                            ? "bg-primary/8"
                            : selectedRunId === run.id
                              ? "bg-muted"
                              : "hover:bg-muted/60",
                        )}
                      >
                        <span className="flex items-start justify-between gap-3">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {runHistoryTitle(run)}
                            </span>
                            <span className="text-muted-foreground mt-0.5 block text-xs">
                              {formatAge(run.updatedAt ?? run.createdAt)}
                            </span>
                          </span>
                          {isLoadingRun && selectedRunId === run.id ? (
                            <Loader2Icon className="text-muted-foreground mt-0.5 size-3.5 animate-spin" />
                          ) : (
                            <StatusPill status={run.status ?? "unknown"} tone={run.status} />
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : runs.length ? (
                <EmptyPanelText>No runs match this view.</EmptyPanelText>
              ) : (
                <EmptyPanelText>Your workflows and tools will appear here.</EmptyPanelText>
              )}
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto p-5 md:p-6">
            {attentionActions.length ? (
              <AttentionActions
                actions={attentionActions}
                busyAction={busyAction}
                showTechnicalDetails={showTechnicalDetails}
                onAction={performProposalAction}
              />
            ) : null}

            {!selectedRunId ? (
              <EmptyPanelText>Select a run to see its outcome.</EmptyPanelText>
            ) : isLoadingRun ? (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2Icon className="size-4 animate-spin" /> Loading run
              </div>
            ) : runError ? (
              <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">
                {runError}
              </div>
            ) : selectedRunSnapshot ? (
              <SelectedRunSummary
                snapshot={selectedRunSnapshot}
                run={selectedRun}
                artifacts={selectedRunArtifacts}
                highlightedArtifactId={highlightedArtifactId}
                busyAction={busyAction}
                showTechnicalDetails={showTechnicalDetails}
                onRunAction={performRunAction}
                onApprovalAction={decideApproval}
              />
            ) : (
              <EmptyPanelText>No details returned for this run.</EmptyPanelText>
            )}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AttentionActions({
  actions,
  busyAction,
  showTechnicalDetails,
  onAction,
}: {
  actions: ActionProposalSummary[];
  busyAction: string | null;
  showTechnicalDetails: boolean;
  onAction: (proposalId: string, action: "execute" | "reconcile") => Promise<void>;
}) {
  return (
    <section className="border-border mb-6 rounded-lg border p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <CircleAlertIcon className="text-amber-600 size-4" /> Needs attention
      </h2>
      <div className="divide-border mt-2 divide-y">
        {actions.map((action) => (
          <div
            key={action.id}
            className="flex flex-col gap-3 py-3 first:pt-2 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">{action.summary}</span>
              <span className="text-muted-foreground mt-1 block text-xs">
                {formatAge(action.createdAt)}
              </span>
              {showTechnicalDetails && action.ledger.length ? (
                <details className="mt-2 text-xs">
                  <summary className="text-muted-foreground cursor-pointer">Action ledger</summary>
                  <ol className="border-border mt-2 space-y-1 border-l pl-3">
                    {action.ledger.map((entry) => (
                      <li key={entry.sequence}>
                        <span className="font-medium">{entry.status}</span>
                        <span className="text-muted-foreground"> · {entry.summary}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <StatusPill status={action.status} tone={action.status} />
              {action.status === "proposed" ? (
                <Button
                  size="sm"
                  disabled={Boolean(busyAction)}
                  onClick={() => void onAction(action.id, "execute")}
                >
                  Request approval
                </Button>
              ) : null}
              {action.status === "outcome_unknown" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(busyAction)}
                  onClick={() => void onAction(action.id, "reconcile")}
                >
                  Reconcile
                </Button>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

type PreviewableArtifact = ArtifactSummary | ExecutionRunSnapshot["artifacts"][number];

function SelectedRunSummary({
  snapshot,
  run,
  artifacts,
  highlightedArtifactId,
  busyAction,
  showTechnicalDetails,
  onRunAction,
  onApprovalAction,
}: {
  snapshot: ExecutionRunSnapshot;
  run: ExecutionHistoryRunSummary | null;
  artifacts: ArtifactSummary[];
  highlightedArtifactId?: string | null;
  busyAction: string | null;
  showTechnicalDetails: boolean;
  onRunAction: (action: "cancel" | "retry") => Promise<void>;
  onApprovalAction: (approvalId: string, action: "approve" | "deny") => Promise<void>;
}) {
  const artifactMap = new Map<string, PreviewableArtifact>();
  for (const artifact of snapshot.artifacts ?? []) artifactMap.set(artifact.id, artifact);
  for (const artifact of artifacts) artifactMap.set(artifact.id, artifact);
  const previewArtifacts = Array.from(artifactMap.values());
  const effectiveRunStatus = run?.status ?? snapshot.run?.status;
  const pendingInterventions = ["completed", "failed", "cancelled"].includes(
    effectiveRunStatus ?? "",
  )
    ? []
    : (snapshot.interventions ?? []).filter((intervention) => intervention.status === "requested");
  const runId = run?.id ?? snapshot.run?.id;
  const workflowIntentId =
    run?.workflowIntentId ?? snapshot.run?.workflowIntentId ?? snapshot.intent?.id;

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{run ? runHistoryTitle(run) : "Run outcome"}</h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {formatAge(run?.updatedAt ?? run?.createdAt)}
          </p>
        </div>
        <StatusPill
          status={run?.status ?? snapshot.run?.status ?? "unknown"}
          tone={run?.status ?? snapshot.run?.status}
        />
      </div>

      {run?.summary ? <p className="mt-4 text-sm leading-6">{run.summary}</p> : null}

      {pendingInterventions.map((intervention) => (
        <div key={intervention.id} className="border-border bg-muted/30 mt-5 rounded-lg border p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <span className="min-w-0">
              <span className="block text-sm font-medium">{intervention.title}</span>
              <span className="text-muted-foreground mt-1 block text-xs">
                {intervention.reason}
              </span>
            </span>
            <span className="flex shrink-0 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(busyAction)}
                onClick={() => void onApprovalAction(intervention.id, "deny")}
              >
                {busyAction === `deny:${intervention.id}` ? (
                  <Loader2Icon className="animate-spin" />
                ) : null}
                Deny
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={Boolean(busyAction)}
                onClick={() => void onApprovalAction(intervention.id, "approve")}
              >
                {busyAction === `approve:${intervention.id}` ? (
                  <Loader2Icon className="animate-spin" />
                ) : null}
                Approve
              </Button>
            </span>
          </div>
        </div>
      ))}

      {run?.controls?.canCancel || run?.controls?.canRetry ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {run.controls.canCancel ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(busyAction)}
              onClick={() => void onRunAction("cancel")}
            >
              {busyAction === "cancel" ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <CircleStopIcon />
              )}
              Cancel
            </Button>
          ) : null}
          {run.controls.canRetry ? (
            <Button
              type="button"
              size="sm"
              disabled={Boolean(busyAction)}
              onClick={() => void onRunAction("retry")}
            >
              {busyAction === "retry" ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <RotateCcwIcon />
              )}
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      <section className="mt-7">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <FileTextIcon className="text-muted-foreground size-4" /> Results
        </h3>
        {previewArtifacts.length ? (
          <ol className="space-y-3">
            {previewArtifacts.map((artifact, index) => (
              <ArtifactPreviewCard
                key={artifact.id}
                artifact={artifact}
                featured={index === 0}
                technical={showTechnicalDetails}
                highlighted={highlightedArtifactId === artifact.id}
              />
            ))}
          </ol>
        ) : (
          <EmptyPanelText>No artifacts were produced by this run.</EmptyPanelText>
        )}
      </section>

      {showTechnicalDetails ? (
        <details className="border-border mt-7 border-t pt-5">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm font-medium">
            Technical details
          </summary>
          <div className="mt-4 space-y-5">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <StatusRow label="Status" value={run?.status ?? snapshot.run?.status} compact />
              <StatusRow
                label="Stage"
                value={run?.stage ?? snapshot.run?.stage ?? snapshot.intent?.stage}
                compact
              />
              <StatusRow label="Engine" value={run?.engine} compact />
              <StatusRow label="Intent" value={snapshot.intent?.type} compact />
              <StatusRow label="Tool calls" value={String(snapshot.toolCalls.length)} compact />
              <StatusRow label="Artifacts" value={String(previewArtifacts.length)} compact />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <CopyId label="Run id" value={runId} />
              <CopyId label="Workflow intent id" value={workflowIntentId} />
            </div>
            <SummaryList
              title="Tool calls"
              empty="No tool calls attached to this run."
              items={snapshot.toolCalls.slice(0, 6).map((toolCall) => ({
                key: toolCall.id,
                title: toolCall.toolId ?? "Unknown tool",
                detail: toolCall.outputSummary ?? toolCall.inputSummary ?? "Tool call recorded.",
                status: toolCall.status,
              }))}
            />
            <SummaryList
              title="Decisions"
              empty="No decisions attached to this run."
              items={snapshot.decisions.slice(0, 6).map((decision) => ({
                key: decision.id,
                title: decision.title ?? "Decision",
                detail: decision.summary ?? decision.thesis ?? "Decision recorded.",
              }))}
            />
            <SummaryList
              title="Child runs"
              empty="No child runs attached to this run."
              items={(snapshot.childRuns ?? []).slice(0, 6).map((childRun, index) => ({
                key: childRun.id ?? `child-${index}`,
                title: childRun.stage ?? "Child run",
                detail: `${childRun.engine ?? "unknown engine"} · ${formatAge(
                  childRun.updatedAt ?? childRun.createdAt,
                )}`,
                status: childRun.status,
              }))}
            />
            <SummaryList
              title="Audit"
              empty="No audit events attached to this run."
              items={snapshot.auditEvents.slice(0, 6).map((event) => ({
                key: event.id,
                title: event.action ?? "Audit event",
                detail: event.summary ?? "Audit event recorded.",
              }))}
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ArtifactPreviewCard({
  artifact,
  featured,
  technical,
  highlighted,
}: {
  artifact: PreviewableArtifact;
  featured?: boolean;
  technical: boolean;
  highlighted?: boolean;
}) {
  const [copiedUri, setCopiedUri] = useState(false);
  const [expanded, setExpanded] = useState(Boolean(featured));
  const preview = buildArtifactPreview(artifact);
  const sizeBytes = "sizeBytes" in artifact ? formatBytes(artifact.sizeBytes) : undefined;
  const createdAt = "createdAt" in artifact ? formatAge(artifact.createdAt) : undefined;
  const kind = "kind" in artifact ? artifact.kind : undefined;
  const uri = artifact.uri;
  const openable = isOpenableArtifactUri(uri);

  const copyUri = async () => {
    if (!uri) return;
    await navigator.clipboard.writeText(uri);
    setCopiedUri(true);
    window.setTimeout(() => setCopiedUri(false), 1200);
  };

  return (
    <li
      className={cn(
        "border-border rounded-lg border p-4 text-sm",
        highlighted ? "border-primary/40 bg-primary/5 shadow-xs" : "",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate font-medium">{preview.title}</span>
          <span className="text-muted-foreground mt-0.5 block text-xs">
            {[kind ?? "artifact", sizeBytes, createdAt].filter(Boolean).join(" · ")}
          </span>
        </span>
        {openable && uri ? (
          <Button type="button" variant="outline" size="sm" asChild>
            <a href={uri} target="_blank" rel="noreferrer">
              Open <ExternalLinkIcon />
            </a>
          </Button>
        ) : null}
      </div>

      {preview.lines.length ? (
        <div className="mt-3 space-y-1">
          {preview.lines.slice(0, featured ? 4 : 2).map((line, index) => (
            <p
              key={`${artifact.id}-line-${index}`}
              className="text-muted-foreground break-words text-xs"
            >
              {line}
            </p>
          ))}
        </div>
      ) : null}

      {"kind" in artifact ? (
        <details
          className="mt-3"
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
            {featured ? "Result" : "View result"}
          </summary>
          <div className="mt-3 text-xs">
            <RuntimeArtifactContent artifact={artifact as ArtifactSummary} />
          </div>
        </details>
      ) : null}

      {technical ? (
        <details className="border-border mt-4 border-t pt-3">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
            Artifact details
          </summary>
          <div className="mt-3 space-y-2">
            <CopyId label="Artifact id" value={artifact.id} />
            <div className="flex items-center gap-2">
              <CopyId label="Artifact URI" value={uri} />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={copyUri}
                disabled={!uri}
              >
                {copiedUri ? <CheckIcon /> : <ClipboardIcon />}
                <span className="sr-only">Copy artifact URI</span>
              </Button>
            </div>
            {preview.json ? (
              <pre className="bg-muted max-h-44 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap">
                {preview.json}
              </pre>
            ) : null}
          </div>
        </details>
      ) : null}
    </li>
  );
}

function SummaryList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: Array<{ key: string; title: string; detail?: string; status?: string }>;
}) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold">{title}</h3>
      {items.length ? (
        <ol className="space-y-2">
          {items.map((item) => (
            <li key={item.key} className="border-border rounded-md border p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{item.title}</span>
                  {item.detail ? (
                    <span className="text-muted-foreground mt-1 block text-xs">{item.detail}</span>
                  ) : null}
                </span>
                {item.status ? <StatusPill status={item.status} tone={item.status} /> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyPanelText>{empty}</EmptyPanelText>
      )}
    </div>
  );
}
