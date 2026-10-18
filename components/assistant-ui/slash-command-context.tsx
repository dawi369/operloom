"use client";

import type { useAui } from "@assistant-ui/react";
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

export type AssistantSlashCommandContext = {
  /** Absent while the first thread is still being materialized. */
  aui?: ReturnType<typeof useAui>;
  isLoadingThread: boolean;
  isThreadRunning: boolean;
  /** Text after the command when it accepts one, e.g. `/watch fed cut` → "fed cut". */
  argument?: string;
};

export type AssistantSlashCommand = {
  id: string;
  label: string;
  description?: string;
  icon?: ComponentType<{ className?: string }>;
  /** Lets `/id <text>` submit directly instead of only matching the bare command. */
  acceptsArgument?: boolean;
  execute: (context: AssistantSlashCommandContext) => void | Promise<void>;
};

const SlashCommandContext = createContext<readonly AssistantSlashCommand[]>([]);

export function AssistantSlashCommandProvider({
  commands,
  children,
}: {
  commands: readonly AssistantSlashCommand[];
  children: ReactNode;
}) {
  return <SlashCommandContext.Provider value={commands}>{children}</SlashCommandContext.Provider>;
}

export const useAssistantSlashCommands = () => useContext(SlashCommandContext);
