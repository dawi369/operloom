import { describe, expect, it } from "vitest";

import { exampleValue } from "./test-agent-pack";

describe("agent-pack conformance input generation", () => {
  it("prefers default, then enum, then the first schema example", () => {
    expect(exampleValue({ type: "string", default: "d", enum: ["e"], examples: ["x"] })).toBe("d");
    expect(exampleValue({ type: "string", enum: ["e"], examples: ["x"] })).toBe("e");
    expect(exampleValue({ type: "string", pattern: "^0x[0-9a-f]{40}$", examples: ["0xabc"] })).toBe(
      "0xabc",
    );
    expect(exampleValue({ type: "string" })).toBe("conformance");
  });

  it("uses property examples for required object fields", () => {
    expect(
      exampleValue({
        type: "object",
        required: ["walletAddress"],
        properties: {
          walletAddress: {
            type: "string",
            examples: ["0x1111111111111111111111111111111111111111"],
          },
          note: { type: "string" },
        },
      }),
    ).toEqual({ walletAddress: "0x1111111111111111111111111111111111111111" });
  });
});
