import { describe, expect, it } from "vitest";

import { buildReadinessReport, validateReadinessReport } from "./control-plane";

const snapshot = {
  summary: "Bounded repository snapshot captured.",
  packageManager: "pnpm",
  scripts: ["test", "build"],
  repoFiles: ["package.json", "src/index.ts"],
  docs: ["README.md"],
  configFiles: ["tsconfig.json"],
  signals: [],
  commandMetrics: [{ name: "build", status: "failed" }],
  timingMs: 12,
};

describe("Repository Analyst outcome gate", () => {
  it("accepts a bounded report with explicit warning and limitations", () => {
    const report = buildReadinessReport(snapshot);

    expect(report.status).toBe("review");
    expect(validateReadinessReport(report)).toEqual([]);
  });

  it("rejects misleading or empty outcomes", () => {
    const report = buildReadinessReport(snapshot);
    expect(
      validateReadinessReport({
        ...report,
        status: "ready",
        summary: "",
        limitations: ["This proves the deployed service is healthy."],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("summary"),
        expect.stringContaining("status"),
        expect.stringContaining("limitation"),
      ]),
    );
  });
});
