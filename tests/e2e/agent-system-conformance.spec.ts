import { expect, test } from "./fixtures";

import { createWorkbenchClient } from "../../packages/client/src/client";
import { controlPlane as complexOperatorRuntime } from "../../examples/complex-operator/control-plane";
import { e2eOwner, workerApi, workerOrigin } from "./worker-api";

const releaseMode = process.env.E2E_RELEASE_MODE;

test.describe.serial("Agent-system executable conformance", () => {
  test.skip(releaseMode !== "local-session");
  test.setTimeout(60_000);

  test("an external-style package executes through Cloudflare, signed Fly, and D1", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("main")).toBeVisible();

    // The seeded package agent lives in the owner's default workspace.
    const owner = workerApi(request);
    const worker = workerApi(request, { agentId: "e2e-complex-agent" });
    expect((await owner.account()).ok()).toBe(true);
    const activate = await owner.post("/agents/e2e-complex-agent/activate");
    expect(activate.status(), await activate.text()).toBe(200);
    // Agents start in simulation; this journey proves the external signed-Fly path.
    const effectTarget = await worker.get("/agents/e2e-complex-agent/effect-target");
    expect(effectTarget.status(), await effectTarget.text()).toBe(200);
    const external = await worker.put("/agents/e2e-complex-agent/effect-target", {
      data: {
        effectTarget: "external",
        expectedRevision: ((await effectTarget.json()) as { runtimeRevision: number })
          .runtimeRevision,
      },
    });
    expect(external.status(), await external.text()).toBe(200);

    const retention = await worker.patch("/workbench/retention-policy", {
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

    const authorization = await worker.post(
      "/workbench/connections/operator.oauth-observer/authorize",
      { data: { redirectUri: "http://localhost/oauth-complete" } },
    );
    expect(authorization.status(), await authorization.text()).toBe(200);
    const authorizationBody = (await authorization.json()) as { authorizationUrl: string };
    const providerResponse = await request.get(authorizationBody.authorizationUrl, {
      maxRedirects: 0,
    });
    expect(providerResponse.status()).toBe(302);
    const providerRedirect = new URL(providerResponse.headers().location!);
    const callback = await worker.post("/workbench/connections/oauth/callback", {
      data: {
        state: providerRedirect.searchParams.get("state"),
        code: providerRedirect.searchParams.get("code"),
      },
    });
    expect(callback.status(), await callback.text()).toBe(200);

    const apiKeyConnection = await worker.post(
      "/workbench/connections/operator.external-account/credentials",
      { data: { secret: "e2e-synthetic-api-key" } },
    );
    expect(apiKeyConnection.status(), await apiKeyConnection.text()).toBe(201);

    const response = await worker.post("/workbench/workflows/complex-operator.observe", {
      data: {
        executionMode: "dry_run",
        input: { subject: "service-boundary" },
      },
    });
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

    const snapshotResponse = await worker.get(
      `/workbench/history/runs/${encodeURIComponent(receipt.run!.id!)}`,
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

    const proposalsResponse = await worker.get("/workbench/actions");
    expect(proposalsResponse.ok()).toBe(true);
    const proposals = (await proposalsResponse.json()) as {
      proposals: Array<{ id: string; status: string }>;
    };
    const proposal = proposals.proposals.find((candidate) => candidate.status === "proposed");
    expect(proposal).toBeTruthy();
    const enableMutation = await worker.post("/tools/policy", {
      data: {
        toolName: "operator.action.execute",
        mutationEnabled: true,
      },
    });
    expect(enableMutation.status(), await enableMutation.text()).toBe(200);
    const execute = await worker.post(
      `/workbench/actions/${encodeURIComponent(proposal!.id)}/execute`,
    );
    expect(execute.status(), await execute.text()).toBe(202);
    const executeBody = (await execute.json()) as {
      approvalRequest: { id: string; requestHash: string; expiresAt: string };
    };
    expect(executeBody.approvalRequest.requestHash).toMatch(/^[a-f0-9]{64}$/);
    const reviewRemainingMs = Date.parse(executeBody.approvalRequest.expiresAt) - Date.now();
    expect(reviewRemainingMs).toBeGreaterThan(0);
    expect(reviewRemainingMs).toBeLessThanOrEqual(15 * 60 * 1000);
    const approve = await worker.post(
      `/tools/approvals/${encodeURIComponent(executeBody.approvalRequest.id)}/approve`,
    );
    expect(approve.status(), await approve.text()).toBe(200);
    expect(await approve.json()).toMatchObject({
      result: { status: "executed", output: { transport: "fly" } },
    });
    const executedHistory = await worker.get("/workbench/actions");
    expect(executedHistory.status(), await executedHistory.text()).toBe(200);
    expect(await executedHistory.json()).toMatchObject({
      proposals: expect.arrayContaining([
        expect.objectContaining({
          id: proposal!.id,
          status: "executed",
          review: {
            requestHash: executeBody.approvalRequest.requestHash,
            expiresAt: executeBody.approvalRequest.expiresAt,
          },
          ledger: expect.arrayContaining([
            expect.objectContaining({ status: "proposed" }),
            expect.objectContaining({ status: "approved" }),
            expect.objectContaining({ status: "executing" }),
            expect.objectContaining({ status: "executed" }),
          ]),
        }),
      ]),
    });

    const duplicate = await worker.post(
      `/workbench/actions/${encodeURIComponent(proposal!.id)}/execute`,
    );
    expect(duplicate.status()).toBe(409);

    const runFixture = async (subject: string) => {
      const workflowResponse = await worker.post("/workbench/workflows/complex-operator.observe", {
        data: { executionMode: "dry_run", input: { subject } },
      });
      expect(workflowResponse.status(), await workflowResponse.text()).toBe(201);
      const proposalResponse = await worker.get("/workbench/actions");
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
    const deniedRequest = await worker.post(
      `/workbench/actions/${encodeURIComponent(deniedProposal.id)}/execute`,
    );
    expect(deniedRequest.status(), await deniedRequest.text()).toBe(202);
    const deniedRequestBody = (await deniedRequest.json()) as { approvalRequest: { id: string } };
    const denied = await worker.post(
      `/tools/approvals/${encodeURIComponent(deniedRequestBody.approvalRequest.id)}/deny`,
      { data: { reason: "Conformance denial." } },
    );
    expect(denied.status(), await denied.text()).toBe(200);
    const afterDenial = await worker.get("/workbench/actions");
    expect(await afterDenial.json()).toMatchObject({
      proposals: expect.arrayContaining([
        expect.objectContaining({ id: deniedProposal.id, status: "cancelled" }),
      ]),
    });

    const timeoutProposal = await runFixture("timeout");
    const timeoutRequest = await worker.post(
      `/workbench/actions/${encodeURIComponent(timeoutProposal.id)}/execute`,
    );
    expect(timeoutRequest.status(), await timeoutRequest.text()).toBe(202);
    const timeoutRequestBody = (await timeoutRequest.json()) as { approvalRequest: { id: string } };
    const timeoutApproval = await worker.post(
      `/tools/approvals/${encodeURIComponent(timeoutRequestBody.approvalRequest.id)}/approve`,
    );
    expect(timeoutApproval.status(), await timeoutApproval.text()).toBe(502);
    expect(await timeoutApproval.json()).toMatchObject({ result: { status: "outcome_unknown" } });
    await new Promise((resolve) => setTimeout(resolve, 750));
    const reconciled = await worker.post(
      `/workbench/actions/${encodeURIComponent(timeoutProposal.id)}/reconcile`,
    );
    expect(reconciled.status(), await reconciled.text()).toBe(200);
    expect(await reconciled.json()).toMatchObject({ result: { status: "reconciled" } });

    const blockedProposal = await runFixture("kill-switch");
    const packPaused = await worker.put("/workbench/kill-switches", {
      data: {
        scopeKind: "pack",
        scopeId: "complex-operator",
        enabled: true,
        reason: "Conformance kill-switch test.",
      },
    });
    expect(packPaused.status(), await packPaused.text()).toBe(200);
    // A paused pack admits no new runs and cancels its pending proposals.
    const pausedRun = await worker.post("/workbench/workflows/complex-operator.observe", {
      data: { executionMode: "dry_run", input: { subject: "kill-switch-run" } },
    });
    expect(pausedRun.status(), await pausedRun.text()).toBe(409);
    expect(await pausedRun.json()).toMatchObject({ code: "resource_admission_denied" });
    const afterPause = await worker.get("/workbench/actions");
    expect(await afterPause.json()).toMatchObject({
      proposals: expect.arrayContaining([
        expect.objectContaining({ id: blockedProposal.id, status: "cancelled" }),
      ]),
    });
    const blockedExecution = await worker.post(
      `/workbench/actions/${encodeURIComponent(blockedProposal.id)}/execute`,
    );
    expect(blockedExecution.status(), await blockedExecution.text()).toBe(409);
    const packResumed = await worker.put("/workbench/kill-switches", {
      data: {
        scopeKind: "pack",
        scopeId: "complex-operator",
        enabled: false,
        reason: "Conformance kill-switch cleared.",
      },
    });
    expect(packResumed.status(), await packResumed.text()).toBe(200);

    const otherTenant = workerApi(request, { userId: "e2e-other-owner" });
    expect((await otherTenant.account()).ok()).toBe(true);
    const crossTenantList = await otherTenant.get("/workbench/actions");
    expect(crossTenantList.status(), await crossTenantList.text()).toBe(200);
    expect(await crossTenantList.json()).toMatchObject({ proposals: [] });
    const crossTenantExecute = await otherTenant.post(
      `/workbench/actions/${encodeURIComponent(proposal!.id)}/execute`,
    );
    expect(crossTenantExecute.status()).toBe(404);

    const managedStateResponse = await worker.get(
      "/workbench/managed-state?namespace=complex-operator&type=observation",
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

    // A native shell uses @operloom/client straight against /v1 (here the explicit agent scope,
    // /v1/me in the app); the route map keeps it on the operations the console reaches via Next.js.
    const direct = createWorkbenchClient({
      baseUrl: `${workerOrigin}/v1/workspaces/${encodeURIComponent(worker.workspaceId)}/agents/${encodeURIComponent(worker.agentId)}`,
      target: "control-plane",
      client: { platform: "ios", version: "e2e" },
      getAccessToken: async () => "e2e-control-plane-token",
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers).entries()),
            "x-operloom-local-user": e2eOwner,
          },
        }),
    });
    const directSession = await direct.session.get();
    expect(directSession.ok).toBe(true);
    const directRuns = await direct.history.listRuns({ limit: 50 });
    expect(directRuns.runs?.some((run) => run.id === receipt.run!.id)).toBe(true);
    const directApprovals = await direct.approvals.list();
    expect(directApprovals.ok).toBe(true);
    await expect(direct.workspaces.listAccounts()).rejects.toMatchObject({
      code: "console_only_operation",
    });

    // Memory: the user writes a goal about a subject; the observe workflow remembered a
    // conclusion that, because this pack handles financial data, waits as a proposal with a
    // TTL until the user confirms it. Both are recalled over /v1 and listable by target.
    const goal = await worker.put("/workbench/memory/goal/paper-book", {
      data: {
        title: "Grow the paper book to $500",
        content: { targetUsd: 500 },
        target: { type: "subject", id: "service-boundary" },
      },
    });
    expect(goal.status(), await goal.text()).toBe(200);
    const memory = (await (await worker.get("/workbench/memory?status=all")).json()) as {
      records: Array<{
        id: string;
        kind: string;
        key: string;
        source: string;
        status: string;
        expiresAt: string | null;
      }>;
    };
    expect(memory.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "goal",
          key: "paper-book",
          source: "user",
          status: "active",
          expiresAt: null,
        }),
        expect.objectContaining({
          kind: "conclusion",
          key: "observation:service-boundary",
          source: "workflow",
          status: "proposed",
          expiresAt: expect.any(String),
        }),
      ]),
    );
    const proposedConclusion = memory.records.find(
      (record) => record.key === "observation:service-boundary",
    )!;
    const confirmedConclusion = await worker.post(
      `/workbench/memory/${encodeURIComponent(proposedConclusion.id)}/confirm`,
    );
    expect(confirmedConclusion.status(), await confirmedConclusion.text()).toBe(200);
    expect(await confirmedConclusion.json()).toMatchObject({ record: { status: "active" } });
    const bySubject = await direct.memory.list({
      targetType: "subject",
      targetId: "service-boundary",
    });
    expect(bySubject.records.map((record) => record.key).sort()).toEqual([
      "observation:service-boundary",
      "paper-book",
    ]);
    const directMemory = await direct.memory.list({ status: "all" });
    expect(directMemory.records.map((record) => record.key)).toContain("paper-book");
    // Owners see and edit every member's memory; edits are audited and tenant-scoped.
    const adminMemory = await direct.admin.memory.list({ q: "paper" });
    expect(adminMemory.records.map((record) => [record.key, record.userId])).toEqual([
      ["paper-book", e2eOwner],
    ]);
    expect(adminMemory.policy.autoActivate).toEqual([]);
    const adminEdit = await direct.admin.memory.update(adminMemory.records[0]!.id, {
      title: "Grow the paper book to $750",
      content: { targetUsd: 750 },
    });
    expect(adminEdit.record).toMatchObject({ title: "Grow the paper book to $750", version: 2 });
    const otherAdminMemory = (await (await otherTenant.get("/admin/memory")).json()) as {
      records: unknown[];
    };
    expect(otherAdminMemory.records).toEqual([]);
    const forgotten = await worker.delete(
      `/workbench/memory/${encodeURIComponent(memory.records.find((record) => record.kind === "goal")!.id)}`,
    );
    expect(forgotten.status(), await forgotten.text()).toBe(200);
    expect(await forgotten.json()).toMatchObject({ record: { status: "archived" } });
    const otherMemory = (await (await otherTenant.get("/workbench/memory?status=all")).json()) as {
      records: unknown[];
    };
    expect(otherMemory.records).toEqual([]);

    // MCP exposes the same workflows as tools behind the same bearer and a client allowlist.
    const mcpUrl = `${workerOrigin}/v1/workspaces/${encodeURIComponent(worker.workspaceId)}/agents/${encodeURIComponent(worker.agentId)}/mcp`;
    const rpc = (body: unknown, headers: Record<string, string> = {}) =>
      request.post(mcpUrl, {
        data: body,
        headers: {
          authorization: "Bearer e2e-control-plane-token",
          "x-operloom-local-user": e2eOwner,
          ...headers,
        },
      });
    const unauthenticated = await request.post(mcpUrl, {
      data: { jsonrpc: "2.0", id: 0, method: "ping" },
    });
    expect(unauthenticated.status()).toBe(401);
    expect(unauthenticated.headers()["www-authenticate"]).toContain("oauth-protected-resource");
    const metadata = await request.get(`${workerOrigin}/.well-known/oauth-protected-resource`);
    expect(await metadata.json()).toMatchObject({ resource: `${workerOrigin}/v1/me/mcp` });
    const initialized = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(initialized.status(), await initialized.text()).toBe(200);
    expect(await initialized.json()).toMatchObject({
      result: { serverInfo: { name: "operloom" } },
    });
    const tools = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(tools.result.tools.map((tool) => tool.name)).toContain(
      "workflow_complex-operator_observe",
    );
    const observed = (await (
      await rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "workflow_complex-operator_observe", arguments: { subject: "mcp" } },
      })
    ).json()) as {
      result: {
        isError: boolean;
        structuredContent: Record<string, unknown>;
        _meta: Record<string, string>;
      };
    };
    expect(observed.result.isError).toBe(false);
    expect(observed.result.structuredContent).toMatchObject({ signal: { signal: "nominal" } });
    expect(observed.result._meta["operloom/renderer"]).toBe("complex_operator_report");

    // Plans are a budget ceiling: an admin cannot raise limits past the plan, and a manual
    // plan change moves the ceiling.
    const billing = await worker.get("/workbench/billing");
    expect(billing.status(), await billing.text()).toBe(200);
    expect(await billing.json()).toMatchObject({
      provider: "manual",
      entitlements: { planId: "free", subscribed: false },
    });
    const budgets = await worker.get("/workbench/budgets");
    expect(budgets.status(), await budgets.text()).toBe(200);
    const budgetBody = (await budgets.json()) as {
      policy: { version: number } | null;
      plan: { id: string; limits: Record<string, number> };
    };
    expect(budgetBody.plan.id).toBe("free");
    const overCeiling = await worker.put("/workbench/budgets", {
      data: {
        expectedVersion: budgetBody.policy?.version ?? 0,
        idempotencyKey: "e2e-over-ceiling",
        limits: {
          ...budgetBody.plan.limits,
          dailyModelCalls: budgetBody.plan.limits.dailyModelCalls + 1,
        },
      },
    });
    expect(overCeiling.status(), await overCeiling.text()).toBe(409);
    expect(await overCeiling.json()).toMatchObject({ code: "budget_exceeds_plan" });
    const upgraded = await worker.put("/workbench/billing/plan", { data: { planId: "team" } });
    expect(upgraded.status(), await upgraded.text()).toBe(200);
    expect(await upgraded.json()).toMatchObject({
      entitlements: { planId: "team", subscribed: true },
    });
    const context = await worker.get("/workspace-context");
    expect(context.status(), await context.text()).toBe(200);
    expect(await context.json()).toMatchObject({ context: { entitlements: { planId: "team" } } });
    const downgraded = await worker.put("/workbench/billing/plan", { data: { planId: "free" } });
    expect(downgraded.status(), await downgraded.text()).toBe(200);

    // The runner's browser recipe scrapes a fixture page served by the runner itself,
    // staying inside the tool's allowed hosts while blocking the third-party script.
    const pageRead = await worker.post("/tools/runs", {
      data: {
        toolName: "operator.page.read",
        executionMode: "dry_run",
        input: { url: "http://127.0.0.1:3101/e2e/page", headlineSelector: "#headline" },
      },
    });
    expect(pageRead.status(), await pageRead.text()).toBe(201);
    const pageReceipt = (await pageRead.json()) as {
      output?: { status?: string; engine?: string; title?: string; headline?: string };
      run?: { status?: string };
      artifact?: { kind?: string; staged?: boolean };
    };
    expect(pageReceipt.run?.status).toBe("completed");
    expect(pageReceipt.output).toMatchObject({
      status: "completed",
      engine: "fetch",
      title: "Permit notice",
      headline: "Permit 2026-0417 approved",
    });
    expect(pageReceipt.artifact).toMatchObject({ kind: "page_excerpt", staged: true });
    const blockedPageRead = await worker.post("/tools/runs", {
      data: {
        toolName: "operator.page.read",
        executionMode: "dry_run",
        input: { url: "https://tracker.example/" },
      },
    });
    // The runner refuses the off-allowlist host; the console sees the failed run, not page content.
    expect(blockedPageRead.status()).toBe(502);
    expect(await blockedPageRead.json()).toMatchObject({
      ok: false,
      run: expect.objectContaining({ status: "failed" }),
    });
  });
});
