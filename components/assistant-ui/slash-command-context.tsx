"use client";

import type { useAui } from "@assistant-ui/react";
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

export type AssistantSlashCommandContext = {
  /** Absent while the first thread is still being materialized. */
  aui?: ReturnType<typeof useAui>;
  isLoadingThread: boolean;
  isThreadRunning: boolean;
};

export type AssistantSlashCommand = {
  id: string;
  label: string;
  description?: string;
  icon?: ComponentType<{ className?: string }>;
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
