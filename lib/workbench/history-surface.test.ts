import { describe, expect, it } from "vitest";

import {
  buildArtifactPreview,
  countHistoryRuns,
  filterHistoryRuns,
  isOpenableArtifactUri,
  resolveFocusedRunId,
  searchHistoryRuns,
} from "./history-surface";
import type { ArtifactSummary, ExecutionHistoryRunSummary } from "./workbench-types";

const runs = [
  {
    id: "workflow-run",
    workflowIntentId: "intent-1",
    status: "completed",
    stage: "analyze",
    artifactIds: ["artifact-1"],
    toolCallCount: 3,
  },
  {
    id: "tool-run",
    status: "completed",
    stage: "observe",
    toolCallCount: 1,
  },
  {
    id: "failed-run",
    status: "failed",
    toolCallCount: 0,
  },
] satisfies ExecutionHistoryRunSummary[];

describe("history surface helpers", () => {
  it("keeps the default history filters focused on completed and failed outcomes", () => {
    expect(filterHistoryRuns(runs, "all").map((run) => run.id)).toEqual([
      "workflow-run",
      "tool-run",
      "failed-run",
    ]);
    expect(filterHistoryRuns(runs, "completed").map((run) => run.id)).toEqual([
      "workflow-run",
      "tool-run",
    ]);
    expect(filterHistoryRuns(runs, "failed").map((run) => run.id)).toEqual(["failed-run"]);
    expect(countHistoryRuns(runs)).toEqual({
      all: 3,
      completed: 2,
      failed: 1,
    });
  });

  it("searches run identity, summaries, status, stage, engine, and artifact ids", () => {
    const searchableRuns = [
      {
        ...runs[0],
        displayName: "Market research",
        summary: "Public GTA market report.",
        engine: "cloudflare",
      },
      {
        ...runs[1],
        displayName: "Runtime research",
        summary: "Swordfish ESH6 bars.",
        engine: "langgraph",
      },
    ] satisfies ExecutionHistoryRunSummary[];

    expect(searchHistoryRuns(searchableRuns, "gta cloudflare").map((run) => run.id)).toEqual([
      "workflow-run",
    ]);
    expect(searchHistoryRuns(searchableRuns, "artifact-1").map((run) => run.id)).toEqual([
      "workflow-run",
    ]);
    expect(searchHistoryRuns(searchableRuns, "ESH6").map((run) => run.id)).toEqual(["tool-run"]);
    expect(searchHistoryRuns(searchableRuns, "missing")).toEqual([]);
  });

  it("resolves focused run ids and falls back to the newest loaded run", () => {
    expect(resolveFocusedRunId(runs, { runId: "tool-run", createdAt: 1 })).toBe("tool-run");
    expect(resolveFocusedRunId(runs, { artifactId: "artifact-1", createdAt: 1 })).toBe(
      "workflow-run",
    );
    expect(resolveFocusedRunId(runs, { runId: "missing", createdAt: 1 })).toBe("workflow-run");
    expect(resolveFocusedRunId([], { runId: "missing", createdAt: 1 })).toBeNull();
  });

  it("formats artifact previews and gates openable URIs", () => {
    const artifact = {
      id: "artifact-1",
      title: "Market research",
      uri: "d1://control-plane/artifact-1/report.json",
      data: {
        summary: "Public market research summary.",
        report: "Longer markdown report.",
      },
    } satisfies ArtifactSummary;

    expect(buildArtifactPreview(artifact)).toMatchObject({
      title: "Market research",
      lines: [
        "Public market research summary.",
        "Longer markdown report.",
        "d1://control-plane/artifact-1/report.json",
      ],
    });
    expect(buildArtifactPreview(artifact).json).toContain("Public market research summary");
    expect(isOpenableArtifactUri("https://example.com/report.json")).toBe(true);
    expect(isOpenableArtifactUri("http://example.com/report.json")).toBe(true);
    expect(isOpenableArtifactUri("d1://control-plane/artifact-1/report.json")).toBe(false);
    expect(isOpenableArtifactUri("not a url")).toBe(false);
  });

  it("builds pack-neutral previews from structured reports", () => {
    const artifact = {
      id: "repo-report",
      kind: "repo_readiness_report",
      title: "Repository readiness report",
      data: {
        report: {
          summary: "Repository evidence captured.",
          packageManager: "pnpm",
          inventory: { repositoryFiles: 42, documentationFiles: 7 },
          warnings: ["Build verification is pending."],
        },
      },
    } satisfies ArtifactSummary;

    expect(buildArtifactPreview(artifact).lines).toEqual([
      "Repository evidence captured.",
      "Warning: Build verification is pending.",
    ]);

    expect(
      buildArtifactPreview({
        ...artifact,
        kind: "external_analysis_report",
      }).lines,
    ).toEqual(buildArtifactPreview(artifact).lines);
  });

  it("falls back safely for unknown and malformed report payloads", () => {
    expect(
      buildArtifactPreview({
        id: "unknown-report",
        kind: "external_analysis_report",
        data: { report: { summary: "Useful finding", warnings: [null, "Check source"] } },
      }).lines,
    ).toEqual(["Useful finding", "Warning: Check source"]);
    expect(
      buildArtifactPreview({ id: "malformed-report", data: { report: ["not an object"] } }).lines,
    ).toEqual(["Metadata artifact."]);
  });
});
