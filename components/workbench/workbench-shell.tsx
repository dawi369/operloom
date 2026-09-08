"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRunWorkflow, WorkbenchClientProvider } from "@operloom/workbench-react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  ActivityIcon,
  BotIcon,
  FileTextIcon,
  HistoryIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  PlayIcon,
  ShieldCheckIcon,
  Building2Icon,
  WrenchIcon,
} from "lucide-react";

import { Assistant } from "@/app/assistant";
import {
  AssistantSlashCommandProvider,
  type AssistantSlashCommandContext,
} from "@/components/assistant-ui/slash-command-context";
import { AuthButton } from "@/components/auth/auth-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useWorkbenchComposerFocus,
  WorkbenchComposerFocusProvider,
} from "@/components/workbench/composer-focus-context";
import { ThreadHistorySidebar } from "@/components/workbench/thread-history-sidebar";
import { WorkbenchAssistantEvents } from "@/components/workbench/workbench-assistant-events";
import { WorkbenchMark } from "@/components/workbench/workbench-mark";
import { WorkbenchRuntimeHint } from "@/components/workbench/workbench-runtime-hint";
import { PackWorkflowProvider } from "@/components/workbench/pack-workflow-context";
import { requestWorkbenchSummaryRefresh } from "@/lib/workbench/admin-summary-events";
import { resolveAgentSlashWorkflowActions } from "@/lib/workbench/agent-slash-actions";
import { browserWorkbenchClient } from "@/lib/workbench/browser-client";
import type { HistoryFocusRequest } from "@/lib/workbench/history-surface";
import {
  ChatSessionProvider,
  useWorkbenchAgentConnection,
} from "@/lib/workbench/use-agent-connection";
import {
  buildPackWorkflowRequest,
  fieldDefinitionsForPackWorkflow,
  type PackWorkflowFieldDefinition,
} from "@/lib/workbench/pack-workflow-bindings";
import type { AgentSlashWorkflowAction } from "@/lib/workbench/agent-slash-actions";
import { hasWorkbenchSessionAccess } from "@/lib/workbench/session-access";

const AdminPanel = dynamic(
  () => import("@/components/workbench/dev-monitor-drawer").then((module) => module.AdminPanel),
  { ssr: false },
);

const WorkbenchAgentsPanel = dynamic(
  () =>
    import("@/components/workbench/workbench-agents-panel").then(
      (module) => module.WorkbenchAgentsPanel,
    ),
  { ssr: false },
);

const WorkbenchCapabilitiesPanel = dynamic(
  () =>
    import("@/components/workbench/workbench-capabilities-panel").then(
      (module) => module.WorkbenchCapabilitiesPanel,
    ),
  { ssr: false },
);

const WorkbenchHistoryPanel = dynamic(
  () =>
    import("@/components/workbench/workbench-history-panel").then(
      (module) => module.WorkbenchHistoryPanel,
    ),
  { ssr: false },
);

const WorkbenchWorkspacePanel = dynamic(
  () =>
    import("@/components/workbench/workbench-workspace-panel").then(
      (module) => module.WorkbenchWorkspacePanel,
    ),
  { ssr: false },
);

const adminAccessPath = "/api/workbench/admin-access";
const toolRunsPath = "/api/workbench/tools/runs";

const adminTestToolInputs: Record<
  "diagnostic.ping" | "runner.echo" | "artifact.metadata.test",
  Record<string, unknown>
> = {
  "diagnostic.ping": {},
  "runner.echo": { message: "runner echo ok" },
  "artifact.metadata.test": { label: "admin conformance" },
};

export function WorkbenchShell({
  initialSignedOutPresentation = false,
}: {
  initialSignedOutPresentation?: boolean;
}) {
  return (
    <WorkbenchClientProvider client={browserWorkbenchClient}>
      <ChatSessionProvider>
        <WorkbenchComposerFocusProvider>
          <WorkbenchShellContent initialSignedOutPresentation={initialSignedOutPresentation} />
        </WorkbenchComposerFocusProvider>
      </ChatSessionProvider>
    </WorkbenchClientProvider>
  );
}

