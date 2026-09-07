/**
 * Main assistant thread composition.
 *
 * This assembles assistant-ui primitives, markdown rendering, reasoning parts,
 * tool-call groups, attachments, and composer controls into the chat surface.
 * Keep domain-specific workbench panels around this component rather than
 * baking app-specific concepts into message rendering.
 */
import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import {
  workbenchComposerInputClassName,
  workbenchComposerShellClassName,
} from "@/components/assistant-ui/composer-style";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/reasoning";
import {
  useAssistantSlashCommands,
  type AssistantSlashCommand,
} from "@/components/assistant-ui/slash-command-context";
import { useWorkbenchComposerFocus } from "@/components/workbench/composer-focus-context";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/tool-group";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import {
  StarterSuggestionGrid,
  ThreadWelcomeLayout,
} from "@/components/assistant-ui/thread-welcome";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkbenchAgentConnection } from "@/lib/workbench/use-agent-connection";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  unstable_useSlashCommandAdapter,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowRightLeftIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  type FC,
  type FormEvent,
  type MouseEventHandler,
} from "react";

export const Thread: FC<{ pendingFirstTurn?: boolean }> = ({ pendingFirstTurn = false }) => {
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-transparent @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-radius" as string]: "24px",
        ["--composer-padding" as string]: "10px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-auto scroll-smooth"
      >
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <ThreadWelcome />
          </AuiIf>

          <div data-slot="aui_message-group" className="mb-10 flex flex-col gap-y-8 empty:hidden">
            <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
          </div>

          <ThreadAgentHandoffMarker />

          <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mt-auto flex flex-col gap-4 overflow-visible rounded-t-(--composer-radius) bg-gradient-to-t from-background via-background/95 to-transparent pt-7 pb-4 md:pb-6">
            <ThreadScrollToBottom />
            <Composer pendingFirstTurn={pendingFirstTurn} />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadAgentHandoffMarker: FC = () => {
  const { session } = useWorkbenchAgentConnection();
  const handoff = session?.agentHandoff ?? session?.activeThread?.agentHandoff ?? null;
  const activeThreadId = session?.activeThread?.threadId;

  if (!handoff || handoff.target !== "current_thread") return null;
  if (handoff.threadId && activeThreadId && handoff.threadId !== activeThreadId) return null;

  const fromAgent = handoff.fromAgentName ?? "previous agent";

  return (
    <div
      data-slot="workbench_agent-handoff-marker"
      className="mb-8 flex justify-center px-2 empty:hidden"
    >
      <div className="border-border bg-muted/50 text-muted-foreground inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs">
        <ArrowRightLeftIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          Switched from {fromAgent} to {handoff.toAgentName}. Future replies use{" "}
          {handoff.toAgentName} tools and behavior.
        </span>
      </div>
    </div>
  );
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessage />;
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <ThreadWelcomeLayout>
      <ThreadSuggestions />
    </ThreadWelcomeLayout>
  );
};

