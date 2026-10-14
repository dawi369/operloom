import type { AgentPackArtifactRenderer, AgentPackToolResultRenderer } from "@operloom/agent-sdk";
import { agentManifestRegistry } from "../../generated/agent-runtime/manifests";
import { agentWebRegistry } from "../../generated/agent-runtime/web";

const sensitiveKey = /(authorization|cookie|credential|password|secret|token)/i;
export const defaultRendererMaxBytes = 65_536;

export const sanitizeRendererValue = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return "[depth-limited]";
  if (typeof value === "string") return value.slice(0, 16_384);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeRendererValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitiveKey.test(key))
      .slice(0, 200)
      .map(([key, item]) => [key, sanitizeRendererValue(item, depth + 1)]),
  );
};

/** Serialized size of what a renderer would receive; the host compares it to the declared bound. */
export const rendererPayloadBytes = (value: unknown) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export const withinRendererBound = (value: unknown, maxBytes = defaultRendererMaxBytes) =>
  rendererPayloadBytes(value) <= maxBytes;

type ManifestModule = { artifactRenderers: readonly AgentPackArtifactRenderer[] } & {
  toolResultRenderers?: readonly AgentPackToolResultRenderer[];
};

const manifestFor = (packId: string) =>
  agentManifestRegistry[packId as keyof typeof agentManifestRegistry]?.module as
    | ManifestModule
    | undefined;

export const resolveArtifactRenderer = (artifactKind?: string) => {
  if (!artifactKind) return null;
  for (const [packId, entry] of Object.entries(agentWebRegistry)) {
    const renderer = (entry.module.artifactRenderers as Record<string, unknown>)[artifactKind];
    if (renderer) {
      return {
        packId,
        runtimeVersion: entry.module.runtimeVersion,
        descriptor: manifestFor(packId)?.artifactRenderers.find(
          (candidate) => candidate.artifactKind === artifactKind,
        ),
        renderer,
      };
    }
  }
  return null;
};

/** The compiled registry: declared tool ids with a web component and their bounds. */
export const resolveToolResultRenderer = (toolId?: string) => {
  if (!toolId) return null;
  for (const [packId, entry] of Object.entries(agentWebRegistry)) {
    const renderers = (entry.module as { toolResultRenderers?: Record<string, unknown> })
      .toolResultRenderers;
    const renderer = renderers?.[toolId];
    if (typeof renderer === "function") {
      return {
        packId,
        runtimeVersion: entry.module.runtimeVersion,
        descriptor: manifestFor(packId)?.toolResultRenderers?.find(
          (candidate) => candidate.toolId === toolId,
        ),
        renderer,
      };
    }
  }
  return null;
};

export const listToolResultRenderers = () =>
  Object.entries(agentWebRegistry).flatMap(([packId, entry]) =>
    Object.keys(
      (entry.module as { toolResultRenderers?: Record<string, unknown> }).toolResultRenderers ?? {},
    ).map((toolId) => ({ packId, toolId })),
  );