function WorkbenchShellContent({
  initialSignedOutPresentation,
}: {
  initialSignedOutPresentation: boolean;
}) {
  const [adminOpen, setAdminOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [historyFocus, setHistoryFocus] = useState<HistoryFocusRequest | null>(null);
  const [adminAccess, setAdminAccess] = useState<{ isAdmin: boolean } | null>(null);
  const [adminNotice, setAdminNotice] = useState<string | null>(null);
  const [workflowError, setWorkflowError] = useState<{ message: string; runId?: string } | null>(
    null,
  );
  const [workflowAction, setWorkflowAction] = useState<AgentSlashWorkflowAction | null>(null);
  const [workflowInput, setWorkflowInput] = useState<Record<string, string | boolean>>({});
  const [isWorkflowRunning, setIsWorkflowRunning] = useState(false);
  const { mutateAsync: runWorkflow } = useRunWorkflow();
  const { user, loading } = useAuth();
  const {
    error: sessionError,
    isInitialLoading,
    session,
    startNewSession,
  } = useWorkbenchAgentConnection();
  const hasAuthenticatedSession = hasWorkbenchSessionAccess({
    hasWorkOsUser: Boolean(user),
    session,
    sessionError,
  });
  const { focusComposerAfterInteraction, focusComposerAfterOverlayClose } =
    useWorkbenchComposerFocus();
  const workflowSlashActions = useMemo(
    () => resolveAgentSlashWorkflowActions(session?.activeAgent?.behavior.pack),
    [session?.activeAgent?.behavior.pack],
  );

  useEffect(() => {
    if (loading) return;
    if (!hasAuthenticatedSession) {
      setAdminAccess({ isAdmin: false });
      return;
    }

    let cancelled = false;
    const loadAdminAccess = async () => {
      try {
        const response = await fetch(adminAccessPath, { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) setAdminAccess({ isAdmin: false });
          return;
        }
        const body = (await response.json().catch(() => ({}))) as { isAdmin?: unknown };
        if (!cancelled) setAdminAccess({ isAdmin: body.isAdmin === true });
      } catch {
        if (!cancelled) setAdminAccess({ isAdmin: false });
      }
    };

    void loadAdminAccess();
    return () => {
      cancelled = true;
    };
  }, [hasAuthenticatedSession, loading, user?.email, user?.id]);

  const openAdmin = useCallback(() => {
    if (adminAccess?.isAdmin) {
      setAdminNotice(null);
      setAdminOpen(true);
      return;
    }

    setAdminOpen(false);
    setAdminNotice("Admin is restricted for this account.");
    window.setTimeout(() => setAdminNotice(null), 3000);
  }, [adminAccess?.isAdmin]);

  const startNewChat = useCallback(
    async ({ isLoadingThread, isThreadRunning }: AssistantSlashCommandContext) => {
      if (isThreadRunning || isLoadingThread) {
        setAdminNotice("Wait for the current response before starting a new chat.");
        window.setTimeout(() => setAdminNotice(null), 3000);
        return;
      }

      startNewSession();
      focusComposerAfterInteraction();
    },
    [focusComposerAfterInteraction, startNewSession],
  );

  const runAdminTestTool = useCallback(
    async (toolName: keyof typeof adminTestToolInputs) => {
      if (!adminAccess?.isAdmin) {
        setAdminNotice("Admin tools are restricted for this account.");
        window.setTimeout(() => setAdminNotice(null), 3000);
        return;
      }

      setAdminNotice(`Running ${toolName}...`);
      try {
        const response = await fetch(toolRunsPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            toolName,
            executionMode: "dry_run",
            input: adminTestToolInputs[toolName],
          }),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: unknown };
        if (!response.ok) {
          throw new Error(
            typeof body.error === "string" ? body.error : `Failed to run ${toolName}`,
          );
        }
        setAdminNotice(`${toolName} accepted.`);
        requestWorkbenchSummaryRefresh({ source: "event" });
      } catch (error) {
        setAdminNotice(error instanceof Error ? error.message : `Failed to run ${toolName}`);
        requestWorkbenchSummaryRefresh({ source: "event" });
      } finally {
        focusComposerAfterInteraction();
        window.setTimeout(() => setAdminNotice(null), 3000);
      }
    },
    [adminAccess?.isAdmin, focusComposerAfterInteraction],
  );

  const openPackWorkflowAction = useCallback((action: AgentSlashWorkflowAction) => {
    const defaults = Object.fromEntries(
      Object.entries(action.binding.defaultInput).map(([key, value]) => [
        key,
        typeof value === "boolean" ? value : String(value),
      ]),
    ) as Record<string, string | boolean>;
    setWorkflowError(null);
    setWorkflowInput(defaults);
    setWorkflowAction(action);
  }, []);

  const openPackWorkflowByType = useCallback(
    (workflowType: string) => {
      const action = workflowSlashActions.find(
        (candidate) => candidate.binding.workflowType === workflowType,
      );
      if (action) openPackWorkflowAction(action);
    },
    [openPackWorkflowAction, workflowSlashActions],
  );

  const runPackWorkflowAction = useCallback(
    async (action: AgentSlashWorkflowAction, input: Record<string, unknown>) => {
      const request = buildPackWorkflowRequest(action.binding.workflowType, input);
      if (!request) return;

      setWorkflowError(null);
      setIsWorkflowRunning(true);
      setAdminNotice(`Running ${action.label}...`);
      try {
        const body = await runWorkflow({ workflowType: action.binding.workflowType, ...request });
        if (!body.ok) {
          setWorkflowError({
            message: "Workflow failed. Review the run, adjust your inputs, and try again.",
            runId: body.run?.id,
          });
          return;
        }
        const status = body.run?.status ?? (body.ok ? "accepted" : "submitted");
        setHistoryFocus({
          runId: body.run?.id,
          artifactId: body.artifact?.id,
          label: action.label,
          createdAt: Date.now(),
        });
        setHistoryOpen(true);
        setAdminNotice(`${action.label} ${status}. Opening History.`);
        setWorkflowAction(null);
        requestWorkbenchSummaryRefresh({ source: "event" });
      } catch (error) {
        setWorkflowError({
          message: error instanceof Error ? error.message : `Failed to run ${action.label}`,
          runId:
            error instanceof Error && "runId" in error && typeof error.runId === "string"
              ? error.runId
              : undefined,
        });
        setAdminNotice(null);
        requestWorkbenchSummaryRefresh({ source: "event" });
      } finally {
        setIsWorkflowRunning(false);
        focusComposerAfterInteraction();
        window.setTimeout(() => setAdminNotice(null), 3500);
      }
    },
    [focusComposerAfterInteraction, runWorkflow],
  );

  const handleWorkflowInputChange = useCallback((name: string, value: string | boolean) => {
    setWorkflowInput((current) => ({ ...current, [name]: value }));
  }, []);

  const handleWorkflowDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen || isWorkflowRunning) return;
      setWorkflowAction(null);
      focusComposerAfterOverlayClose();
    },
    [focusComposerAfterOverlayClose, isWorkflowRunning],
  );

  const submitWorkflowDialog = useCallback(() => {
    if (!workflowAction || isWorkflowRunning) return;
    void runPackWorkflowAction(workflowAction, workflowInput);
  }, [isWorkflowRunning, runPackWorkflowAction, workflowAction, workflowInput]);

  const handleAgentsOpenChange = useCallback(
    (nextOpen: boolean) => {
      setAgentsOpen(nextOpen);
      if (!nextOpen) focusComposerAfterOverlayClose();
    },
    [focusComposerAfterOverlayClose],
  );

  const handleCapabilitiesOpenChange = useCallback(
    (nextOpen: boolean) => {
      setCapabilitiesOpen(nextOpen);
      if (!nextOpen) focusComposerAfterOverlayClose();
    },
    [focusComposerAfterOverlayClose],
  );

  const handleHistoryOpenChange = useCallback(
    (nextOpen: boolean) => {
      setHistoryOpen(nextOpen);
      if (!nextOpen) {
        setHistoryFocus(null);
        focusComposerAfterOverlayClose();
      }
    },
    [focusComposerAfterOverlayClose],
  );

  const handleHistoryFocusConsumed = useCallback(() => {
    setHistoryFocus(null);
  }, []);

  const handleAdminOpenChange = useCallback(
    (nextOpen: boolean) => {
      setAdminOpen(nextOpen);
      if (!nextOpen) focusComposerAfterOverlayClose();
    },
    [focusComposerAfterOverlayClose],
  );

  const handlePanelCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      focusComposerAfterOverlayClose();
    },
    [focusComposerAfterOverlayClose],
  );

  const slashCommands = useMemo(() => {
    const commands = [
      {
        id: "new",
        label: "New chat",
        description: "Start a fresh thread in the current workspace.",
        icon: MessageSquarePlusIcon,
        execute: startNewChat,
      },
      {
        id: "workspace",
        label: "Workspace",
        description: "Switch accounts and manage workspace access.",
        icon: Building2Icon,
        execute: () => setWorkspaceOpen(true),
      },
      {
        id: "agents",
        label: "Agents",
        description: "Pick the active chat agent.",
        icon: BotIcon,
        execute: () => {
          setAgentsOpen(true);
        },
      },
      {
        id: "tools",
        label: "Agent tools",
        description: "See what you can run and what the current agent uses internally.",
        icon: WrenchIcon,
        execute: () => setCapabilitiesOpen(true),
      },
      ...workflowSlashActions.map((action) => ({
        id: action.id,
        label: action.label,
        description: action.description,
        icon: PlayIcon,
        execute: () => openPackWorkflowAction(action),
      })),
      {
        id: "history",
        label: "History",
        description: "Inspect recent scoped runs and artifacts.",
        icon: HistoryIcon,
        execute: () => setHistoryOpen(true),
      },
      {
        id: "admin",
        label: "Admin",
        description: adminAccess?.isAdmin
          ? "Open workspace, agent, and runtime controls."
          : "Restricted operator panel.",
        icon: ShieldCheckIcon,
        execute: openAdmin,
      },
    ];

    if (!adminAccess?.isAdmin) return commands;

    return [
      ...commands,
      {
        id: "ping",
        label: "Diagnostic ping",
        description: "Run diagnostic.ping as an Admin dry-run.",
        icon: ActivityIcon,
        execute: () => runAdminTestTool("diagnostic.ping"),
      },
      {
        id: "echo",
        label: "Runner echo",
        description: "Run runner.echo through the Fly callback path.",
        icon: PlayIcon,
        execute: () => runAdminTestTool("runner.echo"),
      },
      {
        id: "artifact",
        label: "Artifact metadata test",
        description: "Run artifact.metadata.test and create metadata history.",
        icon: FileTextIcon,
        execute: () => runAdminTestTool("artifact.metadata.test"),
      },
    ];
  }, [
    adminAccess?.isAdmin,
    openAdmin,
    openPackWorkflowAction,
    runAdminTestTool,
    startNewChat,
    workflowSlashActions,
  ]);

  return (
    <div className="workbench-shell bg-background relative h-dvh overflow-hidden">
      <AssistantSlashCommandProvider commands={slashCommands}>
        <PackWorkflowProvider openWorkflow={openPackWorkflowByType}>
          <div className="absolute top-3 right-3 z-30 flex max-w-[calc(100vw-1.5rem)] flex-col items-end gap-2">
            {hasAuthenticatedSession ? (
              <AuthButton
                localSession={!user && hasAuthenticatedSession}
                onOpenWorkspace={() => setWorkspaceOpen(true)}
              />
            ) : null}
            {adminNotice ? (
              <div className="workbench-surface border-border text-muted-foreground rounded-md border px-2.5 py-1.5 text-xs">
                {adminNotice}
              </div>
            ) : null}
          </div>
          {hasAuthenticatedSession ? (
            <>
              <ThreadHistorySidebar
                disableNewChat={false}
                disableThreadActions={isInitialLoading}
              />
              <div className="absolute top-14 right-3 z-20 flex max-w-[calc(100vw-1.5rem)] flex-col items-end gap-2">
                <WorkbenchRuntimeHint
                  onOpenAdmin={openAdmin}
                  onOpenCapabilities={() => setCapabilitiesOpen(true)}
                  onOpenHistory={() => setHistoryOpen(true)}
                />
              </div>
            </>
          ) : null}
          {sessionError && hasAuthenticatedSession ? (
            <a
              className="workbench-surface border-border text-muted-foreground absolute right-3 bottom-3 z-30 rounded-md border px-3 py-2 text-xs"
              href="/workspace-recovery"
            >
              Workspace unavailable? Check deletion recovery
            </a>
          ) : null}
          <Assistant initialSignedOutPresentation={initialSignedOutPresentation}>
            <WorkbenchAssistantEvents />
            <div className="pointer-events-none absolute top-4 left-4 z-20 md:hidden">
              <WorkbenchMark compact />
            </div>
          </Assistant>
          <WorkbenchAgentsPanel
            open={agentsOpen}
            onOpenChange={handleAgentsOpenChange}
            onCloseAutoFocus={handlePanelCloseAutoFocus}
          />
          <WorkbenchCapabilitiesPanel
            open={capabilitiesOpen}
            onOpenChange={handleCapabilitiesOpenChange}
            onCloseAutoFocus={handlePanelCloseAutoFocus}
            onRunWorkflow={openPackWorkflowByType}
          />
          <WorkbenchWorkspacePanel
            open={workspaceOpen}
            onOpenChange={(nextOpen) => {
              setWorkspaceOpen(nextOpen);
              if (!nextOpen) focusComposerAfterOverlayClose();
            }}
            onCloseAutoFocus={handlePanelCloseAutoFocus}
          />
          <WorkbenchHistoryPanel
            open={historyOpen}
            focus={historyFocus}
            showTechnicalDetails={adminAccess?.isAdmin === true}
            onOpenChange={handleHistoryOpenChange}
            onCloseAutoFocus={handlePanelCloseAutoFocus}
            onFocusConsumed={handleHistoryFocusConsumed}
          />
          <AdminPanel
            open={adminOpen}
            onOpenChange={handleAdminOpenChange}
            onCloseAutoFocus={handlePanelCloseAutoFocus}
            onOpenHistory={(runId) => {
              setAdminOpen(false);
              if (runId) {
                setHistoryFocus({ runId, createdAt: Date.now() });
              }
              setHistoryOpen(true);
            }}
          />
          <WorkflowRunDialog
            action={workflowAction}
            input={workflowInput}
            error={workflowError}
            onViewRun={() => {
              setHistoryFocus({ runId: workflowError?.runId, createdAt: Date.now() });
              setWorkflowAction(null);
              setHistoryOpen(true);
            }}
            isRunning={isWorkflowRunning}
            onInputChange={handleWorkflowInputChange}
            onOpenChange={handleWorkflowDialogOpenChange}
            onSubmit={submitWorkflowDialog}
          />
        </PackWorkflowProvider>
      </AssistantSlashCommandProvider>
    </div>
  );
}

