"use client";

import { useEffect, useRef, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  LockKeyholeIcon,
  Loader2Icon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWorkbenchComposerFocus } from "@/components/workbench/composer-focus-context";
import { WorkbenchMark } from "@/components/workbench/workbench-mark";
import { cn } from "@/lib/utils";
import { useWorkbenchAgentConnection } from "@/lib/workbench/use-agent-connection";
import { hasWorkbenchSessionAccess } from "@/lib/workbench/session-access";
import type { ChatThreadSummary } from "@/lib/workbench/workbench-types";

export function AssistantThreadHistorySidebar() {
  const isRunning = useAuiState((state) => state.thread.isRunning);
  return <ThreadHistorySidebar disableNewChat={isRunning} />;
}

export function ThreadHistorySidebar({
  disableNewChat = false,
  disableThreadActions = false,
}: {
  disableNewChat?: boolean;
  disableThreadActions?: boolean;
}) {
  const {
    session,
    threads,
    archivedThreads,
    pending,
    error,
    isInitialLoading,
    isLoadingArchivedThreads,
    archivedThreadsError,
    deletingThreadIds,
    startNewSession,
    activateThread,
    renameThread,
    archiveThread,
    restoreThread,
    deleteThread,
    loadArchivedThreads,
  } = useWorkbenchAgentConnection();
  const { user, loading: authLoading } = useAuth();
  const [view, setView] = useState<"active" | "archived">("active");
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<ChatThreadSummary | null>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const renameTriggerRef = useRef<HTMLElement | null>(null);
  const [renameCandidate, setRenameCandidate] = useState<ChatThreadSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const { focusComposerAfterInteraction } = useWorkbenchComposerFocus();
  const creatingThread = pending?.type === "create";
  const isNavigatingThread =
    pending?.type === "activate" || pending?.type === "create" || pending?.type === "materialize";
  const isCached = session?.isStale === true;
  const isSignedOut =
    !authLoading &&
    !hasWorkbenchSessionAccess({
      hasWorkOsUser: Boolean(user),
      session,
      sessionError: error,
    });
  const actionsDisabled = disableThreadActions || isCached || isSignedOut;
  const newChatDisabled = disableNewChat || pending?.type === "materialize" || actionsDisabled;
  const threadItemsDisabled = actionsDisabled;
  const visibleThreads = (view === "archived" ? archivedThreads : threads).filter(
    (thread) => !deletingThreadIds.has(thread.threadId),
  );
  const loadingArchived =
    view === "archived" && isLoadingArchivedThreads && archivedThreads.length === 0;
  const loadingInitialThreads = isInitialLoading && visibleThreads.length === 0;
  const visibleError = isSignedOut
    ? null
    : view === "archived"
      ? (archiveError ?? archivedThreadsError)
      : (archiveError ?? error);

  useEffect(() => {
    if (view !== "archived" || actionsDisabled) return;
    let cancelled = false;
    setArchiveError(null);
    loadArchivedThreads().catch((nextError) => {
      if (!cancelled) {
        setArchiveError(
          nextError instanceof Error ? nextError.message : "Failed to load archived chats",
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [actionsDisabled, loadArchivedThreads, view]);

  const reloadArchived = async () => {
    if (view !== "archived") return;
    setArchiveError(null);
    try {
      await loadArchivedThreads({ force: true });
    } catch (nextError) {
      setArchiveError(
        nextError instanceof Error ? nextError.message : "Failed to load archived chats",
      );
    }
  };

  const runThreadAction = async (action: () => Promise<void>, fallback: string) => {
    setArchiveError(null);
    try {
      await action();
    } catch (nextError) {
      setArchiveError(nextError instanceof Error ? nextError.message : fallback);
    }
  };

  const handleCreateThread = async () => {
    if (newChatDisabled) return;
    startNewSession();
    focusComposerAfterInteraction();
  };

  const handleActivateThread = async (threadId: string) => {
    if (threadItemsDisabled || isNavigatingThread) return;
    focusComposerAfterInteraction();
    await runThreadAction(async () => {
      await activateThread(threadId);
      focusComposerAfterInteraction();
    }, "Failed to switch chat");
  };

  const handleRename = async (thread: ChatThreadSummary) => {
    if (actionsDisabled) return;
    renameTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRenameDraft(thread.title || "New chat");
    setRenameError(null);
    setRenameCandidate(thread);
  };

  const confirmRename = async () => {
    const title = renameDraft.trim();
    if (!renameCandidate || !title || isRenaming || actionsDisabled) return;
    if (title === renameCandidate.title) {
      setRenameCandidate(null);
      return;
    }
    setIsRenaming(true);
    setRenameError(null);
    try {
      await renameThread(renameCandidate.threadId, title);
      await reloadArchived();
      setRenameCandidate(null);
    } catch (nextError) {
      setRenameError(
        nextError instanceof Error ? nextError.message : "Could not rename the chat. Try again.",
      );
    } finally {
      setIsRenaming(false);
    }
  };

  const handleArchive = async (thread: ChatThreadSummary) => {
    if (actionsDisabled) return;
    await runThreadAction(async () => {
      await archiveThread(thread.threadId);
      await reloadArchived();
    }, "Failed to archive chat");
  };

  const handleRestore = async (thread: ChatThreadSummary) => {
    if (actionsDisabled) return;
    await runThreadAction(async () => {
      await restoreThread(thread.threadId);
      await reloadArchived();
    }, "Failed to restore chat");
  };

  const handleDelete = async (thread: ChatThreadSummary) => {
    if (actionsDisabled) return;
    deleteTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDeleteCandidate(thread);
  };

  const closeDeleteDialog = () => {
    setDeleteCandidate(null);
    requestAnimationFrame(() => {
      const trigger = deleteTriggerRef.current;
      if (trigger?.isConnected) {
        trigger.focus();
      } else {
        document.querySelector<HTMLElement>('button[aria-label="New chat"]')?.focus();
      }
      deleteTriggerRef.current = null;
    });
  };

  const confirmDelete = async () => {
    if (!deleteCandidate) return;
    const threadId = deleteCandidate.threadId;
    setArchiveError(null);
    closeDeleteDialog();
    try {
      await deleteThread(threadId);
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Failed to delete chat";
      setArchiveError(message);
    }
  };

  return (
    <aside className="border-sidebar-border bg-sidebar/92 absolute inset-y-0 left-0 z-10 hidden w-64 flex-col border-r shadow-[10px_0_36px_-34px_rgb(24_39_44/0.45)] backdrop-blur-xl md:flex">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-sidebar-border flex items-center justify-between gap-2 border-b px-3 py-3.5">
          <WorkbenchMark />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={newChatDisabled}
            aria-label="New chat"
            title="New chat"
            onClick={() => void handleCreateThread()}
          >
            {creatingThread ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <PlusIcon className="size-4" />
            )}
          </Button>
        </div>

        {isSignedOut ? (
          <div className="text-muted-foreground flex items-center gap-1.5 border-b px-3 py-2 text-[11px]">
            <LockKeyholeIcon className="size-3.5 shrink-0" />
            Sign in to resume chats
          </div>
        ) : null}

        <div className="border-sidebar-border flex gap-1 border-b px-2 py-2">
          <Button
            type="button"
            variant={view === "active" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 flex-1 text-[11px]"
            disabled={isSignedOut}
            onClick={() => setView("active")}
          >
            Recent
          </Button>
          <Button
            type="button"
            variant={view === "archived" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 flex-1 text-[11px]"
            disabled={isSignedOut}
            onClick={() => setView("archived")}
          >
            Archived
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {visibleError && visibleThreads.length === 0 ? (
            <div className="text-muted-foreground px-2 py-2 text-xs">{visibleError}</div>
          ) : loadingInitialThreads ? (
            <div className="text-muted-foreground px-2 py-2 text-xs">Loading chats...</div>
          ) : loadingArchived ? (
            <div className="text-muted-foreground px-2 py-2 text-xs">Loading archived chats...</div>
          ) : visibleThreads.length === 0 ? (
            <div className="text-muted-foreground px-2 py-2 text-xs">
              {view === "archived" ? "No archived chats." : "No recent chats yet."}
            </div>
          ) : (
            <>
              {visibleError ? (
                <div className="text-destructive px-2 pb-2 text-[11px]">{visibleError}</div>
              ) : null}
              {visibleThreads.map((thread) => (
                <ThreadHistoryItem
                  key={thread.threadId}
                  thread={thread}
                  view={view}
                  disabled={threadItemsDisabled}
                  pending={pending}
                  onActivate={handleActivateThread}
                  onRename={handleRename}
                  onArchive={handleArchive}
                  onRestore={handleRestore}
                  onDelete={handleDelete}
                />
              ))}
            </>
          )}
        </div>
      </div>
      <Dialog
        open={Boolean(renameCandidate)}
        onOpenChange={(open) => {
          if (!open && !isRenaming) setRenameCandidate(null);
        }}
      >
        <DialogContent
          className="gap-4 p-5 sm:max-w-[24rem]"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            renameTriggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>Give this conversation a name you can find later.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void confirmRename();
            }}
          >
            <div className="space-y-2">
              <label htmlFor="chat-title" className="text-sm font-medium">
                Chat name
              </label>
              <input
                id="chat-title"
                value={renameDraft}
                disabled={isRenaming}
                onChange={(event) => setRenameDraft(event.target.value)}
                onFocus={(event) => event.target.select()}
                className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
                aria-invalid={Boolean(renameError)}
                aria-describedby={renameError ? "rename-error" : undefined}
              />
              {renameError ? (
                <p id="rename-error" role="alert" className="text-destructive text-sm">
                  {renameError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={isRenaming}
                onClick={() => setRenameCandidate(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!renameDraft.trim() || isRenaming || actionsDisabled}>
                {isRenaming ? <Loader2Icon className="size-4 animate-spin" /> : null}
                {isRenaming ? "Saving…" : "Save name"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {deleteCandidate ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) closeDeleteDialog();
          }}
        >
          <DialogContent className="gap-4 p-5 sm:max-w-[22rem]" showCloseButton={false}>
            <DialogHeader className="gap-2 text-left">
              <div className="flex items-center gap-2.5">
                <div className="bg-destructive/10 text-destructive flex size-8 shrink-0 items-center justify-center rounded-md">
                  <Trash2Icon className="size-4" />
                </div>
                <DialogTitle>Delete this chat?</DialogTitle>
              </div>
              <DialogDescription className="text-foreground text-sm leading-relaxed">
                This permanently removes the chat and stops any active response.
              </DialogDescription>
            </DialogHeader>

            <DialogFooter className="grid grid-cols-2 sm:grid-cols-2">
              <Button type="button" variant="outline" onClick={closeDeleteDialog}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" onClick={() => void confirmDelete()}>
                <Trash2Icon className="size-4" />
                Delete chat
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </aside>
  );
}

function ThreadHistoryItem({
  thread,
  view,
  disabled = false,
  pending,
  onActivate,
  onRename,
  onArchive,
  onRestore,
  onDelete,
}: {
  thread: ChatThreadSummary;
  view: "active" | "archived";
  disabled?: boolean;
  pending: ReturnType<typeof useWorkbenchAgentConnection>["pending"];
  onActivate: (threadId: string) => Promise<void>;
  onRename: (thread: ChatThreadSummary) => Promise<void>;
  onArchive: (thread: ChatThreadSummary) => Promise<void>;
  onRestore: (thread: ChatThreadSummary) => Promise<void>;
  onDelete: (thread: ChatThreadSummary) => Promise<void>;
}) {
  const pendingActivation = pending?.type === "activate" && pending.threadId === thread.threadId;
  const pendingThreadId = pending && "threadId" in pending ? pending.threadId : null;
  const pendingType = pending?.type;
  const pendingMutation =
    pendingThreadId === thread.threadId &&
    (pendingType === "rename" ||
      pendingType === "archive" ||
      pendingType === "restore" ||
      pendingType === "delete");
  const actionButtonsDisabled = disabled || pendingActivation || pendingMutation;
  const activationDisabled = actionButtonsDisabled || thread.isActive;
  const canActivate = view === "active";

  return (
    <div
      data-testid={`thread-history-item-${thread.threadId}`}
      className={cn(
        "hover:bg-muted/70 mb-1 flex w-full min-w-0 items-center gap-1 rounded-md px-1 py-1 text-sm transition-colors",
        thread.isActive && "bg-muted",
      )}
    >
      <button
        type="button"
        disabled={activationDisabled || !canActivate}
        className={cn(
          "flex min-w-0 flex-1 cursor-default items-center gap-2 rounded px-1.5 py-1 text-left outline-none transition-colors disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
        onClick={() => {
          if (thread.isActive) return;
          void onActivate(thread.threadId);
        }}
      >
        {pendingActivation || pendingMutation ? (
          <Loader2Icon className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
        ) : (
          <MessageSquareIcon className="text-muted-foreground size-3.5 shrink-0" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{thread.title || "New chat"}</span>
          {thread.agent ? (
            <span className="text-muted-foreground truncate text-[11px]">
              {thread.agent.name} / {thread.agent.profile}
            </span>
          ) : null}
        </span>
        {thread.messageCount ? (
          <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
            {thread.messageCount}
          </span>
        ) : null}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7 shrink-0"
        disabled={actionButtonsDisabled}
        title="Rename"
        aria-label="Rename chat"
        onClick={() => void onRename(thread)}
      >
        <PencilIcon className="size-3.5" />
      </Button>
      {view === "archived" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0"
          disabled={actionButtonsDisabled}
          title="Restore"
          aria-label="Restore chat"
          onClick={() => void onRestore(thread)}
        >
          <ArchiveRestoreIcon className="size-3.5" />
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0"
          disabled={actionButtonsDisabled}
          title="Archive"
          aria-label="Archive chat"
          onClick={() => void onArchive(thread)}
        >
          <ArchiveIcon className="size-3.5" />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-destructive hover:text-destructive size-7 shrink-0"
        disabled={actionButtonsDisabled}
        title="Delete"
        aria-label="Delete chat"
        onClick={() => void onDelete(thread)}
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </div>
  );
}
