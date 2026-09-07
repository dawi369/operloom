import { expect, test, type APIRequestContext } from "./fixtures";

const releaseMode = process.env.E2E_RELEASE_MODE;
const workerOrigin = "http://127.0.0.1:8788";

const pollDataJob = async (
  request: APIRequestContext,
  headers: Record<string, string>,
  jobId: string,
) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await request.get(
      `${workerOrigin}/workbench/data-exports/${encodeURIComponent(jobId)}`,
      { headers },
    );
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as {
      job: { status: string; contentSha256?: string; sizeBytes?: number };
    };
    if (body.job.status === "completed") return body.job;
    if (body.job.status === "failed") throw new Error("Data export failed.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Data export did not complete within the bounded polling window.");
};

test.describe.serial("Production customer-data lifecycle", () => {
  test.skip(releaseMode !== "local-session");
  test.setTimeout(60_000);

  test("exports complete tenant state and enforces quarantine recovery", async ({ request }) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const workspaceName = `Lifecycle ${suffix}`;
    const headers = {
      authorization: "Bearer e2e-control-plane-token",
      "x-assistant-mk1-user-id": `lifecycle-owner-${suffix}`,
      "x-assistant-mk1-workspace-id": `lifecycle-workspace-${suffix}`,
      "x-assistant-mk1-agent-id": `lifecycle-agent-${suffix}`,
      "x-assistant-mk1-account-id": `local-dev:lifecycle-workspace-${suffix}`,
      "x-assistant-mk1-account-source": "local-dev",
      "x-assistant-mk1-workspace-name": workspaceName,
    };

    const bootstrap = await request.get(`${workerOrigin}/admin/workspace-summary`, { headers });
    expect(bootstrap.status(), await bootstrap.text()).toBe(200);

    const memberUserId = `lifecycle-member-${suffix}`;
    const memberHeaders = {
      ...headers,
      "x-assistant-mk1-user-id": memberUserId,
      "x-assistant-mk1-agent-id": `lifecycle-member-agent-${suffix}`,
    };
    const memberBootstrap = await request.get(`${workerOrigin}/admin/workspace-summary`, {
      headers: memberHeaders,
    });
    expect(memberBootstrap.status(), await memberBootstrap.text()).toBe(200);

    const instantiated = await request.post(
      `${workerOrigin}/agent-packs/complex-operator/instantiate`,
      { headers },
    );
    expect(instantiated.status(), await instantiated.text()).toBe(201);
    const instantiatedBody = (await instantiated.json()) as { agent: { id: string } };
    const activate = await request.post(
      `${workerOrigin}/agents/${encodeURIComponent(instantiatedBody.agent.id)}/activate`,
      { headers },
    );
    expect(activate.status(), await activate.text()).toBe(200);
    const activeHeaders = {
      ...headers,
      "x-assistant-mk1-agent-id": instantiatedBody.agent.id,
    };

    const threadResponse = await request.post(`${workerOrigin}/chat/session/threads`, {
      headers: activeHeaders,
      data: { title: "Export fence fixture" },
    });
    expect(threadResponse.status(), await threadResponse.text()).toBe(200);
    const thread = (await threadResponse.json()) as {
      connection?: { token?: string; instanceName?: string; threadId?: string; sessionId?: string };
    };
    expect(thread.connection?.token).toBeTruthy();
    expect(thread.connection?.instanceName).toBeTruthy();

    const retention = await request.patch(`${workerOrigin}/workbench/retention-policy`, {
      headers,
      data: {
        chatMessageRetentionDays: 45,
        runPayloadRetentionDays: 60,
        artifactRetentionDays: 75,
        operationalEventRetentionDays: 20,
        runtimeTraceRetentionDays: 10,
        auditActionRetentionDays: 365,
        confirm: true,
      },
    });
    expect(retention.status(), await retention.text()).toBe(200);
    expect(await retention.json()).toMatchObject({
      policy: {
        confirmed: true,
        chatMessageRetentionDays: 45,
        runPayloadRetentionDays: 60,
        artifactRetentionDays: 75,
      },
    });

    const secret = `lifecycle-secret-${suffix}`;
    const connection = await request.post(
      `${workerOrigin}/workbench/connections/operator.external-account/credentials`,
      { headers: activeHeaders, data: { secret } },
    );
    expect(connection.status(), await connection.text()).toBe(201);

    const created = await request.post(`${workerOrigin}/workbench/data-exports`, {
      headers: activeHeaders,
    });
    expect(created.status(), await created.text()).toBe(202);
    const createdBody = (await created.json()) as { job: { id: string } };
    let acceptedRetentionDays = 45;
    let rejectedRetentionDays: number | undefined;
    for (let candidate = 46; candidate < 60; candidate += 1) {
      const concurrentWrite = await request.patch(`${workerOrigin}/workbench/retention-policy`, {
        headers: activeHeaders,
        data: {
          chatMessageRetentionDays: candidate,
          runPayloadRetentionDays: 60,
          artifactRetentionDays: 75,
          operationalEventRetentionDays: 20,
          runtimeTraceRetentionDays: 10,
          auditActionRetentionDays: 365,
          confirm: true,
        },
      });
      if (concurrentWrite.status() === 423) {
        expect(await concurrentWrite.json()).toMatchObject({
          code: "workspace_export_in_progress",
        });
        rejectedRetentionDays = candidate;
        break;
      }
      expect(concurrentWrite.status(), await concurrentWrite.text()).toBe(200);
      acceptedRetentionDays = candidate;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(rejectedRetentionDays).toBeDefined();

    const durableObjectPath = `${workerOrigin}/agents/workbench-thread-chat-agent/${encodeURIComponent(thread.connection!.instanceName!)}`;
    let blockedDurableWriteStatus = 0;
    for (let attempt = 0; attempt < 50 && blockedDurableWriteStatus !== 423; attempt += 1) {
      const blockedDurableWrite = await request.post(
        `${durableObjectPath}/internal/programmatic-submit`,
        {
          data: {
            token: thread.connection!.token,
            threadId: thread.connection!.threadId,
            sessionId: thread.connection!.sessionId,
            message: "This message must not cross the export fence.",
          },
        },
      );
      blockedDurableWriteStatus = blockedDurableWrite.status();
      if (blockedDurableWriteStatus !== 423) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(blockedDurableWriteStatus).toBe(423);
    const readableWhileFrozen = await request.get(
      `${durableObjectPath}/get-messages?token=${encodeURIComponent(thread.connection!.token!)}`,
    );
    expect(readableWhileFrozen.status(), await readableWhileFrozen.text()).toBe(200);

    const completed = await pollDataJob(request, activeHeaders, createdBody.job.id);
    expect(completed.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(completed.sizeBytes).toBeGreaterThan(0);

    const download = await request.get(
      `${workerOrigin}/workbench/data-exports/${encodeURIComponent(createdBody.job.id)}/download`,
      { headers: activeHeaders },
    );
    expect(download.status(), await download.text()).toBe(200);
    expect(download.headers()["content-type"]).toContain("application/zip");
    expect(download.headers()["cache-control"]).toBe("private, no-store");
    const archive = await download.body();
    expect(archive.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(archive.includes(Buffer.from('"version": 3'))).toBe(true);
    expect(archive.includes(Buffer.from('"snapshotAt":'))).toBe(true);
    expect(archive.includes(Buffer.from('"fenceDurationMs":'))).toBe(true);
    expect(
      archive.includes(Buffer.from(`"chat_message_retention_days":${acceptedRetentionDays}`)),
    ).toBe(true);
    expect(
      archive.includes(Buffer.from(`"chat_message_retention_days":${rejectedRetentionDays!}`)),
    ).toBe(false);
    expect(archive.includes(Buffer.from(memberUserId))).toBe(true);
    expect(archive.includes(Buffer.from(secret))).toBe(false);

    const writableAgain = await request.patch(`${workerOrigin}/workbench/retention-policy`, {
      headers: activeHeaders,
      data: {
        chatMessageRetentionDays: rejectedRetentionDays,
        runPayloadRetentionDays: 60,
        artifactRetentionDays: 75,
        operationalEventRetentionDays: 20,
        runtimeTraceRetentionDays: 10,
        auditActionRetentionDays: 365,
        confirm: true,
      },
    });
    expect(writableAgain.status(), await writableAgain.text()).toBe(200);

    const otherHeaders = {
      ...headers,
      "x-assistant-mk1-user-id": `lifecycle-other-owner-${suffix}`,
      "x-assistant-mk1-workspace-id": `lifecycle-other-workspace-${suffix}`,
      "x-assistant-mk1-agent-id": `lifecycle-other-agent-${suffix}`,
      "x-assistant-mk1-account-id": `local-dev:lifecycle-other-workspace-${suffix}`,
      "x-assistant-mk1-workspace-name": `Other ${suffix}`,
    };
    const crossTenant = await request.get(
      `${workerOrigin}/workbench/data-exports/${encodeURIComponent(createdBody.job.id)}`,
      { headers: otherHeaders },
    );
    expect(crossTenant.status()).toBe(404);

    const deletion = await request.post(`${workerOrigin}/workbench/workspace-deletion`, {
      headers: activeHeaders,
      data: { workspaceName, reauthenticatedAt: new Date().toISOString() },
    });
    expect(deletion.status(), await deletion.text()).toBe(202);
    expect(await deletion.json()).toMatchObject({
      deletion: {
        status: "quarantined",
        credentialsRecoverable: false,
        credentialRevocation: "completed",
      },
    });

    const blocked = await request.get(`${workerOrigin}/workbench/actions`, {
      headers: activeHeaders,
    });
    expect(blocked.status()).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: "Workspace is not active" });
    const blockedMember = await request.get(`${workerOrigin}/workbench/actions`, {
      headers: memberHeaders,
    });
    expect(blockedMember.status()).toBe(403);

    const status = await request.get(`${workerOrigin}/workbench/workspace-deletion`, {
      headers: activeHeaders,
    });
    expect(status.status(), await status.text()).toBe(200);
    expect(await status.json()).toMatchObject({ deletion: { status: "quarantined" } });

    const recovered = await request.delete(`${workerOrigin}/workbench/workspace-deletion`, {
      headers: activeHeaders,
    });
    expect(recovered.status(), await recovered.text()).toBe(200);
    expect(await recovered.json()).toMatchObject({
      deletion: {
        status: "recovered",
        credentialsRestored: false,
        triggersRestored: false,
      },
    });

    const restored = await request.get(`${workerOrigin}/workbench/actions`, {
      headers: activeHeaders,
    });
    expect(restored.status(), await restored.text()).toBe(200);
    const connections = await request.get(`${workerOrigin}/workbench/connections`, {
      headers: activeHeaders,
    });
    expect(connections.status(), await connections.text()).toBe(200);
    expect(await connections.json()).toMatchObject({
      connections: expect.arrayContaining([
        expect.objectContaining({ id: "operator.external-account", status: "revoked" }),
      ]),
    });
  });

  test("resumes every persisted export phase after an interrupted invocation", async ({
    request,
  }) => {
    for (const failurePhase of ["after_d1_materialized", "after_r2_pinned", "assembling"]) {
      const suffix = `${failurePhase}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const headers = {
        authorization: "Bearer e2e-control-plane-token",
        "x-assistant-mk1-user-id": `export-resume-owner-${suffix}`,
        "x-assistant-mk1-workspace-id": `export-resume-workspace-${suffix}`,
        "x-assistant-mk1-agent-id": `export-resume-agent-${suffix}`,
        "x-assistant-mk1-account-id": `local-dev:export-resume-workspace-${suffix}`,
        "x-assistant-mk1-account-source": "local-dev",
        "x-assistant-mk1-workspace-name": `Export resume ${suffix}`,
      };
      const bootstrap = await request.get(`${workerOrigin}/admin/workspace-summary`, { headers });
      expect(bootstrap.status(), await bootstrap.text()).toBe(200);

      const created = await request.post(
        `${workerOrigin}/workbench/data-exports?e2eFailPhase=${encodeURIComponent(failurePhase)}`,
        { headers },
      );
      expect(created.status(), await created.text()).toBe(202);
      const createdBody = (await created.json()) as {
        job: { id: string; injectedFailurePhase?: string };
      };
      expect(createdBody.job.injectedFailurePhase).toBe(failurePhase);

      await expect
        .poll(
          async () => {
            const response = await request.get(
              `${workerOrigin}/workbench/data-exports/${encodeURIComponent(createdBody.job.id)}`,
              { headers },
            );
            if (!response.ok()) return "not_ready";
            const body = (await response.json()) as {
              job: { status: string; attemptCount: number; lastErrorCode?: string };
            };
            return `${body.job.status}:${body.job.attemptCount}:${body.job.lastErrorCode ?? ""}`;
          },
          { timeout: 10_000 },
        )
        .toBe(`queued:1:e2e_export_${failurePhase}_failure`);

      const resumed = await request.get(`${workerOrigin}/cdn-cgi/handler/scheduled`);
      expect(resumed.status(), await resumed.text()).toBe(200);
      const completed = await pollDataJob(request, headers, createdBody.job.id);
      expect(completed.contentSha256).toMatch(/^[a-f0-9]{64}$/);
      const finalStatus = await request.get(
        `${workerOrigin}/workbench/data-exports/${encodeURIComponent(createdBody.job.id)}`,
        { headers },
      );
      expect(await finalStatus.json()).toMatchObject({
        job: { status: "completed", attemptCount: 2 },
      });
    }
  });

  test("resumes a phase-checkpointed purge after terminal failure", async ({ request }) => {
    const failures = [
      ["credential_revocation", undefined],
      ["durable_object_purge", "credentials_revoked"],
      ["r2_deletion", "durable_objects_purged"],
      ["d1_rows", "objects_deleted"],
      ["receipt_creation", "objects_deleted"],
    ] as const;
    for (const [failurePhase, expectedCheckpoint] of failures) {
      const suffix = `${failurePhase}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const workspaceName = `Purge retry ${suffix}`;
      const headers = {
        authorization: "Bearer e2e-control-plane-token",
        "x-assistant-mk1-user-id": `purge-owner-${suffix}`,
        "x-assistant-mk1-workspace-id": `purge-workspace-${suffix}`,
        "x-assistant-mk1-agent-id": `purge-agent-${suffix}`,
        "x-assistant-mk1-account-id": `local-dev:purge-workspace-${suffix}`,
        "x-assistant-mk1-account-source": "local-dev",
        "x-assistant-mk1-workspace-name": workspaceName,
      };
      const bootstrap = await request.get(`${workerOrigin}/admin/workspace-summary`, { headers });
      expect(bootstrap.status(), await bootstrap.text()).toBe(200);

      const deletion = await request.post(`${workerOrigin}/workbench/workspace-deletion`, {
        headers,
        data: {
          workspaceName,
          reauthenticatedAt: new Date().toISOString(),
          e2eFailPhase: failurePhase,
        },
      });
      expect(deletion.status(), await deletion.text()).toBe(202);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const scheduled = await request.get(`${workerOrigin}/cdn-cgi/handler/scheduled`);
        expect(scheduled.status(), await scheduled.text()).toBe(200);
      }
      const failed = await request.get(`${workerOrigin}/workbench/workspace-deletion`, { headers });
      expect(failed.status(), await failed.text()).toBe(200);
      const failedBody = await failed.json();
      expect(failedBody).toMatchObject({
        deletion: {
          status: "failed",
          attemptCount: 3,
          manualRetryCount: 0,
          lastErrorCode: `e2e_purge_${failurePhase}_failure`,
          canRetry: true,
          canRecover: false,
        },
      });
      expect(failedBody.deletion.phase).toBe(expectedCheckpoint);

      const stale = await request.post(`${workerOrigin}/workbench/workspace-deletion/retry`, {
        headers,
        data: { workspaceName, reauthenticatedAt: "2026-01-01T00:00:00.000Z" },
      });
      expect(stale.status()).toBe(403);

      const retry = await request.post(`${workerOrigin}/workbench/workspace-deletion/retry`, {
        headers,
        data: { workspaceName, reauthenticatedAt: new Date().toISOString() },
      });
      expect(retry.status(), await retry.text()).toBe(202);
      expect(await retry.json()).toMatchObject({
        deletion: { status: "purging", canRetry: false },
      });

      const concurrentRetry = await request.post(
        `${workerOrigin}/workbench/workspace-deletion/retry`,
        {
          headers,
          data: { workspaceName, reauthenticatedAt: new Date().toISOString() },
        },
      );
      expect(concurrentRetry.status()).toBe(404);

      const completed = await request.get(`${workerOrigin}/cdn-cgi/handler/scheduled`);
      expect(completed.status(), await completed.text()).toBe(200);
      const purged = await request.get(`${workerOrigin}/workbench/workspace-deletion`, { headers });
      expect(purged.status()).toBe(404);
    }
  });
});
