import type { AgentExecutionContext, JsonSchema, RuntimeRecord } from "./runtime.js";

export type RuntimeStateKey = { namespace: string; kind: string; key: string };
export type RuntimeStateRead = RuntimeStateKey & { version: number };
export type RuntimeStateRecord = RuntimeStateRead & {
  schemaVersion: number;
  data: RuntimeRecord;
  updatedAt: string;
};
export type RuntimeStateDefinition = {
  namespace: string;
  kind: string;
  schemaVersion: number;
  schema: JsonSchema;
  indexes?: readonly { name: string; field: string }[];
};
/** Reviewed, deterministic top-level transformations. SQL and executable callbacks are absent. */
export type RuntimeStateMigration = {
  id: string;
  namespace: string;
  kind: string;
  fromVersion: number;
  toVersion: number;
  operations: readonly (
    | { op: "set" | "default"; field: string; value: unknown }
    | { op: "remove"; field: string }
    | { op: "rename"; from: string; to: string }
  )[];
};
export type RuntimeStateCommit = {
  idempotencyKey: string;
  /** Project one terminal provider receipt without dispatching it again. External state only. */
  projection?: { proposalId: string };
  reads: readonly RuntimeStateRead[];
  writes: readonly (RuntimeStateKey & { schemaVersion: number; data: RuntimeRecord })[];
  entries?: readonly { id: string; type: "decision" | "effect"; data: RuntimeRecord }[];
  events?: readonly { id: string; type: string; data: RuntimeRecord }[];
};
export type RuntimeStateReceipt = {
  id: string;
  committedAt: string;
  records: RuntimeStateRead[];
  entryIds: string[];
  eventIds: string[];
};
export type RuntimeStatePort = {
  get(key: RuntimeStateKey): Promise<RuntimeStateRecord | null>;
  list(input: {
    namespace: string;
    kind: string;
    limit?: number;
    cursor?: string;
    index?: { name: string; value: string | number | boolean | null };
  }): Promise<{ records: RuntimeStateRecord[]; nextCursor?: string }>;
  commit(input: RuntimeStateCommit): Promise<RuntimeStateReceipt>;
};

export const requireRuntimeState = (context: AgentExecutionContext): RuntimeStatePort => {
  if (!context.state)
    throw Object.assign(
      new Error(
        "This execution does not provide typed state. Require state.atomic.v2 in the package.",
      ),
      { code: "runtime_capability_missing" },
    );
  return context.state;
};
