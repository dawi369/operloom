import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { usePackWorkflow } from "@/components/workbench/pack-workflow-context";
import { useWorkbenchAgentConnection } from "@/lib/workbench/use-agent-connection";

export const starterSuggestions = [
  {
    title: "Explore what’s possible",
    description: "Find a useful starting point for your task.",
    prompt:
      "Give me a concise readiness check for this chat session. Keep it practical and mention what you can help with next.",
  },
  {
    title: "Plan a project handoff",
    description: "Turn an idea into a concrete implementation plan.",
    prompt:
      "Help me turn a rough project idea into a short implementation plan with assumptions, risks, and next checks.",
  },
  {
    title: "Review a decision",
    description: "Surface assumptions before committing to a direction.",
    prompt:
      "Help me review a technical decision. Ask me what I am deciding, then help compare the tradeoffs, assumptions, and failure modes.",
  },
  {
    title: "Explain a failure",
    description: "Work from symptoms toward a testable explanation.",
    prompt:
      "If I tell you a chat message failed or did nothing, what exact facts should we inspect first?",
  },
] as const;

export function ThreadWelcomeLayout({
  animate = false,
  children,
}: {
  animate?: boolean;
  children: ReactNode;
}) {
  const { session } = useWorkbenchAgentConnection();
  const welcome = session?.activeAgent?.behavior.pack?.ui.welcome;
  return (
    <div
      className={`aui-thread-welcome-root my-auto flex grow flex-col${animate ? " workbench-enter" : ""}`}
    >
      <div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
        <div className="aui-thread-welcome-message flex size-full flex-col justify-center px-4">
          <span className="workbench-kicker mb-3">Active agent</span>
          <h1 className="aui-thread-welcome-message-inner font-display max-w-xl text-3xl leading-tight font-semibold tracking-[-0.025em] sm:text-4xl">
            {welcome?.title ?? "What are we working on?"}
          </h1>
          <p className="aui-thread-welcome-message-inner text-muted-foreground mt-2 max-w-xl text-base leading-6 sm:text-lg">
            {welcome?.description ??
              "Bring a question, a problem, or a workflow. We’ll take it from here."}
          </p>
        </div>
      </div>
      {children}
    </div>
  );
}

export function StarterSuggestionGrid({
  disabled = false,
  onSelect,
}: {
  disabled?: boolean;
  onSelect: (prompt: string) => void | Promise<void>;
}) {
  const { session } = useWorkbenchAgentConnection();
  const workflow = usePackWorkflow();
  const suggestions =
    session?.activeAgent?.behavior.pack?.ui.welcome?.starters ?? starterSuggestions;
  return (
    <div className="aui-thread-welcome-suggestions grid w-full auto-rows-fr gap-2 pb-4 @md:grid-cols-2">
      {suggestions.map((suggestion) => (
        <div
          key={suggestion.title}
          className="aui-thread-welcome-suggestion-display h-full min-w-0 nth-[n+3]:hidden @md:nth-[n+3]:block"
        >
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              if ("action" in suggestion) {
                if (suggestion.action.kind === "workflow") {
                  workflow?.openWorkflow(suggestion.action.workflowType);
                  return;
                }
                void onSelect(suggestion.action.prompt);
                return;
              }
              void onSelect(suggestion.prompt);
            }}
            className="aui-thread-welcome-suggestion bg-card/75 hover:bg-card hover:border-ring/45 h-full min-h-20 w-full min-w-0 flex-col items-start justify-start gap-1 overflow-hidden rounded-lg border px-4 py-3 text-start text-sm whitespace-normal shadow-[0_12px_28px_-28px_rgb(20_35_40/0.7)] transition-[background-color,border-color,transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[0_18px_32px_-26px_rgb(20_35_40/0.55)]"
          >
            <span className="aui-thread-welcome-suggestion-text-1 block w-full min-w-0 break-words font-medium whitespace-normal [overflow-wrap:anywhere]">
              {suggestion.title}
            </span>
            <span className="aui-thread-welcome-suggestion-text-2 text-muted-foreground block w-full min-w-0 break-words leading-5 whitespace-normal [overflow-wrap:anywhere]">
              {suggestion.description}
            </span>
          </Button>
        </div>
      ))}
    </div>
  );
}
