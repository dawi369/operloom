/**
 * Per-turn guards for the chat step loop.
 *
 * The loop is capped by `stepCountIs`; these guards decide what the model may do
 * in the steps that remain. Both are evaluated from completed steps only, never
 * from the live stream, and both fail open: an unexpected step shape counts as
 * no failure.
 */

export const runawayFailureThreshold = 2;

export const chatHardStepLimit = 3;

type StepContentPart = {
  type: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
};

export type GuardStep = { content: readonly StepContentPart[] };

export type RunawayDetection = {
  toolName: string;
  failures: number;
  lastError: string;
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

/** Same tool with the same input, regardless of key order, counts as the same call. */
export const canonicalToolInputKey = (toolName: string, input: unknown) =>
  `${toolName}\u0000${stableJson(input)}`;

const describeError = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (typeof record.message === "string") return record.message;
  }
  return "unknown error";
};

const toolFailure = (part: StepContentPart): { toolName: string; error: string } | null => {
  if (typeof part.toolName !== "string") return null;
  if (part.type === "tool-error")
    return { toolName: part.toolName, error: describeError(part.error) };
  if (part.type !== "tool-result") return null;
  const output = part.output;
  if (output && typeof output === "object" && (output as { ok?: unknown }).ok === false)
    return { toolName: part.toolName, error: describeError(output) };
  return null;
};

/**
 * Reports the first tool whose identical call failed `runawayFailureThreshold`
 * times in this turn. Retrying the same input again is strictly worse than
 * stopping and telling the user, so the caller should turn the next step into
 * a tool-less wrap-up.
 */
export const detectRunawayToolFailures = (
  steps: readonly GuardStep[],
  threshold: number = runawayFailureThreshold,
): RunawayDetection | null => {
  const counts = new Map<string, RunawayDetection>();
  for (const step of steps) {
    for (const part of step.content ?? []) {
      const failure = toolFailure(part);
      if (!failure) continue;
      const key = canonicalToolInputKey(failure.toolName, part.input);
      const current = counts.get(key) ?? { toolName: failure.toolName, failures: 0, lastError: "" };
      current.failures += 1;
      current.lastError = failure.error;
      counts.set(key, current);
      if (current.failures >= threshold) return current;
    }
  }
  return null;
};

export const runawayWrapUpInstruction = (detection: RunawayDetection) =>
  `\nTool "${detection.toolName}" failed ${detection.failures} times with identical input (last error: ${detection.lastError.slice(0, 200)}). Tools are disabled for the rest of this turn. Do not retry. Tell the user plainly what you tried, what failed and what they can do next.`;

export const finalStepInstruction =
  "\nThis is the last step of the turn and tools are disabled. Answer the user in prose from what you already have; name anything you could not complete.";

export type StepPlan = {
  /** `false` keeps the configured tools; an empty list disables them for the step. */
  activeTools: readonly string[] | false;
  instructionSuffix: string;
  runaway: RunawayDetection | null;
};

/**
 * Decides tool availability and extra instructions for the step about to run.
 * The final step is always tool-less so a turn never ends on a silent tool
 * result; a runaway detection disables tools earlier.
 */
export const planChatStep = (input: {
  stepNumber: number;
  steps: readonly GuardStep[];
  stepLimit?: number;
}): StepPlan => {
  const limit = input.stepLimit ?? chatHardStepLimit;
  const runaway = detectRunawayToolFailures(input.steps);
  if (runaway)
    return { activeTools: [], instructionSuffix: runawayWrapUpInstruction(runaway), runaway };
  if (input.stepNumber >= limit - 1)
    return { activeTools: [], instructionSuffix: finalStepInstruction, runaway: null };
  return { activeTools: false, instructionSuffix: "", runaway: null };
};
