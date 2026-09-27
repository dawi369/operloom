import { expect, test, type Page } from "./fixtures";

import { activateRepositoryAnalyst } from "./workbench-helpers";
import { e2eOwner, workerApi, workerOrigin } from "./worker-api";

const releaseMode = process.env.E2E_RELEASE_MODE;

type HistoryRun = {
  id: string;
  status: string;
  displayName?: string;
  data?: Record<string, unknown>;
};

const historyRuns = async (page: Page) => {
  const response = await page.request.get("/api/workbench/history/runs");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { runs?: HistoryRun[] }).runs ?? [];
};

test.describe.serial("Level 2 executable conformance", () => {
  test.skip(releaseMode !== "local-session");
  test.setTimeout(90_000);

  test("approval recovery, cancellation, retry, handoff, and tenant isolation", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "What are we working on?" })).toBeVisible();

    await page.getByRole("button", { name: "Workspace access" }).click();
    const workspaceDialog = page.getByRole("dialog", { name: "Workspace" });
    await expect(workspaceDialog.getByText("Default Workspace", { exact: true })).toBeVisible();
    const owner = workerApi(request);
    const ownerMembersResponse = await owner.get(
      `/workspaces/${encodeURIComponent(owner.workspaceId)}/members`,
    );
    expect(ownerMembersResponse.ok()).toBe(true);
    const ownerMembers = (await ownerMembersResponse.json()) as {
      members?: Array<{ userId?: string; role?: string; status?: string }>;
    };
    expect(ownerMembers.members).toContainEqual(
      expect.objectContaining({ userId: e2eOwner, role: "owner", status: "active" }),
    );
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "History" }).click();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Approval recovery fixture" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
    await page.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByText("cancelled", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Deny" })).toHaveCount(0);
    await page.getByRole("button", { name: "Close" }).click();

    await activateRepositoryAnalyst(page);
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/workbench/agents");
        const body = (await response.json()) as {
          activeAgentId?: string;
          agents?: Array<{ id: string; name?: string }>;
        };
        return body.agents?.find((agent) => agent.id === body.activeAgentId)?.name;
      })
      .toBe("Repository Analyst");

    const approvalPolicyResponse = await page.request.post("/api/workbench/tools/policy", {
      data: { toolName: "repo.snapshot", requiresApproval: true },
    });
    expect(approvalPolicyResponse.ok()).toBe(true);

    const interruptedToolResponse = await page.request.post("/api/workbench/tools/runs", {
      data: { toolName: "repo.snapshot", executionMode: "dry_run", input: {} },
    });
    expect(interruptedToolResponse.status()).toBe(403);

    const approvalsResponse = await page.request.get(
      "/api/workbench/tools/approvals?status=requested",
    );
    expect(approvalsResponse.ok()).toBe(true);
    const approvals = (await approvalsResponse.json()) as {
      approvals?: Array<{ id?: string; toolId?: string; status?: string }>;
    };
    const repoApproval = approvals.approvals?.find(
      (approval) => approval.toolId === "repo.snapshot" && approval.status === "requested",
    );
    expect(repoApproval?.id).toBeTruthy();

    const approveResponse = await page.request.post(
      `/api/workbench/tools/approvals/${encodeURIComponent(repoApproval!.id!)}/approve`,
    );
    expect(approveResponse.ok()).toBe(true);
    const approved = (await approveResponse.json()) as {
      run?: { status?: string };
      approvalRequest?: { status?: string };
      artifact?: { id?: string } | null;
    };
    expect(approved.run?.status).toBe("completed");
    expect(approved.approvalRequest?.status).toBe("approved");
    expect(approved.artifact?.id).toBeTruthy();

    const resetApprovalPolicyResponse = await page.request.post("/api/workbench/tools/policy", {
      data: { toolName: "repo.snapshot", requiresApproval: false },
    });
    expect(resetApprovalPolicyResponse.ok()).toBe(true);

    // Compile the observation/cancellation routes before starting the short
    // fixture run; this checks cancellation authority, not compiler latency.
    await historyRuns(page);
    const warmCancel = await page.request.post(
      "/api/workbench/history/runs/nonexistent-cancellation-prewarm/cancel",
    );
    expect(warmCancel.status(), await warmCancel.text()).toBe(404);

    await page.evaluate(() => {
      (window as typeof window & { level2Run?: Promise<unknown> }).level2Run = fetch(
        "/api/workbench/workflows/repo.readiness_report",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            executionMode: "dry_run",
            input: { includeDocs: true, includeScripts: true, includeConfig: true },
          }),
        },
      ).then(async (response) => ({ status: response.status, body: await response.json() }));
    });

    let activeRun: HistoryRun | undefined;
    await expect
      .poll(async () => {
        activeRun = (await historyRuns(page)).find(
          (run) => run.displayName === "Repository readiness report" && run.status === "running",
        );
        return activeRun?.id;
      })
      .toBeTruthy();

    const cancelledRunId = activeRun!.id;
    const cancelResponse = await page.request.post(
      `/api/workbench/history/runs/${encodeURIComponent(cancelledRunId)}/cancel`,
    );
    expect(cancelResponse.ok(), await cancelResponse.text()).toBe(true);
    await page.waitForTimeout(2_000);

    const cancelledSnapshotResponse = await page.request.get(
      `/api/workbench/history/runs/${encodeURIComponent(cancelledRunId)}`,
    );
    expect(cancelledSnapshotResponse.ok()).toBe(true);
    const cancelledSnapshot = (await cancelledSnapshotResponse.json()) as {
      snapshot?: { run?: { status?: string }; artifacts?: unknown[] };
    };
    expect(cancelledSnapshot.snapshot?.run?.status).toBe("cancelled");
    expect(cancelledSnapshot.snapshot?.artifacts ?? []).toEqual([]);

    const retryResponse = await page.request.post(
      `/api/workbench/history/runs/${encodeURIComponent(cancelledRunId)}/retry`,
    );
    expect(retryResponse.ok()).toBe(true);
    const retried = (await retryResponse.json()) as { run?: { id?: string; runId?: string } };
    const retriedRunId = retried.run?.id ?? retried.run?.runId;
    expect(retriedRunId).toBeTruthy();
    expect(retriedRunId).not.toBe(cancelledRunId);

    const retriedSnapshotResponse = await page.request.get(
      `/api/workbench/history/runs/${encodeURIComponent(retriedRunId!)}`,
    );
    const retriedSnapshot = (await retriedSnapshotResponse.json()) as {
      snapshot?: {
        run?: { status?: string; data?: Record<string, unknown> };
        artifacts?: unknown[];
      };
    };
    expect(retriedSnapshot.snapshot?.run?.status).toBe("completed");
    expect(retriedSnapshot.snapshot?.run?.data?.retryOfRunId).toBe(cancelledRunId);
    expect(retriedSnapshot.snapshot?.artifacts?.length).toBeGreaterThan(0);

    const sessionResponse = await page.request.post("/api/workbench/chat-session/threads", {
      data: { title: "Level 2 handoff fixture" },
    });
    expect(sessionResponse.ok()).toBe(true);
    const session = (await sessionResponse.json()) as {
      activeThread?: { threadId?: string; agentId?: string };
      connection?: { token?: string; instanceName?: string; agentId?: string; threadId?: string };
    };
    const agentsResponse = await page.request.get("/api/workbench/agents");
    const agents = (await agentsResponse.json()) as { agents?: Array<{ id: string }> };
    const targetAgent = agents.agents?.find((agent) => agent.id !== session.connection?.agentId);
    expect(session.connection?.threadId).toBeTruthy();
    expect(session.connection?.token).toBeTruthy();
    expect(targetAgent?.id).toBeTruthy();

    const switchResponse = await page.request.post("/api/workbench/chat-session/agent-switch", {
      data: {
        agentId: targetAgent!.id,
        target: "current_thread",
        threadId: session.connection!.threadId,
      },
    });
    expect(switchResponse.ok()).toBe(true);
    const switched = (await switchResponse.json()) as {
      activeThread?: { agentId?: string };
      transition?: { type?: string };
    };
    expect(switched.transition?.type).toBe("agent_handoff");
    expect(switched.activeThread?.agentId).toBe(targetAgent!.id);

    const staleTokenResponse = await request.get(
      `${workerOrigin}/agents/workbench-thread-chat-agent/${encodeURIComponent(session.connection!.instanceName ?? "")}?token=${encodeURIComponent(session.connection!.token ?? "")}`,
    );
    expect(staleTokenResponse.status()).toBe(403);

    const other = workerApi(request, { userId: "tenant-b-user" });
    const bootstrapOther = await other.account();
    expect(bootstrapOther.ok()).toBe(true);
    for (const operation of [
      () => other.get(`/workbench/history/runs/${retriedRunId}`),
      () => other.post(`/workbench/history/runs/${retriedRunId}/cancel`),
      () => other.post(`/workbench/history/runs/${retriedRunId}/retry`),
    ]) {
      expect((await operation()).status()).toBe(404);
    }
    const otherArtifacts = await other.get("/workbench/history/artifacts");
    expect(otherArtifacts.ok()).toBe(true);
    expect(JSON.stringify(await otherArtifacts.json())).not.toContain(retriedRunId);

    const stagedResponse = await page.request.post(
      "/api/workbench/chat-session/stage-thread?source=level2-conformance",
    );
    expect(stagedResponse.ok()).toBe(true);
    const staged = (await stagedResponse.json()) as {
      activeThread?: { status?: string };
      connection?: { token?: string; instanceName?: string };
    };
    expect(staged.activeThread?.status).toBe("draft");
    expect(staged.connection?.token).toBeTruthy();
    expect(staged.connection?.instanceName).toBeTruthy();

    const stagedAgentResponse = await request.get(
      `${workerOrigin}/agents/workbench-thread-chat-agent/${encodeURIComponent(staged.connection!.instanceName!)}/get-messages?token=${encodeURIComponent(staged.connection!.token!)}`,
    );
    expect(stagedAgentResponse.status()).toBe(200);
  });
});
