import { describe, expect, it } from "vitest";

import {
  canonicalToolInputKey,
  detectRunawayToolFailures,
  planChatStep,
  runawayFailureThreshold,
} from "./chat-turn-guards";

const failedResult = (toolName: string, input: unknown, error = "boom") => ({
  type: "tool-result",
  toolName,
  input,
  output: { ok: false, error },
});

const okResult = (toolName: string, input: unknown) => ({
  type: "tool-result",
  toolName,
  input,
  output: { ok: true, data: 1 },
});

describe("chat turn guards", () => {
  it("keys identical calls regardless of input key order", () => {
    expect(canonicalToolInputKey("repo.snapshot", { a: 1, b: { c: [1, 2] } })).toBe(
      canonicalToolInputKey("repo.snapshot", { b: { c: [1, 2] }, a: 1 }),
    );
    expect(canonicalToolInputKey("repo.snapshot", { a: 1 })).not.toBe(
      canonicalToolInputKey("repo.snapshot", { a: 2 }),
    );
  });

  it("detects the same failing call repeated across steps", () => {
    const detection = detectRunawayToolFailures([
      { content: [failedResult("repo.snapshot", { path: "." }, "first")] },
      { content: [failedResult("repo.snapshot", { path: "." }, "second")] },
    ]);
    expect(detection).toEqual({
      toolName: "repo.snapshot",
      failures: runawayFailureThreshold,
      lastError: "second",
    });
  });

  it("counts thrown tool errors and ok:false outputs together", () => {
    expect(
      detectRunawayToolFailures([
        {
          content: [{ type: "tool-error", toolName: "x", input: { q: 1 }, error: new Error("e") }],
        },
        { content: [failedResult("x", { q: 1 })] },
      ])?.lastError,
    ).toBe("boom");
  });

  it("ignores successes, different inputs and malformed parts", () => {
    expect(
      detectRunawayToolFailures([
        { content: [okResult("x", { q: 1 }), failedResult("x", { q: 1 })] },
        { content: [failedResult("x", { q: 2 }), { type: "text" }, { type: "tool-result" }] },
        { content: [okResult("x", { q: 1 })] },
      ]),
    ).toBeNull();
    expect(detectRunawayToolFailures([{ content: undefined as never }])).toBeNull();
  });

  it("keeps tools until the final step when nothing is wrong", () => {
    expect(planChatStep({ stepNumber: 0, steps: [] })).toEqual({
      activeTools: false,
      instructionSuffix: "",
      runaway: null,
    });
    expect(
      planChatStep({ stepNumber: 1, steps: [{ content: [okResult("x", {})] }] }).activeTools,
    ).toBe(false);
  });

  it("disables tools on the final step so the turn ends in prose", () => {
    const plan = planChatStep({ stepNumber: 2, steps: [] });
    expect(plan.activeTools).toEqual([]);
    expect(plan.instructionSuffix).toContain("last step");
    expect(planChatStep({ stepNumber: 4, steps: [], stepLimit: 5 }).activeTools).toEqual([]);
  });

  it("disables tools early with a wrap-up instruction on runaway failures", () => {
    const plan = planChatStep({
      stepNumber: 1,
      steps: [
        { content: [failedResult("x", { q: 1 }, "rate limited")] },
        { content: [failedResult("x", { q: 1 }, "rate limited")] },
      ],
    });
    expect(plan.activeTools).toEqual([]);
    expect(plan.runaway?.toolName).toBe("x");
    expect(plan.instructionSuffix).toContain("failed 2 times");
    expect(plan.instructionSuffix).toContain("rate limited");
    expect(plan.instructionSuffix).toContain("Do not retry");
  });
});
