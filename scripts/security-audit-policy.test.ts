import { describe, expect, it } from "vitest";

import { evaluateSecurityAudit } from "./security-audit-policy";

const expoPath = "apps__mobile>expo>@expo/metro>metro>image-size";

function advisory(overrides: Record<string, unknown> = {}) {
  return {
    severity: "high",
    module_name: "image-size",
    github_advisory_id: "GHSA-w3rx-r6r6-pgpr",
    patched_versions: "<0.0.0",
    findings: [{ paths: [expoPath] }],
    ...overrides,
  };
}

describe("security audit policy", () => {
  it("blocks the former Expo exceptions now that mobile is deferred", () => {
    const decision = evaluateSecurityAudit({
      advisories: {
        one: advisory(),
        two: advisory({ github_advisory_id: "GHSA-5p2g-fcmc-qvqq" }),
      },
    });

    expect(decision.allowed).toEqual([]);
    expect(decision.blocked.map((item) => item.githubAdvisoryId)).toEqual([
      "GHSA-w3rx-r6r6-pgpr",
      "GHSA-5p2g-fcmc-qvqq",
    ]);
  });

  it("blocks an allowlisted advisory when it reaches another dependency path", () => {
    const decision = evaluateSecurityAudit({
      advisories: {
        one: advisory({ findings: [{ paths: [expoPath, ".>image-size"] }] }),
      },
    });

    expect(decision.blocked).toHaveLength(1);
    expect(decision.allowed).toEqual([]);
  });

  it("blocks patched, unknown, and critical advisories", () => {
    const decision = evaluateSecurityAudit({
      advisories: {
        patched: advisory({ patched_versions: ">=1.2.2" }),
        unknown: advisory({ github_advisory_id: "GHSA-unknown" }),
        critical: advisory({ severity: "critical", module_name: "other" }),
      },
    });

    expect(decision.blocked).toHaveLength(3);
    expect(decision.allowed).toEqual([]);
  });

  it("accepts only explicitly verified local remediation", () => {
    const extractZip = advisory({
      module_name: "extract-zip",
      github_advisory_id: "GHSA-jmr9-qjv8-65gv",
      findings: [{ paths: [".>@langchain/langgraph-cli>extract-zip"] }],
    });
    expect(evaluateSecurityAudit({ advisories: { extractZip } }).blocked).toHaveLength(1);
    expect(
      evaluateSecurityAudit(
        { advisories: { extractZip } },
        { locallyRemediatedAdvisories: new Set(["GHSA-jmr9-qjv8-65gv"]) },
      ).blocked,
    ).toEqual([]);
  });
});
