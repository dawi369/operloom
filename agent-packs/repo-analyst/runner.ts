import { defineRunnerModule } from "@operloom/agent-sdk/runner";

import { runRepoSnapshot } from "../../lib/workbench/repo-snapshot-runner";
import { validateUrlInspectInput } from "../../lib/workbench/url-inspect";
import { inspectPublicUrl } from "../../scripts/public-url-inspect";
import { controlPlane } from "./control-plane";

const binding = (id: string) => {
  const tool = controlPlane.tools.find((candidate) => candidate.id === id);
  if (!tool) throw new Error(`Missing Repository Analyst tool declaration: ${id}`);
  return tool;
};

const repoSnapshot = binding("repo.snapshot");
const urlInspect = binding("url.inspect");

export const runner = defineRunnerModule({
  packId: controlPlane.packId,
  runtimeVersion: controlPlane.runtimeVersion,
  compatiblePackVersions: controlPlane.compatiblePackVersions,
  tools: [
    {
      ...repoSnapshot,
      async execute(input) {
        const result = await runRepoSnapshot(input);
        return result.ok
          ? {
              ...result,
              summary: result.output.summary,
              artifacts: [
                {
                  kind: "repo_snapshot_report",
                  title: "Repository snapshot report",
                  mimeType: "application/json",
                  data: {
                    summary: result.output.summary,
                    packageManager: result.output.packageManager ?? null,
                    timingMs: result.output.timingMs,
                    fileCounts: {
                      repositoryFiles: result.output.repoFiles.length,
                      documentationFiles: result.output.docs.length,
                      configurationFiles: result.output.configFiles.length,
                    },
                  },
                },
              ],
            }
          : { ...result, summary: result.error.message };
      },
    },
    {
      ...urlInspect,
      async execute(input, context) {
        const validated = validateUrlInspectInput(input);
        if (!validated.ok)
          return { ok: false as const, error: validated.error, summary: validated.error.message };
        const result = await inspectPublicUrl(validated.url, context.networkPolicy);
        return result.ok
          ? { ...result, summary: result.output.summary }
          : { ...result, summary: result.error.message };
      },
    },
  ],
});