const ThreadSuggestions: FC = () => {
  const aui = useAui();
  const disabled = useAuiState((s) => s.thread.isDisabled || s.thread.isRunning);
  const runtimeSuggestionCount = useAuiState((s) => s.suggestions.suggestions.length);

  if (runtimeSuggestionCount === 0) {
    return (
      <StarterSuggestionGrid
        disabled={disabled}
        onSelect={(prompt) => {
          if (disabled) return;
          aui.thread().append({
            content: [{ type: "text", text: prompt }],
            runConfig: aui.composer().getState().runConfig,
          });
          aui.composer().setText("");
        }}
      />
    );
  }

  return (
    <div className="aui-thread-welcome-suggestions grid w-full gap-2 pb-4 @md:grid-cols-2">
      <ThreadPrimitive.Suggestions>{() => <ThreadSuggestionItem />}</ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display nth-[n+3]:hidden @md:nth-[n+3]:block">
      <SuggestionPrimitive.Trigger send asChild>
        <Button
          variant="ghost"
          className="aui-thread-welcome-suggestion bg-background hover:bg-muted h-auto min-h-16 w-full min-w-0 flex-col items-start justify-start gap-1 rounded-lg border px-4 py-3 text-start text-sm transition-colors"
        >
          <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1 max-w-full break-words font-medium" />
          <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 text-muted-foreground max-w-full break-words empty:hidden" />
        </Button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

const Composer: FC<{ pendingFirstTurn: boolean }> = ({ pendingFirstTurn }) => {
  const commands = useAssistantSlashCommands();
  const { focusComposerAfterInteraction, focusComposerAfterOverlayClose, registerComposerInput } =
    useWorkbenchComposerFocus();
  const aui = useAui();
  const composerRootRef = useRef<HTMLFormElement | null>(null);
  const composerText = useAuiState((s) => s.composer.text);
  const isThreadRunning = useAuiState((s) => s.thread.isRunning);
  const isLoadingThread = useAuiState((s) => s.threads.isLoading);
  const commandContext = {
    aui,
    isLoadingThread,
    isThreadRunning,
  };
  const registerInput = useCallback(
    (element: HTMLTextAreaElement | null) => {
      registerComposerInput(element);
    },
    [registerComposerInput],
  );

  const runExactSlashCommand = (submittedText: string, preventDefault: () => void) => {
    const normalizedText = submittedText.trim().toLowerCase();
    const command = commands.find((item) => normalizedText === `/${item.id.toLowerCase()}`);
    if (!command) return;

    preventDefault();
    aui.thread().composer().setText("");
    void command.execute(commandContext);
    focusComposerAfterInteraction();
  };

  useEffect(() => {
    if (!isSlashNavigationDraft(composerText, commands)) return;

    const handleOutsideInteraction = (event: MouseEvent | PointerEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (composerRootRef.current?.contains(target)) return;

      event.preventDefault();
      aui.composer().setText("");
      focusComposerAfterOverlayClose();
    };

    document.addEventListener("pointerdown", handleOutsideInteraction, true);
    document.addEventListener("mousedown", handleOutsideInteraction, true);
    document.addEventListener("touchstart", handleOutsideInteraction, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsideInteraction, true);
      document.removeEventListener("mousedown", handleOutsideInteraction, true);
      document.removeEventListener("touchstart", handleOutsideInteraction, true);
    };
  }, [aui, commands, composerText, focusComposerAfterOverlayClose]);

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root
        ref={composerRootRef}
        className="aui-composer-root relative flex w-full flex-col"
        onSubmit={(event: FormEvent<HTMLFormElement>) =>
          runExactSlashCommand(
            event.currentTarget.querySelector("textarea")?.value ?? composerText,
            () => event.preventDefault(),
          )
        }
        onKeyDownCapture={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          if (!(event.target instanceof HTMLTextAreaElement)) return;
          // Resolve from the input before the popover or send handler consumes Enter.
          runExactSlashCommand(event.target.value, () => {
            event.preventDefault();
            event.stopPropagation();
          });
        }}
      >
        <ComposerPrimitive.AttachmentDropzone asChild>
          <div data-slot="aui_composer-shell" className={workbenchComposerShellClassName}>
            <ComposerAttachments />
            <ComposerPrimitive.Input
              ref={registerInput}
              placeholder="Message or / for commands…"
              className={workbenchComposerInputClassName}
              rows={1}
              autoFocus
              disabled={pendingFirstTurn}
              aria-label="Message input"
            />
            <ComposerAction
              pendingFirstTurn={pendingFirstTurn}
              onSend={(event) =>
                runExactSlashCommand(
                  composerRootRef.current?.querySelector("textarea")?.value ?? composerText,
                  () => event.preventDefault(),
                )
              }
            />
          </div>
        </ComposerPrimitive.AttachmentDropzone>
        <ComposerSlashCommandPopover
          commands={commands}
          commandContext={commandContext}
          onCommandExecuted={focusComposerAfterInteraction}
        />
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
};

const isSlashNavigationDraft = (text: string, commands: readonly AssistantSlashCommand[]) => {
  const draft = text.trim();
  if (!draft.startsWith("/") || draft !== text || /\s/.test(draft)) return false;
  const query = draft.slice(1).toLowerCase();
  if (!query) return true;
  return commands.some((command) => {
    const id = command.id.toLowerCase();
    const label = command.label.toLowerCase().replace(/\s+/g, "-");
    return id.startsWith(query) || label.startsWith(query);
  });
};

