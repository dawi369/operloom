"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertCircleIcon,
  BotIcon,
  CheckIcon,
  FlaskConicalIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { AdminAgentsPanel } from "@/components/workbench/admin-agents-panel";
import { WorkflowReviewDetails } from "@/components/workbench/workflow-review-details";
import {
  AdminControlsPanel,
  type AdminApprovalDecision,
} from "@/components/workbench/admin-controls-panel";
import { AdminSystemPanel } from "@/components/workbench/admin-system-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requestWorkbenchSummaryRefresh } from "@/lib/workbench/admin-summary-events";
import { deriveRuntimeState } from "@/lib/workbench/chat-runtime-live-state";
import { readJsonResponse } from "@/lib/workbench/read-json-response";
import { useAdminSummaryResource } from "@/lib/workbench/use-admin-summary-resource";
import { useWorkbenchAgentConnection } from "@/lib/workbench/use-agent-connection";
import type {
  AgentBehaviorTemplate,
  AgentSummary,
  CloudflareAgentBehaviorTemplatesResponse,
  CloudflareToolApprovalActionResponse,
  CloudflareToolApprovalsResponse,
  CloudflareToolPolicyUpdateResponse,
  CloudflareToolRunResponse,
  ToolApprovalRequestSummary,
  ToolSummary,
} from "@/lib/workbench/workbench-types";

const behaviorTemplatesPath = "/api/workbench/agent-behavior-templates";
const agentsPath = "/api/workbench/agents";
const toolRunsPath = "/api/workbench/tools/runs";
const toolPolicyPath = "/api/workbench/tools/policy";
const toolApprovalsPath = "/api/workbench/tools/approvals";

