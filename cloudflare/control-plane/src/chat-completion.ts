/** A provider finish is not proof that a usable answer was produced. */
export class ChatCompletionError extends Error {
  constructor(
    readonly code: "empty_response" | "truncated_response" | "incomplete_response",
    message: string,
  ) {
    super(message);
    this.name = "ChatCompletionError";
  }
}

export function assertUsableChatCompletion(event: { text: string; finishReason: string }) {
  if (event.finishReason === "length") {
    throw new ChatCompletionError(
      "truncated_response",
      "The model reached its output limit. Any partial answer is incomplete. You can ask for a shorter answer or continue explicitly.",
    );
  }
  if (!event.text.trim()) {
    throw new ChatCompletionError(
      "empty_response",
      "The model returned no answer. Your message is saved. Try again when ready; no retry was made automatically.",
    );
  }
  if (event.finishReason !== "stop") {
    throw new ChatCompletionError(
      "incomplete_response",
      "The model did not finish its answer. Review any partial output and retry when ready.",
    );
  }
}

/** Provider callbacks are observational; the UI stream must carry its own error. */
export function chatCompletionGuard() {
  let text = "";
  return new TransformStream<import("ai").UIMessageChunk, import("ai").UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type === "start-step") text = "";
      if (chunk.type === "text-delta") text += chunk.delta;
      if (chunk.type === "finish") {
        try {
          assertUsableChatCompletion({ text, finishReason: chunk.finishReason ?? "other" });
        } catch (error) {
          controller.enqueue({ type: "error", errorText: (error as ChatCompletionError).message });
          return;
        }
      }
      controller.enqueue(chunk);
    },
  });
}
