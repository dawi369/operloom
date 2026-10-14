import { describe, expect, it } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  listToolResultRenderers,
  rendererPayloadBytes,
  resolveArtifactRenderer,
  resolveToolResultRenderer,
  sanitizeRendererValue,
  withinRendererBound,
} from "./web-registry";
import { RuntimeArtifactContent } from "../../components/workbench/runtime-artifact-content";
import { PackToolResult } from "../../components/assistant-ui/pack-tool-renderers";

describe("compiled web runtime registry", () => {
  it("resolves a trusted package renderer with runtime metadata", () => {
    const resolved = resolveArtifactRenderer("complex_operator_report");
    expect(resolved).toMatchObject({
      packId: "complex-operator",
      descriptor: { renderer: "module" },
    });
    expect(resolved?.runtimeVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof resolved?.renderer).toBe("function");
  });

  it("bounds renderer props and removes credential-like keys", () => {
    const value = sanitizeRendererValue({
      token: "hidden",
      nested: {
        authorization: "hidden",
        visible: "kept",
      },
      long: "x".repeat(20_000),
    }) as Record<string, unknown>;
    expect(value).not.toHaveProperty("token");
    expect(value.nested).toEqual({ visible: "kept" });
    expect(String(value.long)).toHaveLength(16_384);
  });

  it("resolves declared tool result renderers with their bounds", () => {
    expect(listToolResultRenderers()).toContainEqual({
      packId: "document-review",
      toolId: "document-review.record",
    });
    const resolved = resolveToolResultRenderer("document-review.record");
    expect(resolved).toMatchObject({ packId: "document-review", descriptor: { version: 1 } });
    expect(typeof resolved?.renderer).toBe("function");
    expect(resolveToolResultRenderer("document-review.unknown")).toBeNull();
    expect(resolveToolResultRenderer(undefined)).toBeNull();
  });

  it("measures payloads against the declared bound", () => {
    expect(rendererPayloadBytes({ a: 1 })).toBe(7);
    expect(withinRendererBound("x".repeat(100), 1024)).toBe(true);
    expect(withinRendererBound("x".repeat(2000), 1024)).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(withinRendererBound(circular)).toBe(false);
  });

  it("renders a module artifact inside the bound and falls back to JSON beyond it", () => {
    const artifact = {
      id: "artifact-1",
      kind: "document_review_report",
      title: "Review of guide",
      mimeType: "application/json",
      data: {
        documentId: "guide",
        outcome: "reviewed",
        wordCount: 4,
        excerpt: "A short document.",
      },
    };
    const card = renderToStaticMarkup(createElement(RuntimeArtifactContent, { artifact }));
    expect(card).toContain('data-slot="pack-artifact-renderer"');
    expect(card).toContain("guide · reviewed · 4 words");
    const oversize = renderToStaticMarkup(
      createElement(RuntimeArtifactContent, {
        artifact: { ...artifact, data: { ...artifact.data, excerpt: "x".repeat(5000) } },
      }),
    );
    expect(oversize).not.toContain("pack-artifact-renderer");
    expect(oversize).toContain("<pre");
    const generic = renderToStaticMarkup(
      createElement(RuntimeArtifactContent, { artifact: { ...artifact, kind: "unknown_kind" } }),
    );
    expect(generic).toContain("<pre");
  });

  it("renders a declared tool result with the package component and the fallback otherwise", () => {
    const part = {
      type: "tool-call" as const,
      toolCallId: "call-1",
      toolName: "document-review.record",
      args: { documentId: "guide" },
      argsText: '{"documentId":"guide"}',
      result: { wordCount: 4, token: "must-not-reach-component" },
      status: { type: "complete" as const },
      addResult: () => undefined,
    };
    const markup = renderToStaticMarkup(createElement(PackToolResult, part as never));
    expect(markup).toContain('data-slot="pack-tool-renderer"');
    expect(markup).toContain("Review guide: complete");
    expect(markup).toContain("4 words recorded");
    expect(markup).not.toContain("must-not-reach-component");
    const unknown = renderToStaticMarkup(
      createElement(PackToolResult, { ...part, toolName: "document-review.other" } as never),
    );
    expect(unknown).not.toContain("pack-tool-renderer");
    expect(unknown).toContain("document-review.other");
  });
});
