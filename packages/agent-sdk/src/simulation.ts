import type { ActionProposal, RuntimeRecord } from "./runtime.js";
import type { RuntimeStateCommit, RuntimeStateReceipt } from "./state.js";

/** A complete proposed state transition. Repeat the exact plan after response loss. */
export type RuntimeSimulationCommit = Omit<
  ActionProposal,
  "preconditions" | "expiresAt" | "reservations"
> & {
  state: Pick<RuntimeStateCommit, "reads" | "writes">;
  decisions: readonly { id: string; data: RuntimeRecord }[];
  output: RuntimeRecord;
};
export type RuntimeSimulationReceipt = {
  target: "simulation";
  status: "committed";
  effectId: string;
  receipt: RuntimeStateReceipt;
  output: RuntimeRecord;
};