function WorkflowRunDialog({
  error,
  onViewRun,
  action,
  input,
  isRunning,
  onInputChange,
  onOpenChange,
  onSubmit,
}: {
  error: { message: string; runId?: string } | null;
  onViewRun: () => void;
  action: AgentSlashWorkflowAction | null;
  input: Record<string, string | boolean>;
  isRunning: boolean;
  onInputChange: (name: string, value: string | boolean) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}) {
  const fields = useMemo(
    () => (action ? fieldDefinitionsForPackWorkflow(action.binding) : []),
    [action],
  );

  const closeFromOverlay = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    onOpenChange(false);
  };

  return (
    <Dialog open={Boolean(action)} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid w-[min(92vw,32rem)] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0 sm:max-w-[min(92vw,32rem)]"
        onOverlayMouseDown={closeFromOverlay}
        onOverlayPointerDown={closeFromOverlay}
        onOverlayTouchStart={closeFromOverlay}
      >
        <DialogHeader className="border-border border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <PlayIcon className="text-muted-foreground size-4" />
            {action?.label ?? "Run workflow"}
          </DialogTitle>
          <DialogDescription>{action?.description ?? "Run a pack workflow."}</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="bg-muted/40 text-muted-foreground rounded-md px-3 py-2 text-xs">
            Runs as a bounded dry-run and opens History when the report is ready.
          </div>

          {error ? (
            <div
              role="alert"
              className="border-destructive/40 space-y-2 rounded-md border p-3 text-sm"
            >
              <p>{error.message}</p>
              <p className="text-muted-foreground text-xs">
                Your inputs are still here. Review the run before retrying; a disconnected request
                may still be finishing.
              </p>
              <Button type="button" variant="outline" onClick={onViewRun}>
                {error.runId ? "View failed run" : "Check History"}
              </Button>
            </div>
          ) : null}
          {fields.map((field) => (
            <WorkflowField
              key={field.name}
              field={field}
              value={input[field.name]}
              disabled={isRunning}
              onChange={onInputChange}
            />
          ))}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              disabled={isRunning}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!action || isRunning}>
              {isRunning ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
              Run dry-run
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WorkflowField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: PackWorkflowFieldDefinition;
  value: string | boolean | undefined;
  disabled: boolean;
  onChange: (name: string, value: string | boolean) => void;
}) {
  const stringValue = typeof value === "string" ? value : "";

  if (field.kind === "checkbox") {
    return (
      <label className="border-border flex items-start gap-3 rounded-md border p-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4"
          checked={value !== false}
          disabled={disabled}
          onChange={(event) => onChange(field.name, event.target.checked)}
        />
        <span>
          <span className="block font-medium">{field.label}</span>
          <span className="text-muted-foreground block text-xs">{field.description}</span>
        </span>
      </label>
    );
  }

  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium">{field.label}</span>
      {field.kind === "select" ? (
        <select
          className="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          value={stringValue}
          disabled={disabled}
          onChange={(event) => onChange(field.name, event.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.kind === "number" ? "number" : "text"}
          className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          value={stringValue}
          min={field.min}
          max={field.max}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(event) => onChange(field.name, event.target.value)}
        />
      )}
      <span className="text-muted-foreground block text-xs">{field.description}</span>
    </label>
  );
}
