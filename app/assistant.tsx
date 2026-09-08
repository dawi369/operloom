"use client";

/**
 * Client runtime bridge between assistant-ui and Cloudflare Agents.
 *
 * Vercel forwards the WorkOS/local session to Cloudflare. Cloudflare owns the
 * active workspace/thread/agent session, mints the short-lived Agent token, and
 * the browser talks to the per-thread Durable Object through the Agents SDK.
 */
import { useAssistantSlashCommands } from "@/components/assistant-ui/slash-command-context";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { AssistantRuntimeProvider, useAui } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useAgent } from "agents/react";
import { ArrowUpIcon, Loader2Icon, LogInIcon, PlusIcon, RefreshCwIcon } from "lucide-react";

import {
  workbenchComposerInputClassName,
  workbenchComposerShellClassName,
} from "@/components/assistant-ui/composer-style";
import { Button } from "@/components/ui/button";
import { WorkbenchMark } from "@/components/workbench/workbench-mark";
import { Thread } from "@/components/assistant-ui/thread";
import {
  StarterSuggestionGrid,
  ThreadWelcomeLayout,
} from "@/components/assistant-ui/thread-welcome";
import { useWorkbenchComposerFocus } from "@/components/workbench/composer-focus-context";
import { authPresentationCookieName } from "@/lib/workbench/auth-presentation";
import { hasPendingActiveThread } from "@/lib/workbench/chat-session-state";
import { hasWorkbenchSessionAccess } from "@/lib/workbench/session-access";
import {
  type WorkbenchAgentConnection,
  useWorkbenchAgentConnection,
} from "@/lib/workbench/use-agent-connection";

const toAgentHostOptions = (agentHost: string) => {
  const parsed = new URL(agentHost);
  return {
    host: parsed.host,
    protocol: parsed.protocol === "http:" ? ("ws" as const) : ("wss" as const),
  };
};

