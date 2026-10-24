"use client";

import {
  Component,
  createElement,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { ToolResultRendererProps } from "@operloom/agent-sdk/web";

import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import {
  resolveToolResultRenderer,
  sanitizeRendererValue,
  withinRendererBound,
} from "@/lib/agent-runtime/web-registry";

class RendererBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {}

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const artifactRefs = (result: unknown): ToolResultRendererProps["artifactRefs"] => {
  const list =
    result &&
    typeof result === "object" &&
    Array.isArray((result as { artifacts?: unknown }).artifacts)
      ? ((result as { artifacts: unknown[] }).artifacts as Record<string, unknown>[])
      : [];
  return list
    .filter((item) => item && typeof item.id === "string" && typeof item.kind === "string")
    .map((item) => ({
      id: String(item.id),
      kind: String(item.kind),
      ...(typeof item.title === "string" ? { title: item.title } : {}),
    }));
};

/**
 * Renders one tool call with the package's component when the compiled
 * registry has one for the tool and the payload is inside its bound; otherwise
 * the generic fallback. The thread's `tool-call` part renders through this
 * directly, so no renderer is registered in model context and the Worker stays
 * the only place that exposes tools to the model.
 */
export const PackToolResult = (part: ToolCallMessagePartProps) => {
  const fallback = <ToolFallback {...part} />;
  const resolved = resolveToolResultRenderer(part.toolName);
  if (!resolved) return fallback;
  const input = sanitizeRendererValue(part.args) as Record<string, unknown>;
  const output = sanitizeRendererValue(part.result);
  if (!withinRendererBound({ input, output }, resolved.descriptor?.maxBytes)) return fallback;
  const props: ToolResultRendererProps = {
    toolId: part.toolName,
    status: part.status?.type ?? "complete",
    input: input ?? {},
    output,
    artifactRefs: artifactRefs(part.result),
  };
  return (
    <RendererBoundary fallback={fallback}>
      <div data-slot="pack-tool-renderer" data-pack={resolved.packId} data-tool={part.toolName}>
        {createElement(resolved.renderer as ComponentType<ToolResultRendererProps>, props)}
      </div>
    </RendererBoundary>
  );
};
