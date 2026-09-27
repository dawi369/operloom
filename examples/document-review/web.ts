import { defineWebModule } from "@operloom/agent-sdk/web";
export const web = defineWebModule({
  packId: "document-review",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  artifactRenderers: {},
  managedStateRenderers: {
    "documents.review": { kind: "generic_detail", version: 1 },
    "documents.summary": { kind: "generic_detail", version: 1 },
  },
});
