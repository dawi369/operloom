import type { JsonSchema, RuntimeRecord } from "./runtime.js";

export type RuntimeModelRequest = {
  idempotencyKey: string;
  prompt: string;
  outputSchema: JsonSchema;
  maxOutputTokens?: number;
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
