import { expect, test } from "./fixtures";

import { controlPlane as complexOperatorRuntime } from "../../examples/complex-operator/control-plane";

const releaseMode = process.env.E2E_RELEASE_MODE;
const workerOrigin = "http://127.0.0.1:8788";
const headers = {
  authorization: "Bearer e2e-control-plane-token",
  "x-assistant-mk1-user-id": "e2e-owner",
  "x-assistant-mk1-workspace-id": "e2e-workspace",
  "x-assistant-mk1-agent-id": "e2e-complex-agent",
  "x-assistant-mk1-account-id": "local-dev:e2e-workspace",
  "x-assistant-mk1-account-source": "local-dev",
};
const activeAgentHeaders = {
  ...headers,
  "x-assistant-mk1-agent-id": "e2e-agent",
};

test.describe.serial("Agent-system executable conformance", () => {
  test.skip(releaseMode !== "local-session");
  test.setTimeout(60_000);

  test("an external-style package executes through Cloudflare, signed Fly, and D1", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("main")).toBeVisible();

    const activate = await request.post(`${workerOrigin}/agents/e2e-complex-agent/activate`, {
      headers: activeAgentHeaders,
    });
    expect(activate.status(), await activate.text()).toBe(200);

    const retention = await request.patch(`${workerOrigin}/workbench/retention-policy`, {
      headers,
      data: {
        artifactRetentionDays: 90,
        operationalEventRetentionDays: 30,
        runtimeTraceRetentionDays: 14,
        chatMessageRetentionDays: 90,
        runPayloadRetentionDays: 90,
        auditActionRetentionDays: 365,
        confirm: true,
      },
    });
    expect(retention.status(), await retention.text()).toBe(200);

    const authorization = await request.post(
      `${workerOrigin}/workbench/connections/operator.oauth-observer/authorize`,
      { headers, data: { redirectUri: "http://localhost/oauth-complete" } },
    );
    expect(authorization.status(), await authorization.text()).toBe(200);
    const authorizationBody = (await authorization.json()) as { authorizationUrl: string };
    const providerResponse = await request.get(authorizationBody.authorizationUrl, {
      maxRedirects: 0,
    });
    expect(providerResponse.status()).toBe(302);
    const providerRedirect = new URL(providerResponse.headers().location!);
    const callback = await request.post(`${workerOrigin}/workbench/connections/oauth/callback`, {
      headers,
      data: {
        state: providerRedirect.searchParams.get("state"),
        code: providerRedirect.searchParams.get("code"),
      },
    });
    expect(callback.status(), await callback.text()).toBe(200);

    const apiKeyConnection = await request.post(
      `${workerOrigin}/workbench/connections/operator.external-account/credentials`,
      { headers, data: { secret: "e2e-synthetic-api-key" } },
    );
    expect(apiKeyConnection.status(), await apiKeyConnection.text()).toBe(201);

    const response = await request.post(
      `${workerOrigin}/workbench/workflows/complex-operator.observe`,
      {
        headers,
        data: {
          executionMode: "dry_run",
          input: { subject: "service-boundary" },
        },
      },
    );
    expect(response.status(), await response.text()).toBe(201);
    const receipt = (await response.json()) as {
      run?: { id?: string; runtimeVersion?: string; engine?: string };
      artifact?: { id?: string; kind?: string };
      report?: {
        signal?: { signal?: string };
        snapshot?: { subject?: string; status?: string };
        proposal?: { status?: string };
      };
    };
    expect(receipt.run).toMatchObject({
      runtimeVersion: complexOperatorRuntime.runtimeVersion,
      engine: "cloudflare",
    });
    expect(receipt.artifact).toMatchObject({ kind: "complex_operator_report" });
    expect(receipt.report).toMatchObject({
      signal: { signal: "nominal" },
      snapshot: { subject: "service-boundary", status: "nominal" },
      proposal: { status: "proposed" },
    });

    const snapshotResponse = await request.get(
      `${workerOrigin}/workbench/history/runs/${encodeURIComponent(receipt.run!.id!)}`,
      { headers },
    );
    expect(snapshotResponse.ok()).toBe(true);
    const snapshot = (await snapshotResponse.json()) as {
      snapshot?: {
        run?: { status?: string; engine?: string; data?: Record<string, unknown> };
        toolCalls?: Array<{ toolId?: string; status?: string; data?: Record<string, unknown> }>;
        artifacts?: Array<{ id?: string; kind?: string }>;
      };
    };
    expect(snapshot.snapshot?.run).toMatchObject({
      status: "completed",
      engine: "cloudflare",
      data: {
        packId: "complex-operator",
        packVersion: "1.1.1",
        runtimeVersion: complexOperatorRuntime.runtimeVersion,
        workflowType: "complex-operator.observe",
      },
    });
    expect(snapshot.snapshot?.toolCalls?.map((call) => call.toolId)).toEqual([
      "operator.signal.read",
      "operator.snapshot",
      "operator.action.propose",
    ]);
    expect(
      snapshot.snapshot?.toolCalls?.find((call) => call.toolId === "operator.snapshot")?.data,
    ).toMatchObject({
      transport: "fly",
      adapterVersion: "operator-snapshot-v1",
    });
    expect(snapshot.snapshot?.artifacts).toContainEqual(
      expect.objectContaining({ id: receipt.artifact?.id, kind: "complex_operator_report" }),
    );

    const proposalsResponse = await request.get(`${workerOrigin}/workbench/actions`, { headers });
    expect(proposalsResponse.ok()).toBe(true);
    const proposals = (await proposalsResponse.json()) as {
      proposals: Array<{ id: string; status: string }>;
    };
    const proposal = proposals.proposals.find((candidate) => candidate.status === "proposed");
    expect(proposal).toBeTruthy();
    const enableMutation = await request.post(`${workerOrigin}/tools/policy`, {
      headers,
      data: {
        toolName: "operator.action.execute",
        mutationEnabled: true,
      },
    });
    expect(enableMutation.status(), await enableMutation.text()).toBe(200);
    const execute = await request.post(
      `${workerOrigin}/workbench/actions/${encodeURIComponent(proposal!.id)}/execute`,
      { headers },
    );
    expect(execute.status(), await execute.text()).toBe(202);
    const executeBody = (await execute.json()) as { approvalRequest: { id: string } };
    const approve = await request.post(
      `${workerOrigin}/tools/approvals/${encodeURIComponent(executeBody.approvalRequest.id)}/approve`,
      { headers },
    );
    expect(approve.status(), await approve.text()).toBe(200);
    expect(await approve.json()).toMatchObject({
      result: { status: "executed", output: { transport: "fly" } },
    });
    const executedHistory = await request.get(`${workerOrigin}/workbench/actions`, { headers });
    expect(executedHistory.status(), await executedHistory.text()).toBe(200);
    expect(await executedHistory.json()).toMatchObject({
      proposals: expect.arrayContaining([
        expect.objectContaining({
          id: proposal!.id,
          status: "executed",
          ledger: expect.arrayContaining([
            expect.objectContaining({ status: "proposed" }),
            expect.objectContaining({ status: "approved" }),
            expect.objectContaining({ status: "executing" }),
            expect.objectContaining({ status: "executed" }),
          ]),
        }),
      ]),
    });

    const duplicate = await request.post(
      `${workerOrigin}/workbench/actions/${encodeURIComponent(proposal!.id)}/execute`,
      { headers },
    );
    expect(duplicate.status()).toBe(409);

    const runFixture = async (subject: string) => {
      const workflowResponse = await request.post(
        `${workerOrigin}/workbench/workflows/complex-operator.observe`,
        { headers, data: { executionMode: "dry_run", input: { subject } } },
      );
      expect(workflowResponse.status(), await workflowResponse.text()).toBe(201);
      const proposalResponse = await request.get(`${workerOrigin}/workbench/actions`, { headers });
      expect(proposalResponse.ok()).toBe(true);
      const body = (await proposalResponse.json()) as {
        proposals: Array<{ id: string; status: string; summary: string }>;
      };
      const created = body.proposals.find(
        (candidate) => candidate.status === "proposed" && candidate.summary.includes(subject),
      );
      expect(created).toBeTruthy();
      return created!;
    };

    const deniedProposal = await runFixture("approval-denial");
    const deniedRequest = await request.post(
      `${workerOrigin}/workbench/actions/${encodeURIComponent(deniedProposal.id)}/execute`,
      { headers },
    );
    expect(deniedRequest.status(), await deniedRequest.text()).toBe(202);
    const deniedRequestBody = (await deniedRequest.json()) as { approvalRequest: { id: string } };
    const denied = await request.post(
      `${workerOrigin}/tools/approvals/${encodeURIComponent(deniedRequestBody.approvalRequest.id)}/deny`,
      { headers, data: { reason: "Conformance denial." } },
    );
    expect(denied.status(), await denied.text()).toBe(200);
    const afterDenial = await request.get(`${workerOrigin}/workbench/actions`, { headers });
    expect(await afterDenial.json()).toMatchObject({
      proposals: expect.arrayContaining([
        expect.objectContaining({ id: deniedProposal.id, status: "cancelled" }),
      ]),
    });

    const timeoutProposal = await runFixture("timeout");
    const timeoutRequest = await request.post(
      `${workerOrigin}/workbench/actions/${encodeURIComponent(timeoutProposal.id)}/execute`,
      { headers },
    );
    expect(timeoutRequest.status(), await timeoutRequest.text()).toBe(202);
    const timeoutRequestBody = (await timeoutRequest.json()) as { approvalRequest: { id: string } };
    const timeoutApproval = await request.post(
      `${workerOrigin}/tools/approvals/${encodeURIComponent(timeoutRequestBody.approvalRequest.id)}/approve`,
      { headers },
    );
    expect(timeoutApproval.status(), await timeoutApproval.text()).toBe(502);
    expect(await timeoutApproval.json()).toMatchObject({ result: { status: "outcome_unknown" } });
    await new Promise((resolve) => setTimeout(resolve, 750));
    const reconciled = await request.post(
      `${workerOrigin}/workbench/actions/${encodeURIComponent(timeoutProposal.id)}/reconcile`,
      { headers },
    );
    expect(reconciled.status(), await reconciled.text()).toBe(200);
    expect(await reconciled.json()).toMatchObject({ result: { status: "reconciled" } });

    const packPaused = await request.put(`${workerOrigin}/workbench/kill-switches`, {
      headers,
      data: {
        scopeKind: "pack",
        scopeId: "complex-operator",
        enabled: true,
        reason: "Conformance kill-switch test.",
      },
    });
    expect(packPaused.status(), await packPaused.text()).toBe(200);
    const blockedProposal = await runFixture("kill-switch");
    const blockedExecution = await request.post(
      `${workerOrigin}/workbench/actions/${encodeURIComponent(blockedProposal.id)}/execute`,
      { headers },
    );
    expect(blockedExecution.status(), await blockedExecution.text()).toBe(403);
    expect(await blockedExecution.json()).toMatchObject({ code: "kill_switch_active" });
    const packResumed = await request.put(`${workerOrigin}/workbench/kill-switches`, {
      headers,
      data: {
        scopeKind: "pack",
        scopeId: "complex-operator",
        enabled: false,
        reason: "Conformance kill-switch cleared.",
      },
    });
    expect(packResumed.status(), await packResumed.text()).toBe(200);

    const otherTenantHeaders = {
      ...headers,
      "x-assistant-mk1-user-id": "e2e-other-owner",
      "x-assistant-mk1-workspace-id": "e2e-other-workspace",
      "x-assistant-mk1-agent-id": "e2e-other-agent",
      "x-assistant-mk1-account-id": "local-dev:e2e-other-workspace",
    };
    const crossTenantList = await request.get(`${workerOrigin}/workbench/actions`, {
      headers: otherTenantHeaders,
    });
    expect(crossTenantList.status(), await crossTenantList.text()).toBe(200);
    expect(await crossTenantList.json()).toMatchObject({ proposals: [] });
    const crossTenantExecute = await request.post(
      `${workerOrigin}/workbench/actions/${encodeURIComponent(proposal!.id)}/execute`,
      { headers: otherTenantHeaders },
    );
    expect(crossTenantExecute.status()).toBe(404);

    const managedStateResponse = await request.get(
      `${workerOrigin}/workbench/managed-state?namespace=complex-operator&type=observation`,
      { headers },
    );
    expect(managedStateResponse.ok()).toBe(true);
    expect(await managedStateResponse.json()).toMatchObject({
      states: [
        expect.objectContaining({
          status: "review",
          namespace: "complex-operator",
          stateType: "observation",
        }),
      ],
    });
  });
});