const ComposerSlashCommandPopover: FC<{
  commands: readonly AssistantSlashCommand[];
  commandContext: {
    aui: ReturnType<typeof useAui>;
    isLoadingThread: boolean;
    isThreadRunning: boolean;
  };
  onCommandExecuted: () => void;
}> = ({ commands, commandContext, onCommandExecuted }) => {
  const slash = unstable_useSlashCommandAdapter({
    commands: commands.map((command) => ({
      id: command.id,
      label: command.label,
      description: command.description,
      execute: () => {
        void command.execute(commandContext);
        onCommandExecuted();
      },
    })),
    removeOnExecute: true,
  });

  if (commands.length === 0) return null;

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      adapter={slash.adapter}
      className="bg-popover text-popover-foreground absolute bottom-full left-0 z-30 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border p-1 shadow-lg"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) =>
          items.map((item, index) => {
            const command = commands.find((entry) => entry.id === item.id);
            const Icon = command?.icon;

            return (
              <ComposerPrimitive.Unstable_TriggerPopoverItem
                key={item.id}
                item={item}
                index={index}
                className="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm outline-none"
              >
                {Icon ? <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{item.label}</span>
                  {item.description ? (
                    <span className="text-muted-foreground mt-0.5 block text-xs">
                      {item.description}
                    </span>
                  ) : null}
                </span>
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            );
          })
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
};

const ComposerAction: FC<{
  pendingFirstTurn: boolean;
  onSend: MouseEventHandler<HTMLButtonElement>;
}> = ({ pendingFirstTurn, onSend }) => {
  if (pendingFirstTurn) {
    return (
      <div className="aui-composer-action-wrapper relative flex h-8 items-center justify-between">
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
        <span
          className="text-muted-foreground flex h-8 items-center gap-2 px-1 text-xs"
          role="status"
          aria-live="polite"
        >
          <Loader2Icon className="size-3.5 animate-spin" />
          Sending…
        </span>
      </div>
    );
  }

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <ComposerAddAttachment />
      <div className="flex min-w-0 items-center gap-2">
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild onClick={onSend}>
            <TooltipIconButton
              tooltip="Send message"
              side="top"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-8 rounded-full"
              aria-label="Send message"
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <TooltipIconButton
              tooltip="Stop response (Esc)"
              side="top"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-8 rounded-full"
              aria-label="Stop response"
            >
              <SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
            </TooltipIconButton>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message whitespace-pre-wrap break-words" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  // reserves space for action bar and compensates with `-mb` for consistent msg spacing
  // keeps hovered action bar from shifting layout (autohide doesn't support absolute positioning well)
  // for pt-[n] use -mb-[n + 6] & min-h-[n + 6] to preserve compensation
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `-mb-7.5 min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="group/message fade-in slide-in-from-bottom-1 animate-in relative duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        // [contain-intrinsic-size:auto_24px] fixes issue #4104, don't change without checking for regressions
        className="text-foreground px-2 leading-relaxed wrap-break-word [contain-intrinsic-size:auto_24px] [content-visibility:auto]"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "mcp-app": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-reasoning": {
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running} variant="ghost" className="mb-2">
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "group-tool":
                return (
                  <ToolGroupRoot>
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallback {...part} />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="always"
      className="aui-assistant-action-bar-root text-muted-foreground col-start-3 row-start-2 -ms-1 flex gap-1 data-[floating]:pointer-events-none data-[floating]:opacity-0 data-[floating]:transition-opacity data-[floating]:group-hover/message:pointer-events-auto data-[floating]:group-hover/message:opacity-100 data-[floating]:focus-within:pointer-events-auto data-[floating]:focus-within:opacity-100"
    >
      <ActionBarPrimitive.Copy asChild>
        <Button
          variant="ghost"
          size="icon"
          className="aui-button-icon size-6 p-1"
          aria-label="Copy"
        >
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon />
          </AuiIf>
          <span className="sr-only">Copy</span>
        </Button>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <Button
          variant="ghost"
          size="icon"
          className="aui-button-icon size-6 p-1"
          aria-label="Regenerate response"
        >
          <RefreshCwIcon />
          <span className="sr-only">Regenerate response</span>
        </Button>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="aui-button-icon size-6 p-1 data-[state=open]:bg-accent"
            aria-label="More actions"
          >
            <MoreHorizontalIcon />
            <span className="sr-only">More actions</span>
          </Button>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="aui-action-bar-more-content bg-popover text-popover-foreground z-50 min-w-32 overflow-hidden rounded-md border p-1 shadow-md"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_60px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-2xl px-4 py-2.5 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 row-start-3 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit p-4">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root data-slot="aui_edit-composer-wrapper" className="flex flex-col px-2">
      <ComposerPrimitive.Root className="aui-edit-composer-root bg-muted ms-auto flex w-full max-w-[85%] flex-col rounded-2xl">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent p-4 text-sm outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-3 mb-3 flex items-center gap-2 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm">Update</Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({ className, ...rest }) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
