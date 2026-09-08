import { defineWebModule } from "@operloom/agent-sdk/web";

export const web = defineWebModule({
  packId: "repo-analyst",
  runtimeVersion: "1.1.0",
  compatiblePackVersions: "^1.2.0",
  artifactRenderers: {
    repo_readiness_report: { kind: "json", version: 1 },
    repo_snapshot_report: { kind: "json", version: 1 },
  },
  managedStateRenderers: {
    "repo-monitor.repository-readiness": { kind: "generic_detail", version: 1 },
  },
});
