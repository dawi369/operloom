import type { JsonSchema, AgentExecutionContext, RuntimeRecord } from "./runtime.js";

/** Ports are acquired inside a step and must never escape its callback. */
export type RuntimeDurableStepContext = Pick<
  AgentExecutionContext,
  "scope" | "pack" | "run" | "signal" | "state" | "context" | "models" | "tools"
>;

export type RuntimeDurableStep = {
  key: string;
  version: string;
  payload: RuntimeRecord;
  outputSchema: JsonSchema;
  timeoutMs: number;
  replaySafe: boolean;
  maxAttempts: number;
};

/** Confirms this immutable review payload; it does not grant tool/effect permissions. */
export type RuntimeDurableApproval = {
  key: string;
  version: string;
  summary: string;
  payload: RuntimeRecord;
  timeoutMs: number;
};
export type RuntimeDurableApprovalReceipt = {
  id: string;
  requestHash: string;
  decidedAt: string;
  decidedByUserId: string;
};

/** Orchestration is replayed. Do not perform I/O or read clocks/randomness outside a step. */
export type RuntimeDurableWorkflowContext = {
  step(
    definition: RuntimeDurableStep,
    execute: (context: RuntimeDurableStepContext) => Promise<RuntimeRecord> | RuntimeRecord,
  ): Promise<RuntimeRecord>;
  sleep(key: string, durationMs: number): Promise<void>;
  approval(definition: RuntimeDurableApproval): Promise<RuntimeDurableApprovalReceipt>;
};

export type RuntimeDurableWorkflow = {
  version: string;
  maxSteps: number;
  maxDurationMs: number;
  execute: (
    input: RuntimeRecord,
    context: RuntimeDurableWorkflowContext,
  ) => Promise<RuntimeRecord> | RuntimeRecord;
};
