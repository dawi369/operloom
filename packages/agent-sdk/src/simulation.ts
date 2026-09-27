import type { RuntimeScope } from "./runtime.js";
import type { RuntimeStatePort } from "./state.js";

/** Read-only inputs for an action simulator; it cannot reach connections, runners or the network. */
export type RuntimeSimulationContext = {
  scope: Readonly<RuntimeScope>;
  pack: Readonly<{ id: string; version: string; runtimeVersion: string }>;
  run: Readonly<{ id: string }>;
  signal: AbortSignal;
  /** Simulation-scope typed state. */
  state?: Pick<RuntimeStatePort, "get" | "list">;
};
