import { describe, expect, it } from "vitest";

import {
  buildPackWorkflowRequest,
  fieldDefinitionsForPackWorkflow,
  packWorkflowBindings,
  resolvePackWorkflowBinding,
} from "./pack-workflow-bindings";
import { resolvePackRuntime, resolveRuntimeCompatibility } from "../agent-runtime/registry";
import { agentControlPlaneRegistry } from "../../generated/agent-runtime/control-plane";
import { agentManifestRegistry } from "../../generated/agent-runtime/manifests";

describe("pack workflow bindings", () => {
  it("keeps incompatible historical snapshots chat-only", () => {
    expect(resolvePackRuntime("repo-analyst", "1.2.0")).toMatchObject({
      runnable: true,
      runtimeVersion: "1.1.0",
    });
    expect(resolvePackRuntime("repo-analyst", "2.0.0")).toMatchObject({
      runnable: false,
      reason: "runtime_incompatible",
    });
  });
  it("fails stale generated snapshots closed when the workbench is incompatible", () => {
    const manifest = agentManifestRegistry["repo-analyst"].module;
    const controlPlane = agentControlPlaneRegistry["repo-analyst"].module;
    expect(
      resolveRuntimeCompatibility({
        workbenchVersion: "0.5.0",
        packVersion: manifest.version,
        manifest: {
          compatibility: {
            ...manifest.compatibility,
            minimumWorkbenchVersion: "0.6.0",
          },
        },
        controlPlane,
      }),
    ).toMatchObject({ runnable: false, reason: "workbench_incompatible" });
  });
  it("returns a runnable binding for Polymancer and keeps Swordfish parked", () => {
    expect(
      resolvePackWorkflowBinding({
        type: "polymancer.market_research",
        engine: "langgraph",
        status: "declared",
        description: "Market research",
      }),
    ).toMatchObject({
      runnable: true,
      binding: {
        route: "/api/workbench/workflows/polymancer.market_research",
        requiredPackId: "baby-polymancer",
      },
    });

    expect(
      resolvePackWorkflowBinding({
        type: "swordfish.runtime_research",
        engine: "langgraph",
        status: "declared",
        description: "Runtime research",
      }),
    ).toMatchObject({ runnable: false, reason: "declared_only" });
    expect(resolvePackRuntime("baby-swordfish", "1.1.0")).toMatchObject({
      runnable: false,
      reason: "runtime_incompatible",
    });
  });

  it("reports unknown workflows as declared-only", () => {
    expect(
      resolvePackWorkflowBinding({
        type: "example.future_workflow",
        engine: "langgraph",
        status: "declared",
        description: "Future workflow",
      }),
    ).toEqual({
      runnable: false,
      workflow: {
        type: "example.future_workflow",
        engine: "langgraph",
        status: "declared",
        description: "Future workflow",
      },
      reason: "declared_only",
    });
  });

  it("builds bounded dry-run Polymancer requests", () => {
    expect(
      buildPackWorkflowRequest("polymancer.market_research", {
        query: "  GTA markets  ",
        url: "https://example.com",
        token: "secret",
      }),
    ).toEqual({
      executionMode: "dry_run",
      input: { query: "GTA markets" },
    });

    expect(buildPackWorkflowRequest("polymancer.market_research", {})).toEqual({
      executionMode: "dry_run",
      input: { query: "Bitcoin" },
    });
  });

  it("keeps required pack ids explicit", () => {
    expect(packWorkflowBindings["polymancer.market_research"].requiredPackId).toBe(
      "baby-polymancer",
    );
  });

  it("describes workflow fields for the operator run dialog", () => {
    expect(
      fieldDefinitionsForPackWorkflow(packWorkflowBindings["polymancer.market_research"]),
    ).toEqual([
      expect.objectContaining({
        name: "query",
        kind: "text",
        label: "Market query",
      }),
    ]);
  });
});
