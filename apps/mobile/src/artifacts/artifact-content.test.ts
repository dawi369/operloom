import { describe, expect, it } from "vitest";

import {
  artifactMeta,
  artifactRows,
  sanitizeArtifactData,
  withinRendererBound,
} from "./artifact-content";

describe("mobile artifact content", () => {
  it("flattens nested data into labelled rows", () => {
    expect(
      artifactRows({ summary: "ok", markets: [{ id: "m1", p: 0.4 }], empty: {}, none: null }),
    ).toEqual([
      { path: "summary", value: "ok", nested: false },
      { path: "markets", value: "1 items", nested: true },
      { path: "markets[0]", value: "", nested: true },
      { path: "markets[0].id", value: "m1", nested: false },
      { path: "markets[0].p", value: "0.4", nested: false },
      { path: "empty", value: "{}", nested: false },
      { path: "none", value: "null", nested: false },
    ]);
  });

  it("caps the number of rows", () => {
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(artifactRows(wide, 10)).toHaveLength(10);
  });

  it("strips credential-like keys and bounds payloads", () => {
    expect(sanitizeArtifactData({ apiToken: "x", title: "t", nested: { password: "p" } })).toEqual({
      title: "t",
      nested: {},
    });
    expect(withinRendererBound({ a: "b" })).toBe(true);
    expect(withinRendererBound("x".repeat(70_000))).toBe(false);
  });

  it("describes an artifact without repeating the default mime type", () => {
    expect(
      artifactMeta({
        id: "a1",
        kind: "market_research_report",
        createdAt: "2026-05-01T10:00:00.000Z",
        sizeBytes: 2048,
        mimeType: "application/json",
      }),
    ).toBe("market_research_report · 2026-05-01 · 2 KB");
  });
});
