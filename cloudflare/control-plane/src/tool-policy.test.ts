import { describe, expect, it } from "vitest";

import {
  artifactMetadataTestPolicy,
  artifactMetadataTestToolName,
  diagnosticPingPolicy,
  diagnosticPingToolName,
  runnerEchoPolicy,
  runnerEchoToolName,
  toolPolicyCatalog,
} from "./tool-policy";

const repoSnapshotToolName = "repo.snapshot";
const repoSnapshotPolicy = "repo-snapshot-readonly-v0";
const polymarketMarketSearchToolName = "polymarket.market.search";
const polymarketReadonlyPolicy = "polymarket-readonly-v0";

describe("tool policy catalog", () => {
  it("registers repo.snapshot as admin-visible and model-hidden by default", () => {
    expect(toolPolicyCatalog[repoSnapshotToolName]).toMatchObject({
      policyReference: repoSnapshotPolicy,
      allowedExecutionModes: ["dry_run"],
      adminVisible: true,
      modelVisible: false,
      requiresApproval: false,
      status: "enabled",
      policyEditable: true,
      mutationRisk: "read_only",
    });
  });

  it("registers Admin conformance tools as dry-run-only and non-policy-editable", () => {
    expect(toolPolicyCatalog[diagnosticPingToolName]).toMatchObject({
      policyReference: diagnosticPingPolicy,
      allowedExecutionModes: ["dry_run"],
      adminVisible: true,
      modelVisible: false,
      requiresApproval: false,
      status: "enabled",
      policyEditable: false,
      mutationRisk: "read_only",
    });
    expect(toolPolicyCatalog[runnerEchoToolName]).toMatchObject({
      policyReference: runnerEchoPolicy,
      allowedExecutionModes: ["dry_run"],
      adminVisible: true,
      modelVisible: false,
      requiresApproval: false,
      status: "enabled",
      policyEditable: false,
      mutationRisk: "read_only",
    });
    expect(toolPolicyCatalog[artifactMetadataTestToolName]).toMatchObject({
      policyReference: artifactMetadataTestPolicy,
      allowedExecutionModes: ["dry_run"],
      adminVisible: true,
      modelVisible: false,
      requiresApproval: false,
      status: "enabled",
      policyEditable: false,
      mutationRisk: "read_only",
    });
  });

  it("registers Polymarket readonly tools as admin-visible and model-hidden", () => {
    expect(toolPolicyCatalog[polymarketMarketSearchToolName]).toMatchObject({
      policyReference: polymarketReadonlyPolicy,
      allowedExecutionModes: ["dry_run"],
      adminVisible: true,
      modelVisible: false,
      requiresApproval: false,
      status: "enabled",
      policyEditable: true,
      mutationRisk: "read_only",
    });
  });

  it("keeps mutation authority isolated to explicitly approved action bindings", () => {
    const mutationTools = new Set([
      "operator.action.execute",
      "capacity.allocate",
      "capacity.allocate-signed",
      "resource-allocator.allocate",
    ]);
    for (const [toolName, policy] of Object.entries(toolPolicyCatalog)) {
      if (mutationTools.has(toolName)) {
        expect(policy.mutationRisk).toBe("mutation_capable");
        expect(policy.allowedExecutionModes).toEqual(["dry_run", "execute"]);
        expect(policy.requiresApproval).toBe(true);
      } else {
        expect(policy.mutationRisk, toolName).toBe("read_only");
        expect(policy.allowedExecutionModes, toolName).toEqual(["dry_run"]);
      }
    }
  });
});
