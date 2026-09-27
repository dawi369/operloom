import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { chromium } from "@playwright/test";
import { startManagedProcess } from "./managed-process";
import { createRuntimeClient } from "../packages/client/src/runtime-client";

const main = async () => {
  const root = process.cwd();
  const standalone = process.argv.includes("--standalone")
    ? (JSON.parse(
        readFileSync(resolve(root, "output/runtime-distribution/latest.json"), "utf8"),
      ) as { directory: string; config: string })
    : undefined;
  const runtimeRoot = standalone?.directory ?? root;
  if (standalone) {
    const dependency = resolve(runtimeRoot, "node_modules/wrangler/package.json");
    if (
      !existsSync(dependency) ||
      relative(realpathSync(runtimeRoot), realpathSync(dependency)).startsWith("..")
    )
      throw new Error(
        "Standalone acceptance requires artifact-local Wrangler: pnpm install --ignore-workspace in its deployment directory",
      );
  }
  mkdirSync(resolve(root, "output/runtime-conformance"), { recursive: true });
  const state = mkdtempSync(resolve(root, "output/runtime-conformance/state-"));
  const common = [
    "--config",
    standalone?.config ?? "cloudflare/control-plane/wrangler.jsonc",
    "--local",
    "--persist-to",
    state,
  ];
  const migrate = startManagedProcess(
    "pnpm",
    ["exec", "wrangler", "d1", "migrations", "apply", "operloom_local", ...common],
    { label: "worker-runtime-migrate", cwd: runtimeRoot, stdio: "pipe", maxRssMb: 1536 },
  );
  let migrationLogs = "";
  const captureMigration = (chunk: Buffer) => {
    migrationLogs = (migrationLogs + String(chunk)).slice(-10000);
  };
  migrate.child.stdout?.on("data", captureMigration);
  migrate.child.stderr?.on("data", captureMigration);
  const migrationTimeout = setTimeout(
    () => migrate.stop("Runtime migrations exceeded 60 seconds"),
    60000,
  );
  const migration = await migrate.completion.finally(() => clearTimeout(migrationTimeout));
  if (migration.code !== 0 || migration.reason)
    throw new Error(`Runtime migration failed: ${migrationLogs}`);
  const reservation = createServer();
  await new Promise<void>((resolveListen) => reservation.listen(0, "127.0.0.1", resolveListen));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolveClose, reject) =>
    reservation.close((error) => (error ? reject(error) : resolveClose())),
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = "runtime-conformance-local-only";
  const browserServer = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Independent runtime client</title>");
  });
  await new Promise<void>((resolveListen) => browserServer.listen(0, "127.0.0.1", resolveListen));
  const browserOrigin = `http://127.0.0.1:${(browserServer.address() as { port: number }).port}`;
  const startWorker = () =>
    startManagedProcess(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        ...common,
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--var",
        `ALLOWED_ORIGINS:${browserOrigin}`,
        "--var",
        "OPERLOOM_LOCAL_API_ENABLED:true",
        "--var",
        "OPERLOOM_ENVIRONMENT:local",
        "--var",
        `OPERLOOM_LOCAL_API_TOKEN:${token}`,
        "--var",
        "OPERLOOM_AGENT_CONNECTION_SECRET:runtime-conformance-agent-secret-000001",
        "--var",
        "OPERLOOM_E2E_MODE:true",
        "--var",
        "OPERLOOM_RETAINED_DATA_ENABLED:true",
      ],
      { label: "worker-runtime-conformance", cwd: runtimeRoot, stdio: "pipe", maxRssMb: 1536 },
    );
  let logs = "";
  const observeWorker = (process: ReturnType<typeof startWorker>) => {
    const capture = (chunk: Buffer) => {
      logs = (logs + String(chunk)).slice(-10000);
    };
    process.child.stdout?.on("data", capture);
    process.child.stderr?.on("data", capture);
    return process;
  };
  let worker = observeWorker(startWorker());
  const timeout = setTimeout(
    () => worker.stop("Runtime conformance exceeded 120 seconds"),
    120_000,
  );
  try {
    const deadline = Date.now() + 60_000;
    while (true) {
      try {
        if ((await fetch(`${baseUrl}/health/live`)).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`Runtime did not start: ${logs}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    const headers = { authorization: `Bearer ${token}` };
    const account = await fetch(`${baseUrl}/v1/account`, { headers });
    if (!account.ok)
      throw new Error(`Account bootstrap: ${account.status} ${await account.text()}`);
    const workspaceId = "workspace:local-api:operloom-local:default";
    const agentId = `agent-${workspaceId}`;
    const client = createRuntimeClient({
      baseUrl,
      target: { workspaceId, agentId },
      getAccessToken: async () => token,
    });
    await client.budgets.update({
      expectedVersion: 0,
      idempotencyKey: "local-budget",
      limits: {
        dailyModelCalls: 50,
        dailyToolCalls: 50,
        dailyTokens: 1000000,
        runModelCalls: 10,
        runToolCalls: 10,
        runTokens: 200000,
        concurrentOperations: 10,
      },
    });
    const thread = await client.threads.create();
    const accepted = await client.threads.submit(
      thread.threadId,
      "Describe the runtime boundary.",
      "runtime-first-turn",
    );
    if (accepted.status !== "accepted" || !accepted.commandId)
      throw new Error("Turn was not accepted with a durable command identity");
    const duplicate = await client.threads.submit(
      thread.threadId,
      "Describe the runtime boundary.",
      "runtime-first-turn",
    );
    if (accepted.messageId !== duplicate.messageId || accepted.commandId !== duplicate.commandId)
      throw new Error("Duplicate submission changed identity");
    let conflict = false;
    try {
      await client.threads.submit(thread.threadId, "Changed content", "runtime-first-turn");
    } catch (error) {
      conflict = (error as { status: number }).status === 409;
    }
    if (!conflict) throw new Error("Changed-content replay was not rejected");
    let messages = await client.threads.messages(thread.threadId);
    const completedBy = Date.now() + 15_000;
    while (!messages.messages.some((message) => message.role === "assistant")) {
      if (Date.now() > completedBy) throw new Error(`No canonical assistant transcript: ${logs}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      messages = await client.threads.messages(thread.threadId);
    }
    if (messages.messages.filter((message) => message.role === "user").length !== 1)
      throw new Error("Replay duplicated the user message");
    let command = (await client.threads.command(accepted.commandId)).command;
    while (command.status === "pending" || command.status === "running") {
      if (Date.now() > completedBy) throw new Error("Command completion did not become canonical");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      command = (await client.threads.command(accepted.commandId)).command;
    }
    if (command.status !== "completed" || !command.runId || !command.acceptedAt)
      throw new Error("Command was not linked to its completed canonical run");

    const forged = await fetch(
      `${baseUrl}/v1/workspaces/other/agents/${encodeURIComponent(agentId)}/chat/threads`,
      { headers: { ...headers, "x-operloom-workspace-id": workspaceId } },
    );
    if (forged.ok) throw new Error("Forged target bypassed isolation");
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") console.error(`Browser: ${message.text()}`);
      });
      page.on("requestfailed", (request) =>
        console.error(`Browser request: ${request.failure()?.errorText}`),
      );
      await page.goto(`${browserOrigin}/runtime-client`);
      const transcriptUrl = `${baseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/chat/threads/${encodeURIComponent(thread.threadId)}/messages`;
      const observed = await page.evaluate(
        async ({ transcriptUrl, token }) => {
          const response = await fetch(transcriptUrl, {
            headers: { authorization: `Bearer ${token}` },
          });
          if (!response.ok) throw new Error(`Browser transcript failed: ${response.status}`);
          return response.json();
        },
        { transcriptUrl, token },
      );
      if (JSON.stringify(observed.messages) !== JSON.stringify(messages.messages))
        throw new Error("Browser and Node did not observe identical canonical messages");
      await page.close();
      const reconnected = await context.newPage();
      await reconnected.goto(`${browserOrigin}/runtime-client`);
      const replay = await reconnected.evaluate(
        async ({ transcriptUrl, token }) => {
          const response = await fetch(transcriptUrl, {
            headers: { authorization: `Bearer ${token}` },
          });
          return response.json();
        },
        { transcriptUrl, token },
      );
      if (JSON.stringify(replay.messages) !== JSON.stringify(messages.messages))
        throw new Error("Browser reconnect lost canonical messages");
      const browserAccepted = await reconnected.evaluate(
        async ({ transcriptUrl, token }) => {
          const response = await fetch(transcriptUrl.replace(/messages$/, "turns"), {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "idempotency-key": "browser-turn",
            },
            body: JSON.stringify({ text: "Report the current runtime status." }),
          });
          if (response.status !== 202)
            throw new Error(`Browser submission failed: ${response.status}`);
          return response.json();
        },
        { transcriptUrl, token },
      );
      if (browserAccepted.messageId !== "browser-turn")
        throw new Error("Browser acceptance changed identity");
      const browserFinishedBy = Date.now() + 15_000;
      while (messages.messages.filter((message) => message.role === "assistant").length < 2) {
        messages = await client.threads.messages(thread.threadId);
        if (messages.messages.filter((message) => message.role === "assistant").length >= 2) break;
        if (Date.now() > browserFinishedBy)
          throw new Error("Browser turn did not finish independently");
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }
    } finally {
      await browser.close();
    }
    const operator = await client.request<{ agent: { id: string } }>(
      "/agent-packs/complex-operator/instantiate",
      { method: "POST" },
    );
    const operatorClient = createRuntimeClient({
      baseUrl,
      target: { workspaceId, agentId: operator.agent.id },
      getAccessToken: async () => token,
    });
    const reviewer = await client.request<{ agent: { id: string } }>(
      "/agent-packs/document-review/instantiate",
      { method: "POST" },
    );
    const reviewerClient = createRuntimeClient({
      baseUrl,
      target: { workspaceId, agentId: reviewer.agent.id },
      getAccessToken: async () => token,
    });
    const reviewDocument = () =>
      reviewerClient.request<{
        report: { outcome: string; wordCount: number; snapshotId: string };
      }>("/workbench/workflows/document-review.review", {
        method: "POST",
        body: {
          input: { documentId: "guide", text: "A deterministic document review." },
          executionMode: "dry_run",
        },
      });
    const firstReview = await reviewDocument();
    const repeatedReview = await reviewDocument();
    const summarize = (text = "A deterministic document review.") =>
      reviewerClient.request<{
        report: { outcome: string; reservationId: string; summary: string };
      }>("/workbench/workflows/document-review.summarize", {
        method: "POST",
        body: {
          input: { documentId: "guide", text },
          executionMode: "dry_run",
        },
      });
    const summary = await summarize();
    const afterSummary = await client.budgets.get();
    if (!afterSummary.policy) throw new Error("Workspace budget policy is missing");
    const stoppedBudget = await client.budgets.update({
      expectedVersion: afterSummary.policy.version,
      idempotencyKey: "exhaust-model-budget",
      limits: { ...afterSummary.policy.limits, dailyModelCalls: 0 },
    });
    const summaryReplay = await summarize();
    if (
      summary.report.outcome !== "summarized" ||
      summaryReplay.report.outcome !== "no_change" ||
      summary.report.reservationId !== summaryReplay.report.reservationId
    )
      throw new Error("Structured summary did not preserve the model receipt on unchanged input");
    if ((await client.budgets.get()).usage.modelCalls !== afterSummary.usage.modelCalls)
      throw new Error("Unchanged evidence consumed another model reservation");
    let budgetBlocked = false;
    try {
      await summarize("Changed evidence must require another model call.");
    } catch (error) {
      budgetBlocked =
        (error as { status: number; code: string }).status === 409 &&
        (error as { code: string }).code === "resource_admission_denied";
    }
    if (!budgetBlocked)
      throw new Error("Exhausted budget did not block changed-evidence model work");
    const deniedThread = await reviewerClient.threads.create();
    const deniedTurn = await reviewerClient.threads.submit(
      deniedThread.threadId,
      "Budgeted chat evidence",
      "budget-blocked-turn",
    );
    if (!deniedTurn.commandId) throw new Error("Budgeted chat acceptance lacks a command identity");
    const deniedDeadline = Date.now() + 15000;
    let deniedCommand = (await reviewerClient.threads.command(deniedTurn.commandId)).command;
    while (deniedCommand.status === "pending" || deniedCommand.status === "running") {
      if (Date.now() > deniedDeadline)
        throw new Error("Budget-blocked chat did not become terminal");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      deniedCommand = (await reviewerClient.threads.command(deniedTurn.commandId)).command;
    }
    if (
      deniedCommand.status !== "failed" ||
      deniedCommand.errorCode !== "resource_admission_denied"
    )
      throw new Error(`Chat lost its canonical budget failure: ${JSON.stringify(deniedCommand)}`);
    if ((await client.budgets.get()).usage.modelCalls !== afterSummary.usage.modelCalls)
      throw new Error("Denied operations consumed additional model admissions");
    const usage = await client.budgets.usage({ day: afterSummary.day });
    if (
      !usage.reservations.some(
        (reservation) =>
          reservation.id === summary.report.reservationId &&
          reservation.usageSource === "fixture" &&
          reservation.status === "settled",
      )
    )
      throw new Error(
        "Usage inspection lost the structured model receipt or fixture classification",
      );
    if (afterSummary.usage.knownTokens !== 0 || afterSummary.usage.fixtureTokens <= 0)
      throw new Error("Fixture tokens were not distinguished from provider-reported usage");
    await client.budgets.update({
      expectedVersion: stoppedBudget.policy.version,
      idempotencyKey: "restore-model-budget",
      limits: afterSummary.policy.limits,
    });
    if (
      firstReview.report.outcome !== "reviewed" ||
      firstReview.report.wordCount !== 4 ||
      repeatedReview.report.outcome !== "no_change"
    )
      throw new Error("Document package did not record deterministic review and no-op outcomes");
    const reviewState = await reviewerClient.state.records({
      target: "simulation",
      namespace: "documents",
      kind: "review",
    });
    if (reviewState.records.length !== 1 || reviewState.records[0].version !== 1)
      throw new Error("Unchanged document caused another state write");
    const reviewerSettings = await reviewerClient.admin.settings(reviewer.agent.id);
    const strictSettings = await reviewerClient.admin.updateSettings(reviewer.agent.id, {
      values: { strictness: "strict" },
      expectedVersion: reviewerSettings.version,
    });
    const reviewSummary = await reviewerClient.queries.run<{
      strictness: string;
      reviews: { documentId: string }[];
    }>("document-review.summary");
    if (
      reviewerSettings.values.strictness !== "normal" ||
      strictSettings.version !== reviewerSettings.version + 1 ||
      reviewSummary.output.strictness !== "strict" ||
      reviewSummary.output.reviews.map((review) => review.documentId).join() !== "guide"
    )
      throw new Error("Package settings or queries did not round-trip through /v1");
    const allocator = await client.request<{ agent: { id: string } }>(
      "/agent-packs/resource-allocator/instantiate",
      { method: "POST" },
    );
    const allocatorClient = createRuntimeClient({
      baseUrl,
      target: { workspaceId, agentId: allocator.agent.id },
      getAccessToken: async () => token,
    });
    await allocatorClient.request("/workbench/retention-policy", {
      method: "PATCH",
      body: {
        artifactRetentionDays: 90,
        operationalEventRetentionDays: 30,
        runtimeTraceRetentionDays: 14,
        chatMessageRetentionDays: 90,
        runPayloadRetentionDays: 90,
        auditActionRetentionDays: 365,
        confirm: true,
      },
    });
    await allocatorClient.request("/tools/policy", {
      method: "POST",
      body: { toolName: "resource-allocator.allocate", mutationEnabled: true },
    });
    type AllocationCycle = {
      report: { outcome: string; allocated: number; settled: string[]; proposalId?: string };
    };
    const cycle = (demand: number) =>
      allocatorClient.request<AllocationCycle>("/workbench/workflows/resource-allocator.cycle", {
        method: "POST",
        body: { executionMode: "dry_run", input: { pool: "primary", demand } },
      });
    const quiet = await cycle(1);
    const escalated = await cycle(10);
    if (quiet.report.outcome !== "noop" || escalated.report.outcome !== "escalated")
      throw new Error(
        `Allocator did not no-op then escalate: ${JSON.stringify([quiet, escalated])}`,
      );
    const proposalId = escalated.report.proposalId!;
    if ((await cycle(10)).report.outcome !== "no_change")
      throw new Error("A repeated observation proposed again");
    const execution = await allocatorClient.admin.requestAction(proposalId);
    const approvedAllocation = await allocatorClient.request<{
      approvalRequest: { status: string };
    }>(`/tools/approvals/${encodeURIComponent(execution.approvalRequest.id)}/approve`, {
      method: "POST",
    });
    if (approvedAllocation.approvalRequest.status !== "approved")
      throw new Error("Allocation approval did not complete");
    const settledCycle = await cycle(10);
    if (
      settledCycle.report.settled.join() !== proposalId ||
      settledCycle.report.allocated !== 5 ||
      settledCycle.report.outcome !== "escalated"
    )
      throw new Error(`Approved allocation was not projected: ${JSON.stringify(settledCycle)}`);
    if ((await cycle(10)).report.settled.length)
      throw new Error("Replaying the cycle projected an allocation twice");
    const overview = await allocatorClient.queries.run<{
      pools: { pool: string; available: number }[];
      requests: { id: string; status: string }[];
    }>("resource-allocator.overview");
    const ledger = (
      await allocatorClient.state.entries({ target: "simulation", type: "effect" })
    ).entries.filter((entry) => entry.data.proposalId === proposalId);
    if (
      overview.output.pools.find((item) => item.pool === "primary")?.available !== 15 ||
      overview.output.requests.find((item) => item.id === proposalId)?.status !== "allocated" ||
      ledger.length !== 1
    )
      throw new Error(`Allocator ledger or query drifted: ${JSON.stringify({ overview, ledger })}`);
    const reviewEvidence = await reviewerClient.context.snapshot(firstReview.report.snapshotId);
    if (
      reviewEvidence.snapshot.status !== "ready" ||
      reviewEvidence.snapshot.sources[0]?.trust !== "untrusted"
    )
      throw new Error("Review evidence lost readiness or trust classification");
    let contextBlocked = false;
    try {
      await reviewerClient.request("/workbench/workflows/document-review.review", {
        method: "POST",
        body: { input: { documentId: "missing" }, executionMode: "dry_run" },
      });
    } catch (error) {
      contextBlocked =
        (error as { status: number; code: string }).status === 409 &&
        (error as { code: string }).code === "context_blocked";
    }
    if (!contextBlocked) throw new Error("Missing required evidence did not block the workflow");
    const simulated = await reviewerClient.request<{
      report: { target: string; effectId: string; receiptId: string; wordCount: number };
    }>("/workbench/workflows/document-review.simulate", {
      method: "POST",
      body: {
        executionMode: "dry_run",
        input: { documentId: "simulated-request", text: "A simulated review" },
      },
    });
    if (
      simulated.report.target !== "simulation" ||
      simulated.report.wordCount !== 3 ||
      !simulated.report.receiptId
    )
      throw new Error("Request simulation did not return its committed receipt");
    const submitSimulation = () =>
      reviewerClient.request<{ run: { id: string } }>(
        "/workbench/workflows/document-review.simulate",
        {
          method: "POST",
          idempotencyKey: "durable-simulation",
          body: {
            execution: "durable",
            executionMode: "dry_run",
            input: { documentId: "simulated-durable", text: "A durable simulated review" },
          },
        },
      );
    const simulationRun = await submitSimulation();
    const simulationDeadline = Date.now() + 30000;
    while (true) {
      const result = await reviewerClient.request<{ snapshot: { run: { status: string } } }>(
        `/workbench/history/runs/${simulationRun.run.id}`,
      );
      if (result.snapshot.run.status === "completed") break;
      if (
        ["failed", "blocked", "cancelled"].includes(result.snapshot.run.status) ||
        Date.now() > simulationDeadline
      )
        throw new Error(`Durable simulation failed: ${JSON.stringify(result)} ${logs}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    if ((await submitSimulation()).run.id !== simulationRun.run.id)
      throw new Error("Simulation submission replay changed its run identity");
    const simulatedEffects = await reviewerClient.state.entries({
      target: "simulation",
      type: "effect",
    });
    const reviewEffects = simulatedEffects.entries.filter(
      (entry) => entry.data.workflow === "document-review.simulate",
    );
    if (
      reviewEffects.length !== 2 ||
      !reviewEffects.some((entry) => entry.data.runId === simulationRun.run.id)
    )
      throw new Error("Simulation lost or duplicated its immutable effects");
    if (
      (
        await reviewerClient.state.records({
          target: "external",
          namespace: "documents",
          kind: "review",
        })
      ).records.length
    )
      throw new Error("Simulation mutated external state");
    const submitDurable = (text = "A durable document review.") =>
      reviewerClient.request<{ accepted: boolean; run: { id: string } }>(
        "/workbench/workflows/document-review.review",
        {
          method: "POST",
          idempotencyKey: "durable-review",
          body: {
            execution: "durable",
            executionMode: "dry_run",
            input: {
              documentId: "durable-guide",
              text,
              delayMs: process.argv.includes("--durable-restart") ? 10000 : 1000,
            },
          },
        },
      );
    const durable = await submitDurable(),
      duplicateDurable = await submitDurable();
    if (
      !durable.accepted ||
      duplicateDurable.accepted ||
      durable.run.id !== duplicateDurable.run.id
    )
      throw new Error("Durable submission identity was not stable");
    let durableConflict = false;
    try {
      await submitDurable("Changed input");
    } catch (error) {
      durableConflict = (error as { status: number }).status === 409;
    }
    if (!durableConflict) throw new Error("Changed durable submission did not conflict");
    if (process.argv.includes("--durable-restart")) {
      const files = readdirSync(state, { recursive: true }).filter(
        (file): file is string => typeof file === "string",
      );
      const filename = files.find(
        (file) => file.includes("miniflare-D1DatabaseObject") && file.endsWith(".sqlite"),
      );
      if (!filename) throw new Error("Local canonical D1 database was not found");
      const db = new DatabaseSync(resolve(state, filename), { readOnly: true });
      try {
        const readyBy = Date.now() + 10000;
        while (
          !db
            .prepare(
              "SELECT 1 FROM control_durable_steps WHERE run_id=? AND step_key='wait:before-recording' AND status='completed'",
            )
            .get(durable.run.id)
        ) {
          if (Date.now() > readyBy)
            throw new Error("Durable workflow did not enter its persisted wait");
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        if (
          db
            .prepare("SELECT 1 FROM control_durable_steps WHERE run_id=? AND step_key='record'")
            .get(durable.run.id)
        )
          throw new Error("Restart drill missed the wait interval");
      } finally {
        db.close();
      }
      worker.stop("Exercise durable workflow restart during its wait");
      await worker.completion;
      worker = observeWorker(startWorker());
      const readyBy = Date.now() + 15000;
      while (true) {
        try {
          if ((await fetch(`${baseUrl}/health/live`)).ok) break;
        } catch {}
        if (Date.now() > readyBy) throw new Error(`Worker restart failed: ${logs}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      }
    }
    if (process.argv.includes("--local-engine-wake")) {
      if (!process.argv.includes("--durable-restart"))
        throw new Error("Local engine wake is only valid with the restart drill");
      const wake = startManagedProcess(
        "pnpm",
        [
          "exec",
          "wrangler",
          "workflows",
          "instances",
          "send-event",
          "operloom-local-durable",
          durable.run.id,
          "--local",
          "--port",
          String(port),
          "--type",
          "operloom.test.wake",
          "--payload",
          "{}",
          "--config",
          standalone?.config ?? "cloudflare/control-plane/wrangler.jsonc",
        ],
        { label: "workflow-local-replay-wake", cwd: runtimeRoot, stdio: "pipe", maxRssMb: 1024 },
      );
      wake.child.stdout?.on("data", () => undefined);
      wake.child.stderr?.on("data", (chunk) => {
        logs = (logs + String(chunk)).slice(-10000);
      });
      const result = await wake.completion;
      if (result.code !== 0 || result.reason) throw new Error(`Local engine wake failed: ${logs}`);
    }
    const durableDeadline = Date.now() + 45000;
    while (true) {
      const result = await reviewerClient.request<{ snapshot: { run: { status: string } } }>(
        `/workbench/history/runs/${durable.run.id}`,
      );
      if (result.snapshot.run.status === "completed") break;
      if (
        ["failed", "blocked", "cancelled"].includes(result.snapshot.run.status) ||
        Date.now() > durableDeadline
      )
        throw new Error(`Durable workflow failed to complete: ${JSON.stringify(result)} ${logs}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    if (process.argv.includes("--durable-restart")) {
      const file = readdirSync(state, { recursive: true }).find(
        (file) =>
          typeof file === "string" &&
          file.includes("miniflare-D1DatabaseObject") &&
          file.endsWith(".sqlite"),
      );
      const db = new DatabaseSync(resolve(state, String(file)), { readOnly: true });
      try {
        const attempts = db
          .prepare(
            "SELECT step_key,attempt_count,status FROM control_durable_steps WHERE run_id=? ORDER BY step_key",
          )
          .all(durable.run.id);
        if (
          attempts.length !== 3 ||
          attempts.some((row) => row.attempt_count !== 1 || row.status !== "completed")
        )
          throw new Error(`Restart repeated completed work: ${JSON.stringify(attempts)}`);
      } finally {
        db.close();
      }
    }
    const contextPage = await reviewerClient.context.list({
      runId: durable.run.id,
      runKind: "workflow",
      limit: 1,
    });
    const laterCaptures = await reviewerClient.context.list({
      runId: durable.run.id,
      runKind: "workflow",
      afterRevision: contextPage.nextAfterRevision,
    });
    const captures = [...contextPage.snapshots, ...laterCaptures.snapshots];
    if (
      captures.length !== 3 ||
      captures.some((capture, index) => capture.revision !== index || !capture.stepId)
    )
      throw new Error("Durable context captures were not independently revisioned and paginated");
    const beforeWait = await reviewerClient.context.snapshot(captures[0]!.id);
    const afterWait = await reviewerClient.context.snapshot(captures[2]!.id);
    if (
      beforeWait.snapshot.id === afterWait.snapshot.id ||
      beforeWait.snapshot.contentHash !== afterWait.snapshot.contentHash
    )
      throw new Error(
        "Resumed context did not preserve original evidence and recapture unchanged input",
      );
    const durableDecisions = await reviewerClient.state.entries({
      target: "simulation",
      type: "decision",
    });
    const durableDecision = durableDecisions.entries.find(
      (entry) => entry.data.observationSnapshotId === beforeWait.snapshot.id,
    );
    if (durableDecision?.data.snapshotId !== afterWait.snapshot.id)
      throw new Error("Decision did not retain both observation and resumed evidence identities");
    const durableState = await reviewerClient.state.records({
      target: "simulation",
      namespace: "documents",
      kind: "review",
    });
    if (
      !durableState.records.some(
        (record) =>
          record.key === "durable-guide" && record.version === 1 && record.data.wordCount === 4,
      )
    )
      throw new Error("Durable workflow did not commit its canonical result");
    const replayResponse = await fetch(
      `${baseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(reviewer.agent.id)}/workbench/workflows/document-review.review`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": "durable-review",
        },
        body: JSON.stringify({
          execution: "durable",
          executionMode: "dry_run",
          input: {
            documentId: "durable-guide",
            text: "A durable document review.",
            delayMs: process.argv.includes("--durable-restart") ? 10000 : 1000,
          },
        }),
      },
    );
    if (replayResponse.status !== 202)
      throw new Error("Durable command did not use asynchronous HTTP acceptance");
    const cancelled = await reviewerClient.request<{ run: { id: string } }>(
      "/workbench/workflows/document-review.review",
      {
        method: "POST",
        idempotencyKey: "durable-cancel",
        body: {
          execution: "durable",
          input: {
            documentId: "cancelled-guide",
            text: "Do not publish this review",
            delayMs: 10000,
          },
        },
      },
    );
    const canonicalFile = readdirSync(state, { recursive: true }).find(
      (file) =>
        typeof file === "string" &&
        file.includes("miniflare-D1DatabaseObject") &&
        file.endsWith(".sqlite") &&
        !file.endsWith("metadata.sqlite"),
    );
    const canonicalDb = new DatabaseSync(resolve(state, String(canonicalFile)), { readOnly: true });
    try {
      const waitBy = Date.now() + 10000;
      while (
        !canonicalDb
          .prepare(
            "SELECT 1 FROM control_durable_steps WHERE run_id=? AND step_key='wait:before-recording' AND status='completed'",
          )
          .get(cancelled.run.id)
      ) {
        if (Date.now() > waitBy)
          throw new Error("Cancellation drill did not reach its durable wait");
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      await reviewerClient.request(`/workbench/history/runs/${cancelled.run.id}/cancel`, {
        method: "POST",
      });
      // Miniflare's native dispatch works without re-bundling the standalone artifact to inject /__scheduled middleware.
      const recoveryResponse = await fetch(`http://127.0.0.1:${port}/cdn-cgi/handler/scheduled`);
      if (!recoveryResponse.ok)
        throw new Error(
          `Durable recovery scheduler invocation failed (HTTP ${recoveryResponse.status}): ${(await recoveryResponse.text()).slice(0, 200)}`,
        );
      const recoveryBy = Date.now() + 10000;
      while (
        !canonicalDb
          .prepare(
            "SELECT 1 FROM control_durable_executions WHERE run_id=? AND recovery_engine_status IS NOT NULL AND recovery_lease_id IS NULL",
          )
          .get(cancelled.run.id)
      ) {
        if (Date.now() > recoveryBy)
          throw new Error("Cancelled durable run was not inspected by recovery");
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      // Read the actual native instance. A canonical cancellation alone does not prove engine termination.
      const native = startManagedProcess(
        "pnpm",
        [
          "exec",
          "wrangler",
          "workflows",
          "instances",
          "describe",
          "operloom-local-durable",
          cancelled.run.id,
          "--local",
          "--port",
          String(port),
          "--config",
          standalone?.config ?? "cloudflare/control-plane/wrangler.jsonc",
        ],
        {
          label: "workflow-local-termination-check",
          cwd: runtimeRoot,
          stdio: "pipe",
          maxRssMb: 1024,
        },
      );
      let nativeStatus = "";
      native.child.stdout?.on("data", (chunk) => {
        nativeStatus += String(chunk);
      });
      native.child.stderr?.on("data", (chunk) => {
        logs = (logs + String(chunk)).slice(-10000);
      });
      const nativeResult = await native.completion;
      if (nativeResult.code !== 0 || nativeResult.reason || !/terminated/i.test(nativeStatus))
        throw new Error("Recovery did not terminate the native workflow instance");
      if (
        canonicalDb
          .prepare("SELECT 1 FROM control_durable_steps WHERE run_id=? AND step_key='record'")
          .get(cancelled.run.id)
      )
        throw new Error("Cancelled workflow resumed a future effect step");
      if (
        canonicalDb.prepare("SELECT status FROM control_runs WHERE id=?").get(cancelled.run.id)
          ?.status !== "cancelled"
      )
        throw new Error("Durable cancellation was overwritten");
    } finally {
      canonicalDb.close();
    }
    const submitReviewGate = (documentId: string) =>
      reviewerClient.request<{ run: { id: string } }>(
        "/workbench/workflows/document-review.review",
        {
          method: "POST",
          idempotencyKey: `approval-${documentId}`,
          body: {
            execution: "durable",
            executionMode: "dry_run",
            input: {
              documentId,
              text: "A document awaiting a recorded human review.",
              delayMs: 1,
              requireApproval: true,
            },
          },
        },
      );
    const awaitReviewGate = async (runId: string) => {
      const deadline = Date.now() + 15000;
      while (true) {
        const result = await reviewerClient.request<{
          approvals: {
            id: string;
            runId: string;
            status: string;
            review: { requestHash: string; payload: Record<string, unknown>; expiresAt: string };
            data: { requestHash: string; payload: Record<string, unknown> };
          }[];
        }>("/tools/approvals");
        const approval = result.approvals.find(
          (row) => row.runId === runId && row.status === "requested",
        );
        if (approval) return approval;
        if (Date.now() > deadline)
          throw new Error(`Durable review request did not appear: ${logs}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    };
    const reviewGateRun = await submitReviewGate("approved-document");
    const reviewGate = await awaitReviewGate(reviewGateRun.run.id);
    {
      const database = new DatabaseSync(resolve(state, String(canonicalFile)));
      const deploymentId = "conformance-deployment";
      try {
        const handler = database
          .prepare(`SELECT pack_id,pack_version,workflow_type,workflow_version,runtime_version,definition_hash
          FROM control_durable_executions WHERE run_id=?`)
          .get(reviewGateRun.run.id)!;
        const probe = async (pins: unknown[]) => {
          const response = await fetch(`${baseUrl}/__operloom/durable-deployment-probe`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(pins),
          });
          if (!response.ok) throw new Error("Native deployment probe failed");
          return (await response.json()) as { results: { ok: boolean }[] };
        };
        if (
          !(await probe([handler])).results[0]?.ok ||
          (await probe([{ ...handler, definition_hash: "incompatible" }])).results[0]?.ok
        )
          throw new Error("Native deployment probe did not enforce persisted handler pins");
        database
          .prepare(
            "INSERT INTO control_durable_deployment_fence (singleton,deployment_id,artifact_sha256,acquired_at) VALUES (1,?,?,?)",
          )
          .run(deploymentId, "a".repeat(64), new Date().toISOString());
        let fenced = false;
        try {
          await submitReviewGate("deployment-fenced-document");
        } catch (error) {
          fenced = (error as { code?: string }).code === "durable_deployment_in_progress";
        }
        if (!fenced) throw new Error("Deployment fence did not reject a native durable submission");
        if (
          database
            .prepare(
              "SELECT 1 FROM control_durable_executions WHERE input_json LIKE '%deployment-fenced-document%'",
            )
            .get()
        )
          throw new Error("Fenced admission left execution state");
        database
          .prepare(
            "UPDATE control_durable_deployment_fence SET activate_on_release=1 WHERE deployment_id=?",
          )
          .run(deploymentId);
        let staleWorker = false;
        try {
          await submitReviewGate("stale-deployment-document");
        } catch (error) {
          staleWorker = (error as { code?: string }).code === "durable_deployment_changed";
        }
        if (
          !staleWorker ||
          database.prepare("SELECT 1 FROM control_durable_deployment_fence").get()
        )
          throw new Error("Native deployment activation did not atomically fence the stale Worker");
      } finally {
        database
          .prepare("DELETE FROM control_durable_deployment_fence WHERE deployment_id=?")
          .run(deploymentId);
        database
          .prepare("DELETE FROM control_durable_deployment_generation WHERE deployment_id=?")
          .run(deploymentId);
        database.close();
      }
      console.log(
        "Native deployment gate passed: candidate hash compatibility, atomic admission fencing and stale Worker rejection after activation.",
      );
    }
    if (!reviewGate.data.requestHash || reviewGate.data.payload.documentId !== "approved-document")
      throw new Error("Approval lacks its bound review payload");
    if (
      reviewGate.review?.requestHash !== reviewGate.data.requestHash ||
      reviewGate.review.payload.documentId !== "approved-document" ||
      !Number.isFinite(Date.parse(reviewGate.review.expiresAt))
    )
      throw new Error("Approval lacks its portable review descriptor");
    const reviewSnapshot = await reviewerClient.request<{
      snapshot: { interventions: { id: string; review?: { requestHash: string } }[] };
    }>(`/workbench/history/runs/${reviewGateRun.run.id}`);
    if (
      reviewSnapshot.snapshot.interventions.find((item) => item.id === reviewGate.id)?.review
        ?.requestHash !== reviewGate.review.requestHash
    )
      throw new Error("History and approval list disagree on review content");
    if (process.argv.includes("--durable-restart")) {
      const db = new DatabaseSync(resolve(state, String(canonicalFile)), { readOnly: true });
      try {
        if (
          !db
            .prepare(
              "SELECT 1 FROM control_durable_engine_dispatches WHERE run_id=? AND status='accepted'",
            )
            .get(reviewGateRun.run.id)
        )
          throw new Error("Approval restart must occur after acknowledged creation");
      } finally {
        db.close();
      }
      worker.stop("Exercise durable approval pause across process restart");
      await worker.completion;
      worker = observeWorker(startWorker());
      const readyBy = Date.now() + 15000;
      while (true) {
        try {
          if ((await fetch(`${baseUrl}/health/live`)).ok) break;
        } catch {}
        if (Date.now() > readyBy) throw new Error(`Approval restart failed: ${logs}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      }
      if ((await awaitReviewGate(reviewGateRun.run.id)).id !== reviewGate.id)
        throw new Error("Restart changed the approval identity");
    }
    await reviewerClient.request(`/tools/approvals/${reviewGate.id}/approve`, { method: "POST" });
    const approvedBy = Date.now() + 15000;
    while (true) {
      const result = await reviewerClient.request<{ snapshot: { run: { status: string } } }>(
        `/workbench/history/runs/${reviewGateRun.run.id}`,
      );
      if (result.snapshot.run.status === "completed") break;
      if (
        ["failed", "blocked", "cancelled"].includes(result.snapshot.run.status) ||
        Date.now() > approvedBy
      )
        throw new Error(`Approved workflow failed to resume: ${JSON.stringify(result)} ${logs}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    const reviewDb = new DatabaseSync(resolve(state, String(canonicalFile)), { readOnly: true });
    try {
      const approval = reviewDb
        .prepare("SELECT request_hash,consumed_at FROM control_durable_approvals WHERE id=?")
        .get(reviewGate.id);
      if (!approval?.consumed_at || approval.request_hash !== reviewGate.data.requestHash)
        throw new Error("Approval consumption lost its binding");
      const decision = reviewDb
        .prepare(
          "SELECT data_json FROM control_state_entries WHERE entry_key=? AND type='decision'",
        )
        .get(`${reviewGateRun.run.id}.review`);
      if (!decision || JSON.parse(String(decision.data_json)).approvalId !== reviewGate.id)
        throw new Error("Document outcome omitted its approval evidence");
    } finally {
      reviewDb.close();
    }
    const deniedGateRun = await submitReviewGate("denied-document");
    const deniedGate = await awaitReviewGate(deniedGateRun.run.id);
    await reviewerClient.request(`/tools/approvals/${deniedGate.id}/deny`, {
      method: "POST",
      body: { reason: "Do not record this review." },
    });
    const deniedRun = await reviewerClient.request<{ snapshot: { run: { status: string } } }>(
      `/workbench/history/runs/${deniedGateRun.run.id}`,
    );
    if (deniedRun.snapshot.run.status !== "cancelled")
      throw new Error("Denied review retained execution authority");
    console.log(
      "Durable approval journey passed: immutable review, public approval/denial, native wake, resumed decision linkage and cancellation.",
    );
    const monitor = await reviewerClient.request<{ trigger: { id: string; version: number } }>(
      "/triggers",
      {
        method: "POST",
        body: {
          packId: "document-review",
          packTriggerId: "document-monitor",
          execution: "durable",
          status: "enabled",
          input: {
            documentId: "scheduled-document",
            text: "Scheduled document evidence.",
            delayMs: 1,
          },
        },
      },
    );
    const scheduleDb = new DatabaseSync(resolve(state, String(canonicalFile)));
    try {
      scheduleDb
        .prepare("UPDATE control_triggers SET next_trigger_at=? WHERE id=?")
        .run(new Date(Date.now() - 1000).toISOString(), monitor.trigger.id);
    } finally {
      scheduleDb.close();
    }
    if (!(await fetch(`${baseUrl}/cdn-cgi/handler/scheduled`)).ok)
      throw new Error("Scheduled trigger tick failed");
    const awaitDispatch = async (triggerId: string, status: string) => {
      const deadline = Date.now() + 15000;
      while (true) {
        const response = await reviewerClient.request<{
          dispatches: { id: string; triggerId: string; status: string; runId?: string }[];
        }>(`/trigger-dispatches?triggerId=${triggerId}`);
        const dispatch = response.dispatches.find(
          (item) => item.triggerId === triggerId && item.status === status,
        );
        if (dispatch?.runId) return { ...dispatch, runId: dispatch.runId };
        if (Date.now() > deadline)
          throw new Error(
            `Durable trigger did not reach ${status}: ${JSON.stringify(response)} ${logs}`,
          );
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    };
    const monitorDispatch = await awaitDispatch(monitor.trigger.id, "completed");
    const monitorCurrent = await reviewerClient.request<{ trigger: { version: number } }>(
      `/triggers/${monitor.trigger.id}`,
    );
    await reviewerClient.request(`/triggers/${monitor.trigger.id}`, {
      method: "PATCH",
      body: { expectedVersion: monitorCurrent.trigger.version, status: "paused" },
    });
    const webhook = await reviewerClient.request<{
      trigger: { id: string; publicId: string; version: number };
      webhookSecret: string;
    }>("/triggers", {
      method: "POST",
      body: {
        packId: "document-review",
        packTriggerId: "document-updated",
        execution: "durable",
        status: "enabled",
        input: {
          documentId: "webhook-document",
          text: "Webhook evidence.",
          delayMs: 1,
          requireApproval: true,
        },
      },
    });
    const deliverWebhook = (text = "Webhook evidence.") =>
      fetch(`${baseUrl}/trigger-ingress/${webhook.trigger.publicId}`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": "document-event-1",
          "x-operloom-trigger-secret": webhook.webhookSecret,
        },
        body: JSON.stringify({ text }),
      });
    const firstWebhook = await deliverWebhook();
    if (firstWebhook.status !== 202)
      throw new Error(`Webhook admission failed (${firstWebhook.status})`);
    const firstWebhookBody = (await firstWebhook.json()) as { dispatchId: string };
    const duplicateWebhook = await deliverWebhook();
    const duplicateWebhookBody = (await duplicateWebhook.json()) as { dispatchId: string };
    if (
      duplicateWebhook.status !== 200 ||
      duplicateWebhookBody.dispatchId !== firstWebhookBody.dispatchId
    )
      throw new Error("Duplicate webhook lost logical event identity");
    if ((await deliverWebhook("Changed content.")).status !== 409)
      throw new Error("Changed webhook payload did not conflict");
    const webhookDispatch = await awaitDispatch(webhook.trigger.id, "running");
    await awaitReviewGate(webhookDispatch.runId);
    await reviewerClient.request(`/triggers/${webhook.trigger.id}`, {
      method: "PATCH",
      body: { expectedVersion: webhook.trigger.version, status: "paused" },
    });
    if ((await awaitDispatch(webhook.trigger.id, "cancelled")).runId !== webhookDispatch.runId)
      throw new Error("Pausing the trigger changed run identity");
    const triggerDb = new DatabaseSync(resolve(state, String(canonicalFile)), { readOnly: true });
    try {
      for (const dispatch of [monitorDispatch, webhookDispatch]) {
        if (
          triggerDb
            .prepare(
              "SELECT COUNT(*) n FROM control_durable_trigger_links WHERE dispatch_id=? AND run_id=?",
            )
            .get(dispatch.id, dispatch.runId)?.n !== 1
        )
          throw new Error("Trigger dispatch does not identify exactly one durable run");
      }
      if (
        triggerDb
          .prepare("SELECT COUNT(*) n FROM control_state_entries WHERE entry_key=?")
          .get(`${webhookDispatch.runId}.review`)?.n !== 0
      )
        throw new Error("Paused trigger published an unapproved effect");
    } finally {
      triggerDb.close();
    }
    console.log(
      "Durable trigger journey passed: native scheduled execution, authenticated webhook deduplication/conflict, one run per event, and pause revocation during approval.",
    );
    const reviewThread = await reviewerClient.threads.create();
    const reviewTurn = await reviewerClient.threads.submit(
      reviewThread.threadId,
      "Document text from a chat turn.",
      "context-chat",
    );
    if (!reviewTurn.commandId) throw new Error("Context chat command has no durable identity");
    const reviewDeadline = Date.now() + 15000;
    let reviewCommand = (await reviewerClient.threads.command(reviewTurn.commandId)).command;
    while (reviewCommand.status === "pending" || reviewCommand.status === "running") {
      if (Date.now() > reviewDeadline) throw new Error("Document chat command did not finish");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      reviewCommand = (await reviewerClient.threads.command(reviewTurn.commandId)).command;
    }
    if (reviewCommand.status !== "completed" || !reviewCommand.runId)
      throw new Error(`Context chat failed: ${JSON.stringify(reviewCommand)} ${logs}`);
    const contextId = `context-${createHash("sha256")
      .update(
        JSON.stringify([
          "operloom-local",
          workspaceId,
          reviewer.agent.id,
          "chat",
          reviewCommand.runId,
        ]),
      )
      .digest("hex")}`;
    const chatEvidence = await reviewerClient.context.snapshot(contextId);
    if (
      chatEvidence.snapshot.runKind !== "chat" ||
      chatEvidence.snapshot.sources[0]?.data?.text !== "Document text from a chat turn."
    )
      throw new Error("Chat did not capture the same scoped document evidence");
    // Persist a deterministic state fixture in this disposable database. This verifies
    // operator transport/lifecycle, while runtime-state tests exercise actual commit atomicity.
    const scopeId = createHash("sha256")
      .update(
        JSON.stringify([
          "operloom-local",
          workspaceId,
          operator.agent.id,
          "complex-operator",
          "simulation",
        ]),
      )
      .digest("hex");
    const sqlValue = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const fixtureScope = ["operloom-local", workspaceId, operator.agent.id, scopeId]
      .map(sqlValue)
      .join(",");
    const stateFixture = resolve(state, "operator-state.sql");
    const migrationPlan = JSON.stringify({
      migration: {
        id: "capacity-v2",
        namespace: "capacity",
        kind: "pool",
        fromVersion: 1,
        toVersion: 2,
        operations: [{ op: "rename", from: "remaining", to: "available" }],
      },
      definitions: [
        { version: 1, field: "remaining" },
        { version: 2, field: "available" },
      ].map(({ version, field }) => ({
        namespace: "capacity",
        kind: "pool",
        schemaVersion: version,
        schema: {
          type: "object",
          properties: { [field]: { type: "integer" } },
          required: [field],
          additionalProperties: false,
        },
        indexes: [{ name: field, field }],
      })),
    });
    writeFileSync(
      stateFixture,
      `UPDATE agents SET data_json = json_set(data_json, '$.behavior.pack.version', '0.0.1', '$.behavior.version', '0.0.1', '$.behavior.authoring.packVersion', '0.0.1') WHERE id = ${sqlValue(agentId)};
      UPDATE agents SET runtime_revision = 1 WHERE id = ${sqlValue(operator.agent.id)};
      INSERT INTO control_state_records
      (id,user_id,workspace_id,agent_id,scope_id,namespace,kind,record_key,schema_version,version,data_json,updated_at)
      VALUES ('conformance-record',${fixtureScope},'capacity','pool','main',1,1,'{"remaining":5}','2026-01-01T00:00:00Z');
      INSERT INTO control_state_entries
      (id,user_id,workspace_id,agent_id,scope_id,entry_key,commit_id,type,data_json,created_at)
      VALUES ('conformance-entry',${fixtureScope},'observe','conformance-commit','decision','{"outcome":"no_change"}','2026-01-01T00:00:00Z');
      INSERT INTO control_state_outbox
      (id,user_id,workspace_id,agent_id,scope_id,event_key,commit_id,type,data_json,status,attempts,created_at)
      VALUES ('conformance-delivery',${fixtureScope},'observed','conformance-commit','capacity.observed','{}','failed',8,'2026-01-01T00:00:00Z');
      INSERT INTO control_state_migrations
      (id,user_id,workspace_id,agent_id,scope_id,migration_key,plan_hash,plan_json,namespace,kind,from_version,to_version,status,created_at,updated_at,preconditions_met)
      VALUES ('conformance-migration',${fixtureScope},'capacity-v2',${sqlValue(createHash("sha256").update(migrationPlan).digest("hex"))},${sqlValue(migrationPlan)},'capacity','pool',1,2,'running','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1);
      INSERT INTO control_state_schema_heads
      (user_id,workspace_id,agent_id,scope_id,namespace,kind,schema_version,status,migration_id)
      VALUES (${fixtureScope},'capacity','pool',1,'migrating','conformance-migration');`,
    );
    const seed = startManagedProcess(
      "pnpm",
      ["exec", "wrangler", "d1", "execute", "operloom_local", ...common, "--file", stateFixture],
      { label: "runtime-state-fixture", cwd: runtimeRoot, stdio: "pipe", maxRssMb: 1536 },
    );
    seed.child.stdout?.resume();
    seed.child.stderr?.resume();
    const seeded = await seed.completion;
    if (seeded.code !== 0 || seeded.reason) throw new Error("Operator state fixture failed");
    const versions = await client.packages.snapshots();
    if (versions.currentVersion !== "0.0.1" || !versions.availableVersion)
      throw new Error("Legacy package fixture was not observable");
    const upgradeInput = {
      targetVersion: versions.availableVersion,
      expectedRevision: 0,
      idempotencyKey: "headless-upgrade",
    };
    const upgraded = await client.packages.upgrade(upgradeInput);
    if (JSON.stringify(await client.packages.upgrade(upgradeInput)) !== JSON.stringify(upgraded))
      throw new Error("Upgrade replay changed receipt");
    const snapshots = await client.packages.snapshots();
    if (
      snapshots.currentRevision !== 1 ||
      snapshots.snapshots.length !== 2 ||
      snapshots.snapshots[1]?.packVersion !== "0.0.1"
    )
      throw new Error("Upgrade lost snapshot history");
    const stateQuery = { target: "simulation" as const, namespace: "capacity", kind: "pool" };
    let stateRecords = await operatorClient.state.records(stateQuery);
    if (stateRecords.records[0]?.data.remaining !== 5)
      throw new Error("Canonical state was not readable");
    const migrating = await operatorClient.state.migrations({ target: "simulation" });
    if (migrating.migrations[0]?.status !== "running")
      throw new Error("Persisted migration was not observable");
    const advanced = await operatorClient.state.advanceMigration("capacity-v2", {
      target: "simulation",
      expectedRevision: 0,
    });
    const replayedMigration = await operatorClient.state.advanceMigration("capacity-v2", {
      target: "simulation",
      expectedRevision: 0,
    });
    if (
      advanced.migration.status !== "completed" ||
      JSON.stringify(advanced) !== JSON.stringify(replayedMigration)
    )
      throw new Error("Persisted migration did not resume with stable replay receipts");
    stateRecords = await operatorClient.state.records(stateQuery);
    if (
      stateRecords.records[0]?.schemaVersion !== 2 ||
      stateRecords.records[0]?.version !== 2 ||
      stateRecords.records[0]?.data.available !== 5
    )
      throw new Error(
        "Migration did not preserve state while advancing schema and record versions",
      );
    if ((await operatorClient.state.records({ ...stateQuery, target: "external" })).records.length)
      throw new Error("Simulation state leaked into the external scope");
    if (
      (await operatorClient.state.entries({ target: "simulation", type: "decision" })).entries[0]
        ?.data.outcome !== "no_change"
    )
      throw new Error("Canonical decision was not readable");
    const failedDelivery = (
      await operatorClient.state.deliveries({ target: "simulation", status: "failed" })
    ).deliveries[0];
    if (!failedDelivery || failedDelivery.attempts !== 8)
      throw new Error("Failed delivery was not observable");
    await operatorClient.state.retryDelivery(failedDelivery.id, {
      target: "simulation",
      expectedAttempts: failedDelivery.attempts,
    });
    if (
      (await operatorClient.state.deliveries({ target: "simulation", status: "pending" }))
        .deliveries[0]?.id !== failedDelivery.id
    )
      throw new Error("Retry changed delivery identity");
    await operatorClient.request("/tools/policy", {
      method: "POST",
      body: { toolName: "operator.signal.read", requiresApproval: true },
    });
    let approvalRequired = false;
    try {
      await operatorClient.request("/tools/runs", {
        method: "POST",
        body: { toolName: "operator.signal.read", input: {} },
      });
    } catch (error) {
      approvalRequired = (error as { status: number }).status === 403;
    }
    if (!approvalRequired) throw new Error("Tool bypassed required approval");
    const approvals = await operatorClient.request<{ approvals: { id: string; status: string }[] }>(
      "/tools/approvals",
    );
    const approval = approvals.approvals.find((item) => item.status === "requested");
    if (!approval) throw new Error("No durable approval was observable through the API");
    const approved = await operatorClient.request<{
      run: { runId: string; status: string };
      approvalRequest: { status: string };
    }>(`/tools/approvals/${encodeURIComponent(approval.id)}/approve`, { method: "POST" });
    if (approved.approvalRequest.status !== "approved" || approved.run.status !== "completed")
      throw new Error("Headless approval did not complete the deterministic tool");
    const run = await operatorClient.request<{ snapshot: { run: { status: string } } }>(
      `/workbench/history/runs/${encodeURIComponent(approved.run.runId)}`,
    );
    if (run.snapshot.run.status !== "completed")
      throw new Error("Approved run was not canonical in history");
    const exportResult = await client.admin.export();
    if (exportResult.ok !== true) throw new Error("Workspace export was not accepted");
    const exportId = (exportResult.job as { id: string }).id;
    const exportFinishedBy = Date.now() + 20_000;
    while (true) {
      const result = await client.request<{ job: { status: string; error?: unknown } }>(
        `/workbench/data-exports/${encodeURIComponent(exportId)}`,
      );
      if (result.job.status === "completed") break;
      if (result.job.status === "failed" || Date.now() > exportFinishedBy)
        throw new Error(`Export did not complete: ${JSON.stringify(result.job)} ${logs}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    const download = await fetch(
      `${baseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/workbench/data-exports/${encodeURIComponent(exportId)}/download`,
      { headers },
    );
    if (!download.ok || !download.headers.get("content-type")?.includes("application/zip"))
      throw new Error("Completed export was not downloadable");
    const archive = new Uint8Array(await download.arrayBuffer());
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", archive)).toString("hex");
    if (digest !== download.headers.get("x-content-sha256"))
      throw new Error("Export checksum differs from durable evidence");
    // Independently inspect the stored ZIP rather than checking only its checksum.
    const zip = Buffer.from(archive);
    const exportedCollections = new Map<string, Record<string, unknown>[]>();
    for (let offset = 0; zip.readUInt32LE(offset) === 0x04034b50; ) {
      if (zip.readUInt16LE(offset + 8) !== 0) throw new Error("Unexpected compressed export entry");
      const size = zip.readUInt32LE(offset + 18);
      const nameLength = zip.readUInt16LE(offset + 26),
        extraLength = zip.readUInt16LE(offset + 28);
      const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
      const start = offset + 30 + nameLength + extraLength;
      if (name.startsWith("d1/") && name.endsWith(".ndjson")) {
        const body = zip.subarray(start, start + size).toString("utf8");
        exportedCollections.set(
          name.slice(3, -7),
          body ? body.split("\n").map((line) => JSON.parse(line)) : [],
        );
      }
      offset = start + size;
    }
    const exportedEffects = exportedCollections.get("control_state_entries") ?? [];
    for (const effect of reviewEffects)
      if (!exportedEffects.some((row) => row.entry_key === effect.key && row.type === "effect"))
        throw new Error("Export omitted a committed simulation effect");
    if (
      !(exportedCollections.get("control_state_commits") ?? []).some(
        (row) => row.id === simulated.report.receiptId,
      )
    )
      throw new Error("Export omitted the simulation receipt");
    const workspaces = await client.request<{ workspaces: { id: string; name: string }[] }>(
      "/workspaces",
    );
    const workspaceName = workspaces.workspaces.find(
      (workspace) => workspace.id === workspaceId,
    )?.name;
    if (!workspaceName) throw new Error("Explicit workspace was absent from canonical membership");
    const beforeQuarantineBudget = await client.budgets.get();
    const beforeQuarantineUsage = await client.budgets.usage({ day: beforeQuarantineBudget.day });
    const quarantined = await client.request<{ deletion: { status: string } }>(
      "/workbench/workspace-deletion",
      { method: "POST", body: { workspaceName } },
    );
    if (quarantined.deletion.status !== "quarantined")
      throw new Error("Workspace did not enter quarantine");
    let denied = false;
    try {
      await client.threads.messages(thread.threadId);
    } catch (error) {
      denied = (error as { status: number }).status === 403;
    }
    if (!denied) throw new Error("Quarantined workspace remained readable");
    let stateDenied = false;
    try {
      await operatorClient.state.records(stateQuery);
    } catch (error) {
      stateDenied = (error as { status: number }).status === 403;
    }
    if (!stateDenied) throw new Error("Quarantined typed state remained readable");
    let simulationDenied = false;
    try {
      await reviewerClient.state.entries({ target: "simulation", type: "effect" });
    } catch (error) {
      simulationDenied = (error as { status: number }).status === 403;
    }
    if (!simulationDenied) throw new Error("Quarantined simulation effects remained readable");
    let contextDenied = false;
    try {
      await reviewerClient.context.snapshot(firstReview.report.snapshotId);
    } catch (error) {
      contextDenied = (error as { status: number }).status === 403;
    }
    if (!contextDenied) throw new Error("Quarantined context remained readable");
    let usageDenied = false;
    try {
      await client.budgets.usage({ day: beforeQuarantineBudget.day });
    } catch (error) {
      usageDenied = (error as { status: number }).status === 403;
    }
    if (!usageDenied) throw new Error("Quarantined usage remained readable");
    await client.request("/workbench/workspace-deletion", { method: "DELETE" });
    if (
      JSON.stringify(
        await reviewerClient.state.entries({ target: "simulation", type: "effect" }),
      ) !== JSON.stringify(simulatedEffects)
    )
      throw new Error("Recovery changed simulated effect evidence");
    if (
      JSON.stringify(await client.budgets.get()) !== JSON.stringify(beforeQuarantineBudget) ||
      JSON.stringify(await client.budgets.usage({ day: beforeQuarantineBudget.day })) !==
        JSON.stringify(beforeQuarantineUsage)
    )
      throw new Error("Recovery changed canonical budgets or usage receipts");
    if (
      JSON.stringify(await reviewerClient.context.snapshot(firstReview.report.snapshotId)) !==
      JSON.stringify(reviewEvidence)
    )
      throw new Error("Recovery changed canonical context evidence");
    if (
      JSON.stringify(await operatorClient.state.records(stateQuery)) !==
      JSON.stringify(stateRecords)
    )
      throw new Error("Recovery changed canonical typed state");
    const recovered = await client.threads.messages(thread.threadId);
    if (JSON.stringify(recovered.messages) !== JSON.stringify(messages.messages))
      throw new Error("Workspace recovery changed the canonical transcript");
    const recoveredReceipt = await client.threads.submit(
      thread.threadId,
      "Describe the runtime boundary.",
      "runtime-first-turn",
    );
    if (
      recoveredReceipt.messageId !== accepted.messageId ||
      recoveredReceipt.commandId !== accepted.commandId
    )
      throw new Error("Recovery lost command identity");
    if (
      JSON.stringify((await client.threads.command(accepted.commandId)).command) !==
      JSON.stringify(command)
    )
      throw new Error("Recovery changed the retained command outcome");
    if (JSON.stringify(await client.packages.snapshots()) !== JSON.stringify(snapshots))
      throw new Error("Recovery changed package snapshot history");
    if (
      JSON.stringify(
        (await reviewerClient.context.list({ runId: durable.run.id, runKind: "workflow" }))
          .snapshots,
      ) !== JSON.stringify(captures)
    )
      throw new Error("Recovery changed durable context revision history");
    // Exercise irreversible deletion only against this disposable local workspace.
    // The existing fault injector makes the grace period due and fails after native
    // cleanup, proving retained receipts survive a subsequent D1 cleanup retry.
    const purgeDb = new DatabaseSync(resolve(state, String(canonicalFile)), { readOnly: true });
    try {
      const nativeIds = purgeDb
        .prepare("SELECT instance_id FROM control_durable_executions WHERE workspace_id=?")
        .all(workspaceId)
        .map((row) => row.instance_id as string);
      if (nativeIds.length < 2) throw new Error("Native deletion drill has insufficient instances");
      const nativeList = async () => {
        const inspection = startManagedProcess(
          "pnpm",
          [
            "exec",
            "wrangler",
            "workflows",
            "instances",
            "list",
            "operloom-local-durable",
            "--local",
            "--port",
            String(port),
            "--json",
            "--per-page",
            "100",
            "--config",
            standalone?.config ?? "cloudflare/control-plane/wrangler.jsonc",
          ],
          {
            label: "workflow-deletion-inspection",
            cwd: runtimeRoot,
            stdio: "pipe",
            maxRssMb: 1024,
          },
        );
        let output = "";
        inspection.child.stdout?.on("data", (chunk) => {
          output += String(chunk);
        });
        inspection.child.stderr?.on("data", (chunk) => {
          logs = (logs + String(chunk)).slice(-10000);
        });
        const done = await inspection.completion;
        if (done.code !== 0 || done.reason)
          throw new Error(`Native deletion inspection failed: ${logs}`);
        const instances = JSON.parse(output) as { id: string }[];
        if (!Array.isArray(instances)) throw new Error("Native instance list was invalid");
        return instances.map((instance) => instance.id);
      };
      const before = await nativeList();
      if (nativeIds.some((id) => !before.includes(id)))
        throw new Error("Native deletion precondition missing");
      const deletion = await client.request<{ deletion: { purgeJobId: string } }>(
        "/workbench/workspace-deletion",
        {
          method: "POST",
          body: { workspaceName, e2eFailPhase: "receipt_creation" },
        },
      );
      for (let attempt = 1; attempt <= 3; attempt++) {
        const scheduled = await fetch(`${baseUrl}/cdn-cgi/handler/scheduled`);
        if (!scheduled.ok) throw new Error("Native deletion scheduler invocation failed");
        const deadline = Date.now() + 10000;
        while (true) {
          const job = purgeDb
            .prepare(
              "SELECT status,attempt_count,last_error_code FROM control_data_jobs WHERE id=?",
            )
            .get(deletion.deletion.purgeJobId);
          if (job && Number(job.attempt_count) >= attempt && job.status !== "running") {
            if (job.last_error_code !== "e2e_purge_receipt_creation_failure")
              throw new Error(
                `Native deletion failed before final receipt: ${JSON.stringify(job)}`,
              );
            break;
          }
          if (Date.now() > deadline)
            throw new Error(`Native deletion did not reach its checkpoint: ${logs}`);
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
      }
      if (
        purgeDb
          .prepare(
            "SELECT 1 FROM control_durable_executions WHERE workspace_id=? AND engine_deleted_at IS NULL",
          )
          .get(workspaceId)
      )
        throw new Error("Native deletion lacks a canonical confirmation");
      if ((await nativeList()).some((id) => nativeIds.includes(id)))
        throw new Error("Deleted native instances remain visible");
      await client.request("/workbench/workspace-deletion/retry", {
        method: "POST",
        body: { workspaceName },
      });
      const scheduled = await fetch(`${baseUrl}/cdn-cgi/handler/scheduled`);
      if (!scheduled.ok) throw new Error("Native deletion retry invocation failed");
      const deadline = Date.now() + 10000;
      while (purgeDb.prepare("SELECT 1 FROM workspaces WHERE id=?").get(workspaceId)) {
        if (Date.now() > deadline)
          throw new Error(`Final workspace purge did not complete: ${logs}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      for (const table of [
        "control_durable_executions",
        "control_durable_engine_dispatches",
        "control_durable_steps",
        "control_context_snapshots",
        "control_state_records",
        "control_state_entries",
        "control_state_commits",
        "control_state_outbox",
      ])
        if (purgeDb.prepare(`SELECT 1 FROM ${table} WHERE workspace_id=?`).get(workspaceId))
          throw new Error(`Workspace purge retained ${table}`);
      if (!purgeDb.prepare("SELECT 1 FROM control_deletion_receipts").get())
        throw new Error("Workspace purge lacks its nonidentifying receipt");
      console.log(
        "Native workflow deletion passed: independent instance-list verification, retained acknowledgement through failed D1 cleanup, and complete workspace purge after retry.",
      );
    } finally {
      purgeDb.close();
    }
    if (process.argv.includes("--durable-restart"))
      console.log(
        process.argv.includes("--local-engine-wake")
          ? "Wake-assisted local Workflows replay passed after process restart; all completed steps retained one attempt. Automatic local alarm recovery is not established."
          : "Automatic local Workflows restart passed with retained step identities.",
      );
    console.log(
      "Backend-only conformance passed: local authentication, explicit thread, Node and browser HTTP acceptance, canonical transcript after reconnect, idempotent replay/conflict and durable command/run identity, explicit package upgrade/history/replay, actual Workflows steps/wait, cancellation during a wait with scheduler-confirmed native termination and stable 202 durable submission, tenant isolation, typed state/decision inspection, simulation isolation, document-review workflow/no-op/blocked evidence and chat context, structured model fixture, budget exhaustion blocking chat/workflows while no-op remains usable, usage inspection, failed-delivery retry, policy-bound approval and run history at a nonzero agent revision, completed export and checksum-verified download, quarantine denial and recovery with retained budgets, usage, state, context and command identity. No Next process or model provider used.",
    );
  } finally {
    clearTimeout(timeout);
    worker.stop();
    await worker.completion;
    await new Promise<void>((resolveClose, reject) =>
      browserServer.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
};
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
