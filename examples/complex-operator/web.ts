import { createElement } from "react";

import {
  defineWebModule,
  type ArtifactRendererProps,
  type WebRuntimeModule,
} from "@operloom/agent-sdk/web";

export const ComplexOperatorArtifact = ({ artifact }: ArtifactRendererProps) =>
  createElement(
    "section",
    { "data-runtime-renderer": "complex-operator" },
    createElement("h3", null, artifact.title ?? "Complex operator report"),
    createElement("pre", null, JSON.stringify(artifact.data ?? artifact.content ?? {}, null, 2)),
  );

export const web: WebRuntimeModule = defineWebModule({
  packId: "complex-operator",
  runtimeVersion: "1.2.3",
  compatiblePackVersions: "^1.1.0",
  artifactRenderers: { complex_operator_report: ComplexOperatorArtifact },
  managedStateRenderers: {
    "complex-operator.observation": { kind: "generic_detail", version: 1 },
  },
});
