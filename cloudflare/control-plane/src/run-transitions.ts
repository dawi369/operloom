import type { RunStatus } from "./types";

export const activeRunStatuses = ["queued", "running", "waiting", "interrupted"] as const;
export const terminalRunStatuses = ["completed", "failed", "cancelled", "blocked"] as const;

export const activeRunStatusSql = "('queued', 'running', 'waiting', 'interrupted')";

const terminalStatusSet = new Set<RunStatus>(terminalRunStatuses);

export const isTerminalRunStatus = (status: RunStatus) => terminalStatusSet.has(status);