const inputClass =
  "border-input bg-background h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AdminPanel({
  open,
  onOpenChange,
  onCloseAutoFocus,
  onOpenHistory,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onOpenHistory: (runId?: string) => void;
}) {
  const {
    connection,
    error: sessionError,
    session,
    pending,
    isInitialLoading,
    isSessionStreamConnected,
    latestSessionEvent,
    latestChatRunEvent,
    switchAgent,
  } = useWorkbenchAgentConnection();
  const {
    summary,
    error: summaryError,
    isLoading,
    refreshSummary,
    setProjectionPreference,
  } = useAdminSummaryResource();
  const [templates, setTemplates] = useState<AgentBehaviorTemplate[]>([]);
  const [approvals, setApprovals] = useState<ToolApprovalRequestSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyPackId, setBusyPackId] = useState<string | null>(null);
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [approvalDialog, setApprovalDialog] = useState<AdminApprovalDecision | null>(null);
  const [denyReason, setDenyReason] = useState("");
  const [customAgentOpen, setCustomAgentOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [customTemplateId, setCustomTemplateId] = useState("assistant-analyst");
  const [urlTarget, setUrlTarget] = useState("");
  const adminDialogRef = useRef<HTMLDivElement>(null);

  const loadSecondaryData = async () => {
    try {
      const [templateResponse, approvalResponse] = await Promise.all([
        fetch(behaviorTemplatesPath, { cache: "no-store" }),
        fetch(`${toolApprovalsPath}?status=all&limit=20`, { cache: "no-store" }),
      ]);
      const [templateBody, approvalBody] = await Promise.all([
        readJsonResponse<CloudflareAgentBehaviorTemplatesResponse>(
          templateResponse,
          "Failed to load agent packs",
        ),
        readJsonResponse<CloudflareToolApprovalsResponse>(
          approvalResponse,
          "Failed to load approvals",
        ),
      ]);
      setTemplates(templateBody.templates ?? []);
      setApprovals(approvalBody.approvals ?? []);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load Admin data");
    }
  };

  const refresh = async (force = false) => {
    await Promise.all([
      refreshSummary({ source: "manual", force, projection: "drawer" }),
      loadSecondaryData(),
    ]);
  };

  useEffect(() => {
    if (!open) return;
    setProjectionPreference("drawer");
    void refreshSummary({ source: "drawer-open", projection: "drawer" });
    void loadSecondaryData();
    return () => setProjectionPreference("compact");
  }, [open, refreshSummary, setProjectionPreference]);

  const liveRuntime = deriveRuntimeState({
    session,
    connection,
    error: sessionError,
    isSessionStreamConnected,
    latestSessionEvent,
    latestChatRunEvent,
    pending,
    isInitialLoading,
    summary,
    summaryError,
  });
  const packTemplates = useMemo(() => templates.filter((template) => template.pack), [templates]);
  const pendingApprovals = approvals.filter((approval) => approval.status === "requested");
  const importantError = error ?? summaryError ?? liveRuntime.errorMessage;
  const currentPack =
    session?.activeAgent?.behavior.pack ?? summary?.activeAgent?.behavior.pack ?? null;
  const canManageAutomations = ["owner", "admin"].includes(
    summary?.membership?.role?.toLowerCase() ?? "",
  );

  const usePack = async (template: AgentBehaviorTemplate) => {
    if (!template.pack) return;
    setBusyPackId(template.pack.id);
    setError(null);
    try {
      const result = await readJsonResponse<{ agent: AgentSummary }>(
        await fetch(
          `/api/workbench/agent-packs/${encodeURIComponent(template.pack.id)}/instantiate`,
          { method: "POST" },
        ),
        "Failed to prepare agent pack",
      );
      await switchAgent(result.agent.id, "new_thread");
      requestWorkbenchSummaryRefresh({ source: "event" });
      onOpenChange(false);
    } catch (activationError) {
      setError(
        activationError instanceof Error
          ? activationError.message
          : "Failed to activate agent pack",
      );
    } finally {
      setBusyPackId(null);
    }
  };

  const updateToolPolicy = async (tool: ToolSummary, change: Record<string, string | boolean>) => {
    setBusyTool(tool.name);
    setError(null);
    try {
      await readJsonResponse<CloudflareToolPolicyUpdateResponse>(
        await fetch(toolPolicyPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toolName: tool.name, ...change }),
        }),
        `Failed to update ${tool.name}`,
      );
      await refresh(true);
    } catch (policyError) {
      setError(policyError instanceof Error ? policyError.message : "Failed to update tool policy");
    } finally {
      setBusyTool(null);
    }
  };

  const decideApproval = async () => {
    const approval = approvalDialog?.approval;
    if (!approval?.id || !approvalDialog) return;
    setBusyApprovalId(approval.id);
    setError(null);
    try {
      const suffix = approvalDialog.action === "approve" ? "approve" : "deny";
      await readJsonResponse<CloudflareToolApprovalActionResponse>(
        await fetch(`${toolApprovalsPath}/${encodeURIComponent(approval.id)}/${suffix}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body:
            approvalDialog.action === "deny"
              ? JSON.stringify({ reason: denyReason.trim() || "Denied by an operator." })
              : undefined,
        }),
        `Failed to ${approvalDialog.action} request`,
      );
      setApprovalDialog(null);
      setDenyReason("");
      await refresh(true);
    } catch (approvalError) {
      setError(
        approvalError instanceof Error ? approvalError.message : "Failed to update approval",
      );
    } finally {
      setBusyApprovalId(null);
    }
  };

  const runDiagnostic = async (toolName: string, input: Record<string, unknown> = {}) => {
    setBusyTool(toolName);
    setError(null);
    try {
      await readJsonResponse<CloudflareToolRunResponse>(
        await fetch(toolRunsPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toolName, executionMode: "dry_run", input }),
        }),
        `Failed to run ${toolName}`,
      );
      await refresh(true);
    } catch (diagnosticError) {
      setError(
        diagnosticError instanceof Error ? diagnosticError.message : `Failed to run ${toolName}`,
      );
    } finally {
      setBusyTool(null);
    }
  };

  const createCustomAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const template = templates.find((candidate) => candidate.id === customTemplateId);
    if (!template || !customName.trim()) return;
    setBusyTool("custom-agent");
    setError(null);
    try {
      await readJsonResponse(
        await fetch(agentsPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: customName.trim(),
            description: customDescription.trim() || undefined,
            profile: template.profile,
            behaviorTemplateId: template.id,
            activate: false,
          }),
        }),
        "Failed to create custom agent",
      );
      setCustomAgentOpen(false);
      setCustomName("");
      setCustomDescription("");
      await refresh(true);
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : "Failed to create custom agent",
      );
    } finally {
      setBusyTool(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          ref={adminDialogRef}
          tabIndex={-1}
          className="grid h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:h-[min(88vh,58rem)] sm:w-[min(92vw,72rem)] sm:max-w-[min(92vw,72rem)]"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            adminDialogRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <DialogHeader className="border-border border-b px-5 py-4">
            <div className="flex items-center justify-between gap-4 pr-8">
              <div>
                <DialogTitle className="flex items-center gap-2 text-base">
                  <ShieldCheckIcon className="text-muted-foreground size-4" />
                  Admin
                </DialogTitle>
                <DialogDescription className="mt-1">
                  Access, agents, and diagnostics.
                </DialogDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refresh(true)}
                disabled={isLoading}
              >
                {isLoading ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                Refresh
              </Button>
            </div>
          </DialogHeader>

          {importantError ? (
            <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 border-b px-5 py-2 text-xs">
              <AlertCircleIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{importantError}</span>
            </div>
          ) : null}

          <Tabs defaultValue="controls" className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            <div className="border-border overflow-x-auto border-b px-4 py-2">
              <TabsList>
                <TabsTrigger value="controls">
                  <SlidersHorizontalIcon />
                  Controls
                  {pendingApprovals.length ? (
                    <span className="bg-amber-500/15 text-amber-700 dark:text-amber-300 rounded-full px-1.5 text-[10px] font-semibold tabular-nums">
                      {pendingApprovals.length}
                    </span>
                  ) : null}
                </TabsTrigger>
                <TabsTrigger value="agents">
                  <BotIcon />
                  Agents
                </TabsTrigger>
                <TabsTrigger value="system">
                  <FlaskConicalIcon />
                  Diagnostics
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="agents" className="overflow-y-auto p-5">
              <AdminAgentsPanel
                open={open}
                templates={packTemplates}
                agents={summary?.agents ?? []}
                activeAgentId={session?.activeAgent?.id ?? summary?.activeAgent?.id}
                currentPack={currentPack}
                canManageAutomations={canManageAutomations}
                busyPackId={busyPackId}
                onUsePack={usePack}
                onCreateCustomAgent={() => setCustomAgentOpen(true)}
                onOpenHistory={onOpenHistory}
              />
            </TabsContent>

            <TabsContent value="controls" className="overflow-y-auto p-5">
              <AdminControlsPanel
                approvals={pendingApprovals}
                tools={summary?.tools ?? []}
                busyTool={busyTool}
                onDecideApproval={setApprovalDialog}
                onUpdateToolPolicy={updateToolPolicy}
              />
            </TabsContent>

            <TabsContent value="system" className="overflow-y-auto p-5">
              <AdminSystemPanel
                summary={summary}
                busyTool={busyTool}
                urlTarget={urlTarget}
                onUrlTargetChange={setUrlTarget}
                onRunDiagnostic={runDiagnostic}
              />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <Dialog open={customAgentOpen} onOpenChange={setCustomAgentOpen}>
        <DialogContent>
          <form onSubmit={createCustomAgent}>
            <DialogHeader>
              <DialogTitle>Create custom agent</DialogTitle>
              <DialogDescription>
                Create a separate snapshot from an installed behavior template.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-5 space-y-4">
              <label className="block text-sm font-medium">
                Name
                <input
                  className={`${inputClass} mt-1`}
                  value={customName}
                  onChange={(event) => setCustomName(event.target.value)}
                  maxLength={80}
                  required
                />
              </label>
              <label className="block text-sm font-medium">
                Description
                <input
                  className={`${inputClass} mt-1`}
                  value={customDescription}
                  onChange={(event) => setCustomDescription(event.target.value)}
                  maxLength={240}
                />
              </label>
              <label className="block text-sm font-medium">
                Behavior
                <select
                  className={`${inputClass} mt-1`}
                  value={customTemplateId}
                  onChange={(event) => setCustomTemplateId(event.target.value)}
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setCustomAgentOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!customName.trim() || busyTool === "custom-agent"}>
                {busyTool === "custom-agent" ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <BotIcon />
                )}
                Create agent
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(approvalDialog)}
        onOpenChange={(next) => {
          if (!next) {
            setApprovalDialog(null);
            setDenyReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {approvalDialog?.action === "approve" ? "Approve request" : "Deny request"}
            </DialogTitle>
            <DialogDescription>
              {approvalDialog?.approval.toolId ?? "Tool request"} ·{" "}
              {approvalDialog?.approval.reason ??
                approvalDialog?.approval.input?.url ??
                "No reason supplied."}
            </DialogDescription>
          </DialogHeader>
          {approvalDialog?.approval.review ? (
            <WorkflowReviewDetails review={approvalDialog.approval.review} />
          ) : null}
          {approvalDialog?.action === "deny" ? (
            <label className="text-sm font-medium">
              Reason
              <input
                className={`${inputClass} mt-1`}
                value={denyReason}
                onChange={(event) => setDenyReason(event.target.value)}
                placeholder="Why is this request denied?"
              />
            </label>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setApprovalDialog(null)}>
              Cancel
            </Button>
            <Button
              variant={approvalDialog?.action === "deny" ? "destructive" : "default"}
              disabled={Boolean(busyApprovalId)}
              onClick={() => void decideApproval()}
            >
              {busyApprovalId ? (
                <Loader2Icon className="animate-spin" />
              ) : approvalDialog?.action === "approve" ? (
                <CheckIcon />
              ) : (
                <ShieldCheckIcon />
              )}
              {approvalDialog?.action === "approve" ? "Approve" : "Deny"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
