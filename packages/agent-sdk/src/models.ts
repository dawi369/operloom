import type { JsonSchema, RuntimeRecord } from "./runtime.js";

export type RuntimeModelRequest = {
  idempotencyKey: string;
  prompt: string;
  outputSchema: JsonSchema;
  maxOutputTokens?: number;
  /**
   * Default true. False keeps the run's context snapshot out of the call, for judgments that
   * must rest only on the evidence in `prompt` (for example, an estimate that must not see
   * the user's own forecast).
   */
  includeContext?: boolean;
};
export type RuntimeModelResult = {
  reservationId: string;
  model: string;
  output: RuntimeRecord;
  usage: {
    estimatedInputTokens: number;
    reservedTokens: number;
    inputTokens?: number;
    outputTokens?: number;
    source: "provider" | "fixture" | "unreported";
  };
};
export type RuntimeModelPort = {
  structured(input: RuntimeModelRequest): Promise<RuntimeModelResult>;
};