const writeSignedOutPresentation = (isSignedOut: boolean) => {
  if (typeof window === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = isSignedOut
    ? `${authPresentationCookieName}=signed-out; Path=/; Max-Age=2592000; SameSite=Lax${secure}`
    : `${authPresentationCookieName}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
};

export function Assistant({
  children,
  initialSignedOutPresentation = false,
}: {
  children?: ReactNode;
  initialSignedOutPresentation?: boolean;
}) {
  const {
    connection,
    error,
    isLocalNewSession,
    materializeTurn,
    pending,
    retry,
    session,
    stageNewSession,
  } = useWorkbenchAgentConnection();
  const [preRuntimeDraft, setPreRuntimeDraft] = useState("");
  const clearPreRuntimeDraft = useCallback(() => setPreRuntimeDraft(""), []);
  const [acceptedFirstSendDraft, setAcceptedFirstSendDraft] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const clearAcceptedFirstSendDraft = useCallback(() => setAcceptedFirstSendDraft(null), []);
  const [isSubmittingLocalTurn, setIsSubmittingLocalTurn] = useState(false);
  const pendingFirstTurnRef = useRef<{ id: string; text: string } | null>(null);
  const handlePreRuntimeDraftChange = useCallback(
    (nextDraft: string) => {
      setPreRuntimeDraft(nextDraft);
      if (isLocalNewSession && nextDraft.trim()) {
        void stageNewSession("first-draft");
      }
    },
    [isLocalNewSession, stageNewSession],
  );
  const handlePreRuntimeFocus = useCallback(() => {
    if (isLocalNewSession) void stageNewSession("first-focus");
  }, [isLocalNewSession, stageNewSession]);
  const submitLocalTurn = useCallback(
    async (draftOverride?: string) => {
      const draft = draftOverride ?? preRuntimeDraft;
      if (!isLocalNewSession || isSubmittingLocalTurn || !draft.trim()) return;
      setIsSubmittingLocalTurn(true);
      try {
        const normalizedDraft = draft.trim();
        const pending =
          pendingFirstTurnRef.current?.text === normalizedDraft
            ? pendingFirstTurnRef.current
            : { id: crypto.randomUUID(), text: normalizedDraft };
        pendingFirstTurnRef.current = pending;
        await stageNewSession("first-send");
        const accepted = await materializeTurn(normalizedDraft, pending.id);
        setAcceptedFirstSendDraft({
          id: accepted?.messageId ?? pending.id,
          text: normalizedDraft,
        });
        pendingFirstTurnRef.current = null;
        clearPreRuntimeDraft();
      } finally {
        setIsSubmittingLocalTurn(false);
      }
    },
    [
      clearPreRuntimeDraft,
      isLocalNewSession,
      isSubmittingLocalTurn,
      materializeTurn,
      preRuntimeDraft,
      stageNewSession,
    ],
  );
  const submitStarterPrompt = useCallback(
    async (prompt: string) => {
      setPreRuntimeDraft(prompt);
      await submitLocalTurn(prompt);
    },
    [submitLocalTurn],
  );

  if (!connection || hasPendingActiveThread(session)) {
    return (
      <PreRuntimeDraftSurface
        draft={preRuntimeDraft}
        error={error}
        isLocalNewSession={isLocalNewSession}
        isSubmitting={isSubmittingLocalTurn || pending?.type === "materialize"}
        onDraftChange={handlePreRuntimeDraftChange}
        onFocus={handlePreRuntimeFocus}
        onSubmit={submitLocalTurn}
        onStarterPrompt={submitStarterPrompt}
        onRetry={retry}
        session={session}
        initialSignedOutPresentation={initialSignedOutPresentation}
      />
    );
  }

  return (
    <AgentRuntime
      key={`${connection.threadId ?? connection.instanceName}:${connection.agentId ?? "agent"}`}
      connection={connection}
      draft={preRuntimeDraft}
      acceptedDraft={acceptedFirstSendDraft}
      onDraftHydrated={clearPreRuntimeDraft}
      onAcceptedDraftCleared={clearAcceptedFirstSendDraft}
    >
      {children}
      <Thread pendingFirstTurn={isSubmittingLocalTurn || Boolean(acceptedFirstSendDraft)} />
    </AgentRuntime>
  );
}

function AgentRuntime({
  connection,
  draft,
  acceptedDraft,
  onDraftHydrated,
  onAcceptedDraftCleared,
  children,
}: {
  connection: WorkbenchAgentConnection;
  draft: string;
  acceptedDraft: { id: string; text: string } | null;
  onDraftHydrated: () => void;
  onAcceptedDraftCleared: () => void;
  children?: ReactNode;
}) {
  const hostOptions = useMemo(
    () => toAgentHostOptions(connection.agentHost!),
    [connection.agentHost],
  );
  const agentQuery = useMemo(() => ({ token: connection.token! }), [connection.token]);

  const agent = useAgent({
    agent: "WorkbenchThreadChatAgent",
    name: connection.instanceName!,
    host: hostOptions.host,
    protocol: hostOptions.protocol,
    query: agentQuery,
    enabled: Boolean(connection.token),
  });
  const chat = useAgentChat({
    agent,
    body: () => ({
      token: connection.token!,
      threadId: connection.threadId,
      traceId: `trace-${crypto.randomUUID()}`,
    }),
  });
  useEffect(() => {
    if (!acceptedDraft) return;
    chat.setMessages((messages) => {
      if (messages.some((message) => message.id === acceptedDraft.id)) return messages;
      return [
        ...messages,
        {
          id: acceptedDraft.id,
          role: "user",
          parts: [{ type: "text", text: acceptedDraft.text }],
        },
      ];
    });
  }, [acceptedDraft, chat.setMessages]);
  const runtime = useAISDKRuntime(chat);
  const providerRuntime = runtime as unknown as ComponentProps<
    typeof AssistantRuntimeProvider
  >["runtime"];

  return (
    <AssistantRuntimeProvider runtime={providerRuntime}>
      <RuntimeDraftHandoff
        draft={draft}
        acceptedDraft={acceptedDraft}
        onHydrated={onDraftHydrated}
        onAcceptedDraftCleared={onAcceptedDraftCleared}
      />
      <div className="relative h-full">{children}</div>
    </AssistantRuntimeProvider>
  );
}

function RuntimeDraftHandoff({
  draft,
  acceptedDraft,
  onHydrated,
  onAcceptedDraftCleared,
}: {
  draft: string;
  acceptedDraft: { id: string; text: string } | null;
  onHydrated: () => void;
  onAcceptedDraftCleared: () => void;
}) {
  const aui = useAui();
  const attemptedDraftRef = useRef<string | null>(null);

  useEffect(() => {
    if (acceptedDraft) {
      const composer = aui.composer();
      if (composer.getState().text === acceptedDraft.text) composer.setText("");
      onAcceptedDraftCleared();
      return;
    }

    const targetDraft = draft;
    const attemptKey = `hydrate:${targetDraft}`;
    if (!targetDraft || attemptedDraftRef.current === attemptKey) return;

    const composer = aui.composer();
    const currentText = composer.getState().text ?? "";
    attemptedDraftRef.current = attemptKey;

    if (currentText && currentText !== targetDraft) return;
    if (currentText !== targetDraft) {
      composer.setText(targetDraft);
    }

    if (currentText === targetDraft) {
      onHydrated();
      return;
    }
    onHydrated();
  }, [acceptedDraft, aui, draft, onAcceptedDraftCleared, onHydrated]);

  return null;
}

function PreRuntimeDraftSurface({
  draft,
  error,
  isLocalNewSession,
  isSubmitting,
  onDraftChange,
  onFocus,
  onSubmit,
  onStarterPrompt,
  onRetry,
  session,
  initialSignedOutPresentation,
}: {
  draft: string;
  error: string | null;
  isLocalNewSession: boolean;
  isSubmitting: boolean;
  onDraftChange: (draft: string) => void;
  onFocus: () => void;
  onSubmit: () => Promise<void>;
  onStarterPrompt: (prompt: string) => Promise<void>;
  onRetry: () => Promise<void>;
  session: ReturnType<typeof useWorkbenchAgentConnection>["session"];
  initialSignedOutPresentation: boolean;
}) {
  const { registerComposerInput } = useWorkbenchComposerFocus();
  const commands = useAssistantSlashCommands();
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const commandQuery = /^\/\S*$/.test(draft) ? draft.slice(1).toLowerCase() : null;
  const matchingCommands =
    commandQuery !== null && !commandsDismissed
      ? commands.filter(
          (command) =>
            command.id.toLowerCase().startsWith(commandQuery) ||
            command.label.toLowerCase().replace(/\s+/g, "-").startsWith(commandQuery),
        )
      : [];
  const highlightedIndex = Math.min(commandIndex, Math.max(0, matchingCommands.length - 1));
  const executeDraftCommand = async (command: (typeof commands)[number]) => {
    onDraftChange("");
    setCommandsDismissed(true);
    await command.execute({ isLoadingThread: false, isThreadRunning: false });
  };
  const submitDraft = async () => {
    const command =
      matchingCommands[highlightedIndex] ??
      commands.find((item) => draft.trim().toLowerCase() === `/${item.id.toLowerCase()}`);
    if (command) {
      await executeDraftCommand(command);
      return;
    }
    await onSubmit();
  };
  const { user, loading: authLoading, refreshAuth } = useAuth();
  const [hasRememberedSignOut, setHasRememberedSignOut] = useState(initialSignedOutPresentation);
  const hasSessionAccess = hasWorkbenchSessionAccess({
    hasWorkOsUser: Boolean(user),
    session,
    sessionError: error,
  });
  const activeThreadLabel = session?.activeThread?.title || session?.activeThread?.threadId;
  const hasCachedShell = session?.isStale === true;
  const isRestoringSession = authLoading && !hasRememberedSignOut && !hasSessionAccess;
  const isCreatingThread = hasPendingActiveThread(session);
  const visibleError = isLocalNewSession ? null : error;
  const statusLabel = visibleError
    ? "Connection failed"
    : isLocalNewSession
      ? null
      : isCreatingThread
        ? "Creating new chat"
        : "Connecting to Cloudflare Agent";
  const statusDescription = visibleError
    ? visibleError
    : isLocalNewSession
      ? null
      : isCreatingThread
        ? "You can draft while Cloudflare creates the Agent session."
        : hasCachedShell
          ? "Cached workspace is visible while the live Agent token refreshes."
          : "You can start drafting while the Agent connection opens.";

  useEffect(() => {
    if (authLoading) return;
    const isSignedOut = !hasSessionAccess;
    writeSignedOutPresentation(isSignedOut);
    setHasRememberedSignOut(isSignedOut);
  }, [authLoading, hasSessionAccess]);

  if (!hasSessionAccess) {
    return (
      <div className="aui-root aui-thread-root bg-transparent @container flex h-full flex-col">
        <div className="relative flex flex-1 flex-col overflow-x-auto overflow-y-auto scroll-smooth">
          <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-6 py-8 sm:px-10">
            <section
              className="workbench-enter my-auto w-full border-l border-foreground/15 py-3 pl-6"
              aria-labelledby="signed-out-title"
            >
              <WorkbenchMark className="mb-12" />
              <h1
                id="signed-out-title"
                className="font-display text-4xl leading-tight font-semibold tracking-[-0.03em]"
              >
                {isRestoringSession ? "Restoring your workspace" : "Resume your workspace"}
              </h1>
              {!isRestoringSession ? (
                <p className="text-muted-foreground mt-3 max-w-lg text-base leading-6">
                  Pick up your chats, agents, and history.
                </p>
              ) : null}
              {isRestoringSession ? (
                <div className="text-muted-foreground mt-4 flex items-center gap-2 text-sm">
                  <Loader2Icon className="size-4 animate-spin" />
                  Verifying access
                </div>
              ) : (
                <Button
                  type="button"
                  className="mt-6"
                  onClick={() => void refreshAuth({ ensureSignedIn: true })}
                >
                  <LogInIcon className="size-4" />
                  Sign in
                </Button>
              )}
            </section>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="aui-root aui-thread-root bg-transparent @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-radius" as string]: "24px",
        ["--composer-padding" as string]: "10px",
      }}
    >
      <div className="relative flex flex-1 flex-col overflow-x-auto overflow-y-auto scroll-smooth">
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4">
          {isLocalNewSession ? (
            <ThreadWelcomeLayout animate>
              <StarterSuggestionGrid disabled={isSubmitting} onSelect={onStarterPrompt} />
            </ThreadWelcomeLayout>
          ) : (
            <div className="my-auto flex grow flex-col">
              <div className="flex w-full grow flex-col items-center justify-center">
                <div className="workbench-enter flex size-full flex-col justify-center px-4">
                  {statusLabel ? (
                    <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
                      {visibleError ? (
                        <span className="size-2 rounded-full bg-destructive" />
                      ) : (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      )}
                      <span>{statusLabel}</span>
                    </div>
                  ) : null}
                  <h1 className="font-display text-3xl font-semibold tracking-[-0.025em]">
                    {activeThreadLabel ? "Draft in your last chat" : "Hello there!"}
                  </h1>
                  {statusDescription ? (
                    <p className="text-muted-foreground mt-2 max-w-xl text-xl">
                      {statusDescription}
                    </p>
                  ) : null}
                  {activeThreadLabel ? (
                    <p className="text-muted-foreground/80 mt-3 max-w-xl text-xs">
                      Last active thread: {activeThreadLabel}
                    </p>
                  ) : null}
                  {visibleError ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-4 w-fit"
                      onClick={() => void onRetry()}
                    >
                      <RefreshCwIcon className="size-3.5" />
                      Retry
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          )}

          <div className="sticky bottom-0 mt-auto flex flex-col overflow-visible rounded-t-(--composer-radius) bg-gradient-to-t from-background via-background/95 to-transparent pt-7 pb-4 md:pb-6">
            {matchingCommands.length > 0 ? (
              <div
                id="draft-slash-commands"
                role="listbox"
                aria-label="Commands"
                className="bg-popover text-popover-foreground absolute bottom-full left-0 z-30 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border p-1 shadow-lg"
              >
                {matchingCommands.map((command, index) => {
                  const Icon = command.icon;
                  return (
                    <button
                      key={command.id}
                      id={`draft-command-${command.id}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === highlightedIndex}
                      className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm outline-none ${index === highlightedIndex ? "bg-accent text-accent-foreground" : ""}`}
                      onPointerDown={(event) => event.preventDefault()}
                      onPointerMove={() => setCommandIndex(index)}
                      onClick={() => void executeDraftCommand(command)}
                    >
                      {Icon ? (
                        <Icon
                          aria-hidden="true"
                          className="text-muted-foreground mt-0.5 size-4 shrink-0"
                        />
                      ) : null}
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{command.label}</span>
                        {command.description ? (
                          <span className="text-muted-foreground mt-0.5 block text-xs">
                            {command.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div data-slot="aui_composer-shell" className={workbenchComposerShellClassName}>
              <textarea
                ref={registerComposerInput}
                value={draft}
                onChange={(event) => {
                  setCommandIndex(0);
                  setCommandsDismissed(false);
                  onDraftChange(event.target.value);
                }}
                onFocus={() => {
                  setCommandsDismissed(false);
                  onFocus();
                }}
                onBlur={() => setCommandsDismissed(true)}
                aria-autocomplete="list"
                aria-controls={matchingCommands.length ? "draft-slash-commands" : undefined}
                aria-activedescendant={
                  matchingCommands.length
                    ? `draft-command-${matchingCommands[highlightedIndex]!.id}`
                    : undefined
                }
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (matchingCommands.length) {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      setCommandIndex(
                        (highlightedIndex +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          matchingCommands.length) %
                          matchingCommands.length,
                      );
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setCommandsDismissed(true);
                      return;
                    }
                  }
                  if (event.key !== "Enter" || event.shiftKey) return;
                  event.preventDefault();
                  void submitDraft();
                }}
                placeholder="Message or / for commands…"
                className={workbenchComposerInputClassName}
                rows={1}
                autoFocus
                disabled={isSubmitting}
                aria-label="Message input"
              />
              <div className="flex items-center justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 rounded-full"
                  disabled
                  aria-label="Add Attachment"
                >
                  <PlusIcon className="size-5 stroke-[1.5px]" />
                </Button>
                {isSubmitting ? (
                  <span
                    className="text-muted-foreground flex h-8 items-center gap-2 px-1 text-xs"
                    role="status"
                    aria-live="polite"
                  >
                    <Loader2Icon className="size-3.5 animate-spin" />
                    Sending…
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="default"
                    size="icon"
                    className="size-8 rounded-full"
                    disabled={!isLocalNewSession || !draft.trim()}
                    aria-label={
                      isLocalNewSession ? "Send message" : "Send unavailable while connecting"
                    }
                    title={
                      isLocalNewSession
                        ? "Create the chat and send this message"
                        : "Send is available when the Agent connection is ready"
                    }
                    onClick={() => void submitDraft()}
                  >
                    <ArrowUpIcon className="size-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
