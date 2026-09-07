import { expect, test, type Page } from "@playwright/test";

import { activateRepositoryAnalyst, openAdminAgentsPanel } from "./workbench-helpers";

const releaseMode = process.env.E2E_RELEASE_MODE;
const workerOrigin = "http://127.0.0.1:8788";

type Trigger = {
  id: string;
  packTriggerId: string;
  status: string;
  version: number;
  publicId?: string;
  nextTriggerAt?: string;
};

type Dispatch = {
  id: string;
  triggerId: string;
  source: string;
  status: string;
  attemptCount: number;
  runId?: string;
  previousRunId?: string;
};

const listDispatches = async (page: Page, triggerId?: string) => {
  const query = triggerId ? `?triggerId=${encodeURIComponent(triggerId)}&limit=100` : "?limit=100";
  const response = await page.request.get(`/api/workbench/trigger-dispatches${query}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { dispatches?: Dispatch[] }).dispatches ?? [];
};

test.describe.serial("Level 3 executable conformance", () => {
  test.skip(releaseMode !== "local-session");
  test.setTimeout(150_000);

  test("scheduled and webhook monitors are idempotent, cancellable, replayable, and tenant isolated", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "What are we working on?" })).toBeVisible();
    const quiesceSeededApproval = await page.request.post(
      "/api/workbench/tools/approvals/e2e-approval/deny",
    );
    expect(quiesceSeededApproval.ok(), await quiesceSeededApproval.text()).toBe(true);
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

    const scheduleCreate = await page.request.post("/api/workbench/triggers", {
      data: {
        packId: "repo-analyst",
        packTriggerId: "scheduled-readiness",
        status: "enabled",
      },
    });
    expect(scheduleCreate.status()).toBe(201);
    const schedule = ((await scheduleCreate.json()) as { trigger?: Trigger }).trigger!;
    expect(schedule.packTriggerId).toBe("scheduled-readiness");
    expect(schedule.nextTriggerAt).toBeTruthy();

    // Exercise cancellation while the runner is active, not while Next compiles
    // these routes for the first time. The fixed runner delay is intentionally short.
    await listDispatches(page, schedule.id);
    const missingRun = await page.request.post(
      "/api/workbench/history/runs/level3-missing-run/cancel",
    );
    expect(missingRun.status()).toBe(404);

    const manualReceipt = await page.request.post(
      `/api/workbench/triggers/${encodeURIComponent(schedule.id)}/dispatches`,
      { data: { idempotencyKey: "level3-cancel-replay", payload: {} } },
    );
    expect(manualReceipt.status()).toBe(201);
    const manualDispatch = ((await manualReceipt.json()) as { dispatch?: Dispatch }).dispatch!;

    let runningDispatch: Dispatch | undefined;
    await expect
      .poll(async () => {
        runningDispatch = (await listDispatches(page, schedule.id)).find(
          (dispatch) => dispatch.id === manualDispatch.id,
        );
        return runningDispatch?.status;
      })
      .toBe("running");
    expect(runningDispatch?.runId).toBeTruthy();

    const cancelledRunId = runningDispatch!.runId!;
    const cancel = await page.request.post(
      `/api/workbench/history/runs/${encodeURIComponent(cancelledRunId)}/cancel`,
    );
    expect(cancel.ok(), await cancel.text()).toBe(true);
    await expect
      .poll(
        async () =>
          (await listDispatches(page, schedule.id)).find(
            (dispatch) => dispatch.id === manualDispatch.id,
          )?.status,
      )
      .toBe("cancelled");

    const replay = await page.request.post(
      `/api/workbench/trigger-dispatches/${encodeURIComponent(manualDispatch.id)}/replay`,
    );
    expect(replay.ok()).toBe(true);
    await expect
      .poll(
        async () => {
          const dispatch = (await listDispatches(page, schedule.id)).find(
            (candidate) => candidate.id === manualDispatch.id,
          );
          return dispatch?.status === "completed" ? dispatch : undefined;
        },
        { timeout: 30_000 },
      )
      .toMatchObject({
        attemptCount: 2,
        previousRunId: cancelledRunId,
      });
    const replayedDispatch = (await listDispatches(page, schedule.id)).find(
      (candidate) => candidate.id === manualDispatch.id,
    )!;
    expect(replayedDispatch.runId).not.toBe(cancelledRunId);
    const replayedRun = await page.request.get(
      `/api/workbench/history/runs/${encodeURIComponent(replayedDispatch.runId!)}`,
    );
    const replayedSnapshot = (await replayedRun.json()) as {
      snapshot?: { run?: { data?: Record<string, unknown> }; artifacts?: unknown[] };
    };
    expect(replayedSnapshot.snapshot?.run?.data?.retryOfRunId).toBe(cancelledRunId);
    expect(replayedSnapshot.snapshot?.artifacts?.length).toBeGreaterThan(0);

    const managedStateResponse = await page.request.get(
      "/api/workbench/managed-state?namespace=repo-monitor&type=repository-readiness",
    );
    expect(managedStateResponse.ok()).toBe(true);
    const managedState = (await managedStateResponse.json()) as {
      states?: Array<{ status?: string; data?: Record<string, unknown> }>;
    };
    expect(managedState.states?.[0]?.status).toBe("ready");
    expect(managedState.states?.[0]?.data?.runId).toBe(replayedDispatch.runId);

    const scheduledAt = Date.parse(schedule.nextTriggerAt!) + 1_000;
    const scheduledTick = await request.get(
      `${workerOrigin}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&time=${scheduledAt}&format=json`,
    );
    expect(scheduledTick.ok()).toBe(true);
    await expect
      .poll(
        async () =>
          (await listDispatches(page, schedule.id)).find(
            (dispatch) => dispatch.source === "schedule" && dispatch.status === "completed",
          )?.id,
        { timeout: 30_000 },
      )
      .toBeTruthy();

    const webhookCreate = await page.request.post("/api/workbench/triggers", {
      data: {
        packId: "repo-analyst",
        packTriggerId: "readiness-requested",
        status: "enabled",
      },
    });
    expect(webhookCreate.status()).toBe(201);
    const webhookBody = (await webhookCreate.json()) as {
      trigger?: Trigger;
      webhookSecret?: string;
    };
    expect(webhookBody.trigger?.publicId).toBeTruthy();
    expect(webhookBody.webhookSecret).toBeTruthy();
    const webhookPath = `/api/external-signals/${encodeURIComponent(webhookBody.trigger!.publicId!)}`;
    const webhookHeaders = {
      authorization: `Bearer ${webhookBody.webhookSecret}`,
      "idempotency-key": "level3-webhook-delivery",
    };
    const webhook = await page.request.post(webhookPath, {
      headers: webhookHeaders,
      data: { includeDocs: true, includeScripts: true, includeConfig: true },
    });
    expect(webhook.status()).toBe(202);
    const webhookReceipt = (await webhook.json()) as { dispatchId?: string };
    const duplicateWebhook = await page.request.post(webhookPath, {
      headers: webhookHeaders,
      data: { includeDocs: true, includeScripts: true, includeConfig: true },
    });
    expect(duplicateWebhook.status()).toBe(200);
    expect(await duplicateWebhook.json()).toMatchObject({
      duplicate: true,
      dispatchId: webhookReceipt.dispatchId,
    });
    await expect
      .poll(
        async () =>
          (await listDispatches(page, webhookBody.trigger!.id)).find(
            (dispatch) => dispatch.id === webhookReceipt.dispatchId,
          )?.status,
        { timeout: 30_000 },
      )
      .toBe("completed");

    await openAdminAgentsPanel(page);
    await page.locator("summary").filter({ hasText: "Automations" }).click();
    await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();
    await expect(page.getByText("scheduled-readiness", { exact: true })).toBeVisible();
    await expect(page.getByText("readiness-requested", { exact: true })).toBeVisible();
    await expect(page.getByText("Recent dispatches", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Operator alerts" })).toBeVisible();
    const operatorAlert = page.locator(
      '[data-testid="operator-alert-row"][data-alert-id="e2e-operator-alert"]',
    );
    await expect(operatorAlert).toContainText("level3_soak_fixture");
    await expect(operatorAlert).toContainText("failed");
    await operatorAlert.getByRole("button", { name: "Retry delivery" }).click();
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/workbench/operator-alerts?limit=25");
        const body = (await response.json()) as {
          alerts?: Array<{ id: string; deliveryStatus: string; deliveryAttempts: number }>;
        };
        return body.alerts?.find((alert) => alert.id === "e2e-operator-alert");
      })
      .toMatchObject({ deliveryStatus: "pending", deliveryAttempts: 0 });
    await operatorAlert.getByRole("button", { name: "Resolve" }).click();
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/workbench/operator-alerts?limit=25");
        const body = (await response.json()) as {
          alerts?: Array<{ id: string; status: string }>;
        };
        return body.alerts?.find((alert) => alert.id === "e2e-operator-alert")?.status;
      })
      .toBe("resolved");

    const artifactContent = "Level 3 retained artifact service-boundary evidence.";
    const createArtifact = await page.request.post("/api/workbench/artifacts", {
      data: {
        kind: "level3_conformance_report",
        title: "Level 3 retained artifact",
        mimeType: "text/plain",
        contentBase64: Buffer.from(artifactContent).toString("base64"),
        data: { testId: "level3-artifact-lifecycle" },
      },
    });
    expect(createArtifact.status()).toBe(201);
    const createdArtifact = (await createArtifact.json()) as {
      artifact?: { id: string; contentSha256: string; retentionClass: string };
    };
    expect(createdArtifact.artifact).toMatchObject({
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      retentionClass: "standard",
    });
    const artifactId = createdArtifact.artifact!.id;
    const artifactRead = await page.request.get(
      `/api/workbench/artifacts/${encodeURIComponent(artifactId)}/content`,
    );
    expect(artifactRead.ok()).toBe(true);
    expect(await artifactRead.text()).toBe(artifactContent);

    const artifactHistory = await page.request.get("/api/workbench/history/artifacts?limit=25");
    expect(artifactHistory.ok()).toBe(true);
    expect(await artifactHistory.json()).toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          id: artifactId,
          storageProvider: "r2",
          contentSha256: createdArtifact.artifact!.contentSha256,
          retentionClass: "standard",
          expiresAt: expect.any(String),
        }),
      ]),
    });

    const exportCreated = await page.request.post("/api/workbench/data-exports");
    expect(exportCreated.status(), await exportCreated.text()).toBe(202);
    const exportCreatedBody = (await exportCreated.json()) as { job: { id: string } };
    await expect
      .poll(
        async () => {
          const exportTick = await request.get(
            `${workerOrigin}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&time=${Date.now()}&format=json`,
          );
          if (!exportTick.ok()) return `cron:${exportTick.status()}`;
          const status = await page.request.get(
            `/api/workbench/data-exports/${encodeURIComponent(exportCreatedBody.job.id)}`,
          );
          if (!status.ok()) return `http:${status.status()}`;
          const body = (await status.json()) as { job?: { status?: string } };
          return body.job?.status;
        },
        { timeout: 15_000 },
      )
      .toBe("completed");
    const workspaceExport = await page.request.get(
      `/api/workbench/data-exports/${encodeURIComponent(exportCreatedBody.job.id)}/download`,
    );
    expect(workspaceExport.ok()).toBe(true);
    expect(workspaceExport.headers()["cache-control"]).toBe("private, no-store");
    const workspaceExportBytes = await workspaceExport.body();
    expect(workspaceExportBytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(workspaceExportBytes.includes(Buffer.from(artifactId))).toBe(true);

    const retentionPolicy = await page.request.patch("/api/workbench/retention-policy", {
      data: {
        artifactRetentionDays: 1,
        operationalEventRetentionDays: 30,
        runtimeTraceRetentionDays: 14,
      },
    });
    expect(retentionPolicy.ok()).toBe(true);
    const retentionTick = await request.get(
      `${workerOrigin}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&time=${Date.now() + 2 * 24 * 60 * 60 * 1000}&format=json`,
    );
    expect(retentionTick.ok()).toBe(true);
    await expect
      .poll(
        async () =>
          (
            await page.request.get(
              `/api/workbench/artifacts/${encodeURIComponent(artifactId)}/content`,
            )
          ).status(),
        { timeout: 10_000 },
      )
      .toBe(404);

    const otherHeaders = {
      authorization: "Bearer e2e-control-plane-token",
      "x-assistant-mk1-user-id": "level3-tenant-b-user",
      "x-assistant-mk1-workspace-id": "level3-tenant-b-workspace",
      "x-assistant-mk1-agent-id": "level3-tenant-b-agent",
      "x-assistant-mk1-account-id": "local-dev:level3-tenant-b-workspace",
      "x-assistant-mk1-account-source": "local-dev",
    };
    expect(
      (
        await request.get(`${workerOrigin}/triggers/${encodeURIComponent(schedule.id)}`, {
          headers: otherHeaders,
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await request.get(
          `${workerOrigin}/trigger-dispatches/${encodeURIComponent(manualDispatch.id)}`,
          { headers: otherHeaders },
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await request.patch(`${workerOrigin}/admin/operator-alerts/e2e-operator-alert`, {
          headers: otherHeaders,
          data: { status: "resolved" },
        })
      ).status(),
    ).toBe(404);
  });
});
