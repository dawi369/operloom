import { describe, expect, it } from "vitest";
import { assertUsableChatCompletion, chatCompletionGuard } from "./chat-completion";

describe("usable chat completion", () => {
  it.each(["", " \n\t"])("rejects empty or reasoning-only output %j", (text) => {
    expect(() => assertUsableChatCompletion({ text, finishReason: "stop" })).toThrow("no answer");
  });
  it("distinguishes truncated output and preserves the partial answer", () => {
    expect(() =>
      assertUsableChatCompletion({ text: "Partial answer", finishReason: "length" }),
    ).toThrow("output limit");
  });
  it("accepts a normal visible answer but rejects unfinished tool loops", () => {
    expect(() =>
      assertUsableChatCompletion({ text: "Answer", finishReason: "stop" }),
    ).not.toThrow();
    expect(() =>
      assertUsableChatCompletion({ text: "Checking", finishReason: "tool-calls" }),
    ).toThrow("did not finish");
  });
});

it("sends a visible stream error instead of empty success", async () => {
  const source = new ReadableStream<import("ai").UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: "reasoning-start", id: "r" });
      controller.enqueue({ type: "reasoning-delta", id: "r", delta: "Private reasoning" });
      controller.enqueue({ type: "reasoning-end", id: "r" });
      controller.enqueue({ type: "finish", finishReason: "stop" });
      controller.close();
    },
  });
  const reader = source.pipeThrough(chatCompletionGuard()).getReader();
  const chunks = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
  }
  expect(chunks.at(-1)).toMatchObject({
    type: "error",
    errorText: expect.stringContaining("no answer"),
  });
  expect(chunks.some((chunk) => chunk.type === "finish")).toBe(false);
});
