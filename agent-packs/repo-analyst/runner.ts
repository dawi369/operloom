import { defineRunnerModule, type AgentExecutionContext } from "@operloom/agent-sdk/runner";
import type {
  RepoSnapshotCommandMetric,
  RepoSnapshotOutput,
  RepoSnapshotResult,
} from "../../lib/workbench/repo-snapshot";

import { repoSnapshotError, validateRepoSnapshotInput } from "../../lib/workbench/repo-snapshot";
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

const snapshotWithRecipes = async (
  input: unknown,
  recipes: NonNullable<AgentExecutionContext["recipes"]>,
): Promise<RepoSnapshotResult> => {
  const parsed = validateRepoSnapshotInput(input);
  if ("code" in parsed) return { ok: false, error: parsed };
  const startedAt = Date.now();
  const listing = await recipes.repository({ source: ".", maxFiles: 80 });
  if (listing.status === "unavailable")
    return {
      ok: false,
      error: repoSnapshotError("repo_snapshot_unavailable", "ripgrep is not available."),
    };
  if (listing.status !== "completed")
    return {
      ok: false,
      error: repoSnapshotError("repo_snapshot_failed", `Repository listing ${listing.status}.`),
    };
  const docs =
    parsed.includeDocs === false
      ? []
      : (await recipes.repository({ source: "docs", maxFiles: 40 })).files;
  const configFiles =
    parsed.includeConfig === false
      ? []
      : listing.files
          .filter((file) =>
            /(^|\/)(package\.json|pnpm-lock\.yaml|[^/]*\.config\.[^/]+|[^/]*\.toml|[^/]*\.jsonc|Dockerfile[^/]*|\.dockerignore)$/.test(
              file,
            ),
          )
          .slice(0, 40);
  const metric = (
    name: string,
    status: RepoSnapshotCommandMetric["status"],
    durationMs: number,
    bytes: number,
  ) => ({
    name,
    command: "recipes.repository",
    status,
    durationMs,
    stdoutBytes: bytes,
    stderrBytes: 0,
  });
  const output: RepoSnapshotOutput = {
    status: "ok",
    summary: `Repository snapshot captured ${listing.files.length} files, ${docs.length} docs, and ${configFiles.length} config files.`,
    packageManager: listing.packageManager,
    scripts: parsed.includeScripts === false ? [] : [...listing.scripts],
    repoFiles: [...listing.files],
    docs: [...docs],
    configFiles,
    signals: [
      ...(listing.packageManager
        ? [{ kind: "package" as const, title: "Package manager", value: listing.packageManager }]
        : []),
      { kind: "runtime", title: "Runner", value: "operloom-runner" },
      ...configFiles
        .slice(0, 8)
        .map((file) => ({ kind: "config" as const, title: "Config file", value: file })),
      ...docs
        .slice(0, 8)
        .map((file) => ({ kind: "docs" as const, title: "Doc file", value: file })),
    ],
    commandMetrics: [
      metric("repo-files", "completed", listing.usage.durationMs, listing.usage.bytes),
      metric("docs", "completed", 0, 0),
      metric("config", "completed", 0, 0),
    ],
    timingMs: Date.now() - startedAt,
  };
  return { ok: true, output };
};
const urlInspect = binding("url.inspect");

export const runner = defineRunnerModule({
  packId: controlPlane.packId,
  runtimeVersion: controlPlane.runtimeVersion,
  compatiblePackVersions: controlPlane.compatiblePackVersions,
  tools: [
    {
      ...repoSnapshot,
      async execute(input, context) {
        // The repository recipe is the bounded path; the direct runner remains for hosts without recipes.
        const result = context.recipes
          ? await snapshotWithRecipes(input, context.recipes)
          : await runRepoSnapshot(input);
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
