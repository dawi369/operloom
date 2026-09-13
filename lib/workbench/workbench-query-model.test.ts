import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  clearAllWorkbenchTenantCaches,
  createWorkbenchQueryClient,
  workbenchQueryKeys,
  workbenchSessionEventInvalidations,
} from "../../packages/workbench-react/src/index";
import { preloadWorkbenchSurface } from "./surface-preloading";

describe("workbench query model", () => {
  it("keeps tenant and parameterized resources distinct", () => {
    expect(workbenchQueryKeys.runs("workspace:a", 20)).not.toEqual(
      workbenchQueryKeys.runs("workspace:b", 20),
    );
    expect(workbenchQueryKeys.runs("workspace:a", 20)).not.toEqual(
      workbenchQueryKeys.runs("workspace:a", 50),
    );
    expect(workbenchQueryKeys.threads("workspace:a", "active")).not.toEqual(
      workbenchQueryKeys.threads("workspace:a", "archived"),
    );
  });

  it("clears every tenant cache without removing account context", () => {
    const client = createWorkbenchQueryClient();
    client.setQueryData(workbenchQueryKeys.accounts, { accounts: [] });
    client.setQueryData(workbenchQueryKeys.session("workspace:a"), { workspace: { id: "a" } });
    client.setQueryData(workbenchQueryKeys.runs("workspace:b"), { runs: [] });

    clearAllWorkbenchTenantCaches(client);

    expect(client.getQueryData(workbenchQueryKeys.accounts)).toBeDefined();
    expect(client.getQueryData(workbenchQueryKeys.session("workspace:a"))).toBeUndefined();
    expect(client.getQueryData(workbenchQueryKeys.runs("workspace:b"))).toBeUndefined();
  });

  it("maps realtime events onto the shared resource keys", () => {
    expect(workbenchSessionEventInvalidations({ type: "approval.updated" }, "workspace:a")).toEqual(
      [
        workbenchQueryKeys.approvals("workspace:a"),
        workbenchQueryKeys.runLists("workspace:a"),
        workbenchQueryKeys.runDetails("workspace:a"),
        workbenchQueryKeys.actionLists("workspace:a"),
      ],
    );
    expect(
      workbenchSessionEventInvalidations({ type: "session.agent.handoff" }, "workspace:a"),
    ).toContainEqual(workbenchQueryKeys.connections("workspace:a"));
  });

  it("keeps designated product surfaces off direct client calls", () => {
    for (const file of [
      "components/workbench/workbench-history-panel.tsx",
      "components/workbench/workbench-capabilities-panel.tsx",
      "components/workbench/workbench-agents-panel.tsx",
      "components/workbench/workbench-workspace-panel.tsx",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, file).not.toContain("browserWorkbenchClient");
    }
  });

  it("warms list data once while leaving heavy run details demand-loaded", async () => {
    const queryClient = createWorkbenchQueryClient();
    const client = {
      agents: { list: vi.fn().mockResolvedValue({ agents: [] }) },
      history: {
        listRuns: vi.fn().mockResolvedValue({ runs: [] }),
        listArtifacts: vi.fn().mockResolvedValue({ artifacts: [] }),
        getRun: vi.fn(),
      },
      actions: { list: vi.fn().mockResolvedValue({ proposals: [] }) },
    };

    await preloadWorkbenchSurface({
      surface: "history",
      client: client as never,
      queryClient,
      workspaceId: "workspace:a",
    });
    await preloadWorkbenchSurface({
      surface: "history",
      client: client as never,
      queryClient,
      workspaceId: "workspace:a",
    });

    expect(client.history.listRuns).toHaveBeenCalledTimes(1);
    expect(client.history.listArtifacts).toHaveBeenCalledTimes(1);
    expect(client.actions.list).toHaveBeenCalledTimes(1);
    expect(client.history.getRun).not.toHaveBeenCalled();
  });
});
