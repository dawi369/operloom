import type { ArtifactRendererProps } from "@operloom/agent-sdk/native";
import type { ComponentType } from "react";

import { agentNativeRegistry } from "../../../../generated/agent-runtime/native";

type NativeRegistryEntry = {
  module: { runtimeVersion: string; artifactRenderers: Readonly<Record<string, unknown>> };
};

/** The pack component for an artifact kind, if any pack in the compiled registry ships one. */
export const resolveNativeArtifactRenderer = (artifactKind?: string) => {
  if (!artifactKind) return null;
  for (const [packId, entry] of Object.entries(
    agentNativeRegistry as Record<string, NativeRegistryEntry>,
  )) {
    const component = entry.module.artifactRenderers[artifactKind];
    if (typeof component === "function") {
      return {
        packId,
        runtimeVersion: entry.module.runtimeVersion,
        Component: component as ComponentType<ArtifactRendererProps>,
      };
    }
  }
  return null;
};
