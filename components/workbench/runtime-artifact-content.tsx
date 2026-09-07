"use client";

import {
  Component,
  createElement,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { ArtifactRendererProps } from "@operloom/agent-sdk/web";

import { resolveArtifactRenderer, sanitizeRendererValue } from "@/lib/agent-runtime/web-registry";
import type { ArtifactSummary } from "@/lib/workbench/workbench-types";

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

const GenericArtifact = ({
  artifact,
  kind,
}: {
  artifact: ArtifactSummary;
  kind: "json" | "markdown" | "table";
}) => {
  const data = sanitizeRendererValue(artifact.data);
  if (kind === "markdown") {
    const text =
      data && typeof data === "object" && "markdown" in data
        ? String((data as { markdown: unknown }).markdown)
        : JSON.stringify(data, null, 2);
    return <div className="text-muted-foreground whitespace-pre-wrap">{text}</div>;
  }
  if (kind === "table" && data && typeof data === "object") {
    const rows = Object.entries(data as Record<string, unknown>).slice(0, 20);
    return (
      <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1">
        {rows.map(([key, value]) => (
          <span key={key} className="contents">
            <dt className="text-muted-foreground font-medium">{key}</dt>
            <dd className="min-w-0 break-words">
              {typeof value === "string" ? value : JSON.stringify(value)}
            </dd>
          </span>
        ))}
      </dl>
    );
  }
  return (
    <pre className="bg-muted max-h-64 overflow-auto rounded-md p-2 whitespace-pre-wrap">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
};

export function RuntimeArtifactContent({ artifact }: { artifact: ArtifactSummary }) {
  const resolved = resolveArtifactRenderer(artifact.kind);
  const genericKind = resolved?.descriptor?.renderer ?? "json";
  const fallback = <GenericArtifact artifact={artifact} kind={genericKind} />;
  if (typeof resolved?.renderer !== "function") return fallback;
  const props: ArtifactRendererProps = {
    artifact: {
      id: artifact.id,
      kind: artifact.kind ?? "artifact",
      title: artifact.title,
      mimeType: artifact.mimeType,
      data: sanitizeRendererValue(artifact.data) as Record<string, unknown>,
    },
  };
  return (
    <RendererBoundary fallback={fallback}>
      {createElement(resolved.renderer as ComponentType<ArtifactRendererProps>, props)}
    </RendererBoundary>
  );
}
