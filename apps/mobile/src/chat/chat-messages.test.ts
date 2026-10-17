import { describe, expect, it } from "vitest";

import { messagesFromChatEvent, threadMessagesFromWire } from "./chat-messages";

describe("mobile chat transcript conversion", () => {
  it("preserves stable message identity and supported display parts", () => {
    expect(
      threadMessagesFromWire([
        { id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "checking" },
            { type: "reasoning", text: "" },
            {
              type: "tool-repo_snapshot",
              toolCallId: "tool-1",
              state: "output-available",
              input: { depth: 2 },
              output: { files: 4 },
            },
            { type: "text", text: "done" },
          ],
        },
      ]),
    ).toEqual([
      { id: "user-1", role: "user", content: [{ type: "text", text: "hello" }] },
      {
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "checking" },
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "repo_snapshot",
            args: { depth: 2 },
            result: { files: 4 },
            isError: false,
          },
          { type: "text", text: "done" },
        ],
      },
    ]);
  });

  it("reads transcripts only and drops unsupported roles", () => {
    expect(messagesFromChatEvent({ type: "connection", state: "connected" })).toBeNull();
    expect(
      messagesFromChatEvent({
        type: "transcript",
        messages: [
          { id: "tool-1", role: "tool", parts: [] },
          { id: "u", role: "user", parts: "nope" },
        ],
      }),
    ).toEqual([{ id: "u", role: "user", content: [] }]);
  });
});
