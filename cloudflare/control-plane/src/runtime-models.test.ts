import { describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateText: vi.fn(), jsonSchema: vi.fn(), Output: { object: vi.fn() } }));
vi.mock("@openrouter/ai-sdk-provider", () => ({ createOpenRouter: vi.fn() }));

const { fixtureOutput } = await import("./runtime-models");

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
