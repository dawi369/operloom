import { describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateText: vi.fn(), jsonSchema: vi.fn(), Output: { object: vi.fn() } }));
vi.mock("@openrouter/ai-sdk-provider", () => ({ createOpenRouter: vi.fn() }));

const { fixtureOutput, createRuntimeModelPort } = await import("./runtime-models");
const { createPackTestRuntime } = await import("./pack-test-runtime");
const { generateText } = await import("ai");
const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");

describe("structured model context", () => {
  it("keeps the context snapshot out of calls that opt out", async () => {
    const runtime = createPackTestRuntime({ packId: "resource-allocator" });
    try {
      runtime.db
        .prepare(
          `INSERT INTO control_runs (id,user_id,workspace_id,agent_id,workflow_intent_id,status,execution_json,data_json,created_at,updated_at)
           VALUES ('run','user','ws-user','agent-user','intent','running','{}','{}','now','now')`,
        )
        .run();
      vi.mocked(createOpenRouter).mockReturnValue({ chat: () => ({}) } as never);
      vi.mocked(generateText).mockResolvedValue({
        output: { verdict: "ok" },
        usage: { inputTokens: 5, outputTokens: 3 },
      } as never);
      const port = createRuntimeModelPort(
        { ...runtime.env, OPERLOOM_E2E_MODE: "false", OPENROUTER_API_KEY: "key" },
        runtime.identity(),
        {
          runId: "run",
          signal: new AbortController().signal,
          context: {
            snapshot: { id: "snapshot-1", note: "the user's own forecast" } as never,
            assertReady() {},
          },
        },
      );
      const result = await port.structured({
        idempotencyKey: "isolated",
        prompt: "Judge only this evidence.",
        outputSchema: {
          type: "object",
          required: ["verdict"],
          properties: { verdict: { type: "string" } },
        },
        includeContext: false,
      });
      expect(result.output).toEqual({ verdict: "ok" });
      const call = vi.mocked(generateText).mock.calls[0]![0] as unknown as {
        messages: { content: string }[];
      };
      expect(call.messages).toEqual([{ role: "user", content: "Judge only this evidence." }]);
    } finally {
      runtime.close();
    }
  });
});

describe("local structured model fixture", () => {
  it("produces a schema-valid output for any declared shape", () => {
    expect(
      fixtureOutput({
        type: "object",
        required: ["summary", "allocate", "units", "tier", "tags", "mode"],
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 2000 },
          allocate: { type: "boolean", default: true },
          units: { type: "integer", minimum: 1, maximum: 5 },
          tier: { type: "string", enum: ["low", "high"] },
          tags: { type: "array", minItems: 1, items: { type: "string", maxLength: 4 } },
          mode: { const: "fixture" },
        },
      }),
    ).toEqual({
      summary: "Deterministic local model fixture.",
      allocate: true,
      units: 1,
      tier: "low",
      tags: ["Dete"],
      mode: "fixture",
    });
    expect(fixtureOutput({ type: "string", minLength: 40 })).toHaveLength(40);
  });
});
