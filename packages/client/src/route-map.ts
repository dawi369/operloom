/**
 * The console reaches the Worker through Next.js routes under `/api/workbench`. A native
 * shell talks to the Worker's `/v1/me` directly, so every console path maps to the internal
 * operation path the Worker serves there. One table keeps both targets on one contract.
 */
export type WorkbenchClientTarget = "console" | "control-plane";

const consolePrefix = "/api/workbench";

/** Ordered: the first matching console prefix wins. `null` means the operation is console-only. */
const rules: ReadonlyArray<readonly [consolePath: string, workerPath: string | null]> = [
  ["/accounts", null],
  ["/admin", "/admin"],
  ["/fleet", "/workbench/fleet"],
  ["/memory/records", "/workbench/memory"],
  ["/chat-session/stream", "/chat/session/stream"],
  ["/chat-session", "/chat/session"],
  ["/workspaces", "/workspaces"],
  ["/agents", "/agents"],
  ["/agent-packs", "/agent-packs"],
  ["/tools", "/tools"],
  ["/agent-behavior-templates", "/agent-behavior-templates"],
];

export class ConsoleOnlyOperationError extends Error {
  readonly code = "console_only_operation";
  constructor(readonly consolePath: string) {
    super(`${consolePath} has no control-plane operation; use the console target.`);
  }
}

/** Maps a console request path (with query string) to the Worker operation path. */
export const toControlPlanePath = (consolePath: string) => {
  if (!consolePath.startsWith(`${consolePrefix}/`)) return consolePath;
  const rest = consolePath.slice(consolePrefix.length);
  for (const [prefix, workerPrefix] of rules) {
    if (rest === prefix || rest.startsWith(`${prefix}/`) || rest.startsWith(`${prefix}?`)) {
      if (workerPrefix === null) throw new ConsoleOnlyOperationError(consolePath);
      return `${workerPrefix}${rest.slice(prefix.length)}`;
    }
  }
  return `/workbench${rest}`;
};

export const resolveTargetPath = (target: WorkbenchClientTarget, consolePath: string) =>
  target === "control-plane" ? toControlPlanePath(consolePath) : consolePath;
