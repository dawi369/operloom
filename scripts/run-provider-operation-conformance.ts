import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { startManagedProcess } from "./managed-process";
import { createRuntimeClient } from "../packages/workbench-client/src/runtime-client";

const main = async () => {
  const root = process.cwd();
  mkdirSync(resolve(root, "output/provider-operation-conformance"), { recursive: true });
  const state = mkdtempSync(resolve(root, "output/provider-operation-conformance/run-"));
  const token = "provider-conformance-local-only";
  const secret = "synthetic-capacity-secret-local-only-123456";
  const effects = new Map<
    string,
    { body: string; output: { requestId: string; resourceId: string; lifecycle: string } }
  >();
  const requests: { method: string; key: string }[] = [];
  let providerOrigin = "";
  const provider = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 65536) throw new Error("oversize");
      }
      const url = new URL(request.url!, providerOrigin);
      const key = String(request.headers["idempotency-key"] ?? "");
      assert.match(key, /^[a-f0-9]{64}$/);
      if (url.pathname.startsWith("/signed/")) {
        const timestamp = String(request.headers["x-capacity-timestamp"]);
        assert.ok(Math.abs(Date.now() - Date.parse(timestamp)) < 60000);
        const canonical = [
          request.method,
          url.toString(),
          createHash("sha256").update(body).digest("hex"),
          key,
          timestamp,
        ].join("\n");
        assert.equal(
          request.headers["x-capacity-signature"],
          createHmac("sha256", secret).update(canonical).digest("hex"),
        );
        assert.equal(request.headers.authorization, undefined);
      } else assert.equal(request.headers.authorization, `Bearer ${secret}`);
      requests.push({ method: request.method!, key });
      if (request.method === "POST") {
        assert.ok(url.pathname.endsWith("/allocations"));
        const input = JSON.parse(body) as { resource: string; units: number };
        if (effects.has(key)) assert.equal(effects.get(key)!.body, body);
        else
          effects.set(key, {
            body,
            output: {
              requestId: key,
              resourceId: `allocation-${effects.size + 1}`,
              lifecycle: "pending",
            },
          });
        if (input.resource === "lost-response") {
          response.destroy();
          return;
        }
      } else {
        assert.equal(request.method, "GET");
        assert.ok(url.pathname.endsWith(`/allocations/${key}`));
      }
      const effect = effects.get(key);
      response.writeHead(effect ? 200 : 404, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          effect ? { ...effect.output, privateDebug: secret } : { error: "not_found" },
        ),
      );
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"invalid_fixture_request"}');
    }
  });
  let logs = "";
  const capture = (chunk: Buffer) => {
    logs = (logs + String(chunk)).slice(-10000);
  };
  let worker: ReturnType<typeof startManagedProcess> | undefined;
  let migrate: ReturnType<typeof startManagedProcess> | undefined;
  let db: DatabaseSync | undefined;
  const reservation = createServer();
  const timeout = setTimeout(() => {
    migrate?.stop("Native provider acceptance deadline");
    worker?.stop("Native provider acceptance deadline");
  }, 120000);
  try {
    await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
    providerOrigin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done, reject) =>
      reservation.close((error) => (error ? reject(error) : done())),
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    const source = resolve(root, "cloudflare/control-plane/wrangler.jsonc");
    const config = ts.parseConfigFileTextToJson(source, readFileSync(source, "utf8")).config;
    config.main = resolve(root, "cloudflare/control-plane/src/index.ts");
    for (const db of config.d1_databases)
      db.migrations_dir = resolve(root, "cloudflare/control-plane/migrations");
    config.vars = {
      ...config.vars,
      WORKBENCH_LOCAL_API_ENABLED: "true",
      WORKBENCH_ENVIRONMENT: "local",
      CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN: token,
      WORKBENCH_AGENT_CONNECTION_SECRET: "provider-conformance-agent-secret-000001",
      WORKBENCH_E2E_MODE: "true",
      WORKBENCH_CONFORMANCE_MODE: "true",
      WORKBENCH_RETAINED_DATA_ENABLED: "true",
      WORKBENCH_CONNECTIONS_ENABLED: "true",
      WORKBENCH_MUTATIONS_ENABLED: "true",
      WORKBENCH_VAULT_BACKEND: "memory",
      WORKBENCH_OAUTH_PROVIDERS_JSON: JSON.stringify([
        {
          id: "capacity-service",
          actionUrl: `${providerOrigin}/bearer/allocations`,
          permittedHosts: ["127.0.0.1"],
        },
        {
          id: "signed-capacity-service",
          actionUrl: `${providerOrigin}/signed/allocations`,
          permittedHosts: ["127.0.0.1"],
        },
      ]),
    };
    const configPath = resolve(state, "wrangler.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const common = ["--config", configPath, "--local", "--persist-to", state];
    migrate = startManagedProcess(
      "pnpm",
      ["exec", "wrangler", "d1", "migrations", "apply", "assistant_mk1_local", ...common],
      { cwd: root, label: "provider-migrations", stdio: "pipe", maxRssMb: 1536 },
    );
    migrate.child.stdout?.on("data", capture);
    migrate.child.stderr?.on("data", capture);
    const migration = await migrate.completion;
    assert.equal(migration.code, 0, logs);
    worker = startManagedProcess(
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
        "--test-scheduled",
      ],
      { cwd: root, label: "provider-worker", stdio: "pipe", maxRssMb: 1536 },
    );
    worker.child.stdout?.on("data", capture);
    worker.child.stderr?.on("data", capture);
    const deadline = Date.now() + 30000;
    while (true) {
      try {
        if ((await fetch(`${baseUrl}/health/live`)).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`Worker startup failed: ${logs}`);
      await new Promise((done) => setTimeout(done, 200));
    }
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${baseUrl}/v1/account`, { headers })).status, 200);
    const workspaceId = "workspace:local-api:operloom-local:default";
    let agentId = `agent-${workspaceId}`;
    const clientFor = () =>
      createRuntimeClient({
        baseUrl,
        target: { workspaceId, agentId },
        getAccessToken: async () => token,
      });
    const installed = await clientFor().request<{ agent: { id: string } }>(
      "/agent-packs/provider-operation-fixture/instantiate",
      { method: "POST" },
    );
    agentId = installed.agent.id;
    const client = clientFor();
    const raw = async (path: string, body: Record<string, unknown> = {}) => {
      const response = await fetch(
        `${baseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}${path}`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        },
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    await client.request("/workbench/retention-policy", {
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
    for (const [connection, tool] of [
      ["capacity.service", "capacity.allocate"],
      ["capacity.signed-service", "capacity.allocate-signed"],
    ]) {
      await client.request(`/workbench/connections/${connection}/credentials`, {
        method: "POST",
        body: { secret },
      });
      await client.request("/tools/policy", {
        method: "POST",
        body: { toolName: tool, mutationEnabled: true },
      });
    }
    const file = readdirSync(state, { recursive: true }).find(
      (name) =>
        String(name).includes("miniflare-D1DatabaseObject") && String(name).endsWith(".sqlite"),
    );
    assert.ok(file);
    db = new DatabaseSync(resolve(state, String(file)));
    const propose = async (resource: string, signed = false, reserve = false, units = 2) => {
      const response = await client.request<{ report: { proposalId: string } }>(
        "/workbench/workflows/capacity.request",
        {
          method: "POST",
          body: {
            executionMode: "dry_run",
            input: { resource, units, key: resource, signed, reserve },
          },
        },
      );
      const id = response.report.proposalId;
      assert.ok(id);
      const execution = await client.admin.requestAction(id);
      return { id, approval: execution.approvalRequest.id };
    };
    for (const signed of [false, true]) {
      const pending = await propose(signed ? "signed-pool" : "bearer-pool", signed);
      const responses = await Promise.all([
        raw(`/tools/approvals/${pending.approval}/approve`),
        raw(`/tools/approvals/${pending.approval}/approve`),
      ]);
      assert.deepEqual(responses.map((item) => item.status).sort(), [200, 409]);
      assert.ok(!JSON.stringify(responses).includes(secret));
    }
    const lost = await propose("lost-response", true);
    assert.equal((await raw(`/tools/approvals/${lost.approval}/approve`)).status, 502);
    assert.equal((await client.admin.reconcileAction(lost.id)).result.status, "reconciled");
    const broken = await propose("projection");
    db.exec(
      "CREATE TRIGGER conformance_projection_failure BEFORE UPDATE ON control_action_proposals WHEN NEW.status='executed' AND json_extract(NEW.proposal_json,'$.preview.resource')='projection' BEGIN SELECT RAISE(ABORT,'conformance_projection_failure'); END",
    );
    assert.equal((await raw(`/tools/approvals/${broken.approval}/approve`)).status, 409);
    const listed = await client.admin.actions();
    assert.equal(
      listed.proposals?.find((item) => item.id === broken.id)?.providerOperation?.status,
      "succeeded",
    );
    assert.ok(!JSON.stringify(listed).includes(secret));
    db.exec("DROP TRIGGER conformance_projection_failure");
    const beforeRepair = requests.length;
    assert.equal((await client.admin.reconcileAction(broken.id)).result.status, "reconciled");
    assert.equal((await client.admin.reconcileAction(broken.id)).result.status, "reconciled");
    assert.equal(requests.length, beforeRepair);
    assert.equal(effects.size, 4);
    assert.equal(requests.filter((item) => item.method === "POST").length, 4);
    assert.equal(requests.filter((item) => item.method === "GET").length, 1);
    await client.request("/workbench/workflows/capacity.seed", {
      method: "POST",
      body: { executionMode: "dry_run", input: {} },
    });
    const contenders = await Promise.all([
      propose("reserved-a", false, true, 3),
      propose("reserved-b", false, true, 3),
    ]);
    const claims = await Promise.all(
      contenders.map((item) => raw(`/tools/approvals/${item.approval}/approve`)),
    );
    assert.deepEqual(claims.map((item) => item.status).sort(), [200, 502]);
    const winner = contenders[claims[0]!.status === 200 ? 0 : 1]!;
    const loser = contenders[claims[0]!.status === 200 ? 1 : 0]!;
    assert.equal(
      (await client.admin.reconcileAction(loser.id)).result.output?.dispatchStatus,
      "not_dispatched",
    );
    assert.equal(effects.size, 5);
    assert.equal(
      db.prepare("SELECT SUM(amount) n FROM control_action_reservations WHERE status='held'").get()!
        .n,
      3,
    );
    db.exec(
      "CREATE TRIGGER conformance_state_projection_failure BEFORE INSERT ON control_state_entries BEGIN SELECT RAISE(ABORT,'state_projection_failure'); END",
    );
    const projectBody = { executionMode: "dry_run", input: { proposalId: winner.id } };
    assert.ok((await raw("/workbench/workflows/capacity.project", projectBody)).status >= 400);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM control_action_projections").get()!.n, 0);
    assert.equal(
      db.prepare("SELECT status FROM control_action_reservations").get()!.status,
      "held",
    );
    db.exec("DROP TRIGGER conformance_state_projection_failure");
    assert.equal((await raw("/workbench/workflows/capacity.project", projectBody)).status, 200);
    assert.equal((await raw("/workbench/workflows/capacity.project", projectBody)).status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM control_action_projections").get()!.n, 1);
    assert.equal(
      db
        .prepare(
          "SELECT json_extract(data_json,'$.remaining') n FROM control_state_records WHERE namespace='capacity' AND record_key='pool'",
        )
        .get()!.n,
      2,
    );
    assert.equal(
      db.prepare("SELECT status FROM control_action_reservations").get()!.status,
      "projected",
    );
    assert.equal(requests.filter((item) => item.method === "POST").length, 5);
    const exported = await client.request<{ job: { id: string } }>("/workbench/data-exports", {
      method: "POST",
    });
    const exportDeadline = Date.now() + 20000;
    while (true) {
      const state = await client.request<{ job: { status: string } }>(
        `/workbench/data-exports/${exported.job.id}`,
      );
      if (state.job.status === "completed") break;
      assert.notEqual(state.job.status, "failed");
      assert.ok(Date.now() < exportDeadline);
      await new Promise((done) => setTimeout(done, 200));
    }
    const download = await fetch(
      `${baseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/workbench/data-exports/${exported.job.id}/download`,
      { headers },
    );
    assert.equal(download.status, 200);
    const archive = Buffer.from(await download.arrayBuffer());
    assert.ok(!archive.includes(Buffer.from(secret)));
    let providerRows: Record<string, unknown>[] = [];
    const resourceCollections: Record<string, number> = {};
    for (let offset = 0; archive.readUInt32LE(offset) === 0x04034b50; ) {
      assert.equal(archive.readUInt16LE(offset + 8), 0);
      const size = archive.readUInt32LE(offset + 18),
        nameLength = archive.readUInt16LE(offset + 26),
        extra = archive.readUInt16LE(offset + 28);
      const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString();
      const start = offset + 30 + nameLength + extra;
      if (name.includes("control_provider_operations"))
        providerRows = archive
          .subarray(start, start + size)
          .toString()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      for (const collection of ["control_action_reservations", "control_action_projections"]) {
        if (name.includes(collection))
          resourceCollections[collection] = archive
            .subarray(start, start + size)
            .toString()
            .split("\n")
            .filter(Boolean).length;
      }
      offset = start + size;
    }
    assert.equal(providerRows.length, 5);
    assert.deepEqual(resourceCollections, {
      control_action_reservations: 1,
      control_action_projections: 1,
    });
    assert.ok(
      providerRows.every(
        (row) => row.vault_version === undefined && row.connection_record_id === undefined,
      ),
    );
    const workspaceName = String(
      db.prepare("SELECT name FROM workspaces WHERE id=?").get(workspaceId)!.name,
    );
    await client.request("/workbench/workspace-deletion", {
      method: "POST",
      body: { workspaceName },
    });
    const blocked = await fetch(
      `${baseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/workbench/actions`,
      { headers },
    );
    assert.equal(blocked.status, 403);
    await client.request("/workbench/workspace-deletion", { method: "DELETE" });
    assert.equal((await client.admin.actions()).proposals?.length, 6);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM control_action_projections").get()!.n, 1);
    await client.request("/workbench/workspace-deletion", {
      method: "POST",
      body: { workspaceName },
    });
    db.prepare("UPDATE workspaces SET purge_after='2000-01-01T00:00:00.000Z' WHERE id=?").run(
      workspaceId,
    );
    db.prepare(
      "UPDATE control_data_jobs SET expires_at='2000-01-01T00:00:00.000Z' WHERE workspace_id=? AND kind='purge' AND status='queued'",
    ).run(workspaceId);
    assert.ok((await fetch(`${baseUrl}/cdn-cgi/handler/scheduled`)).ok);
    const purgeDeadline = Date.now() + 20000;
    while (db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(workspaceId)) {
      assert.ok(Date.now() < purgeDeadline, "Workspace purge deadline");
      await new Promise((done) => setTimeout(done, 200));
    }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM control_provider_operations").get()!.n, 0);
    assert.equal(requests.filter((item) => item.method === "POST").length, 5);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM control_action_reservations").get()!.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM control_action_projections").get()!.n, 0);
    console.log(
      "Native provider acceptance passed: public API, registry-only fixture, bearer/HMAC verification, concurrent approval, lost response and GET reconciliation, projection repair with zero provider requests, competing capacity reservations, exact atomic state projection and repair, redacted receipt/resource export, quarantine/recovery and populated purge. Five external fixture effects; no model, Next.js or hosted provider used.",
    );
  } finally {
    clearTimeout(timeout);
    db?.close();
    worker?.stop();
    migrate?.stop();
    reservation.closeAllConnections();
    reservation.close();
    if (worker) await worker.completion;
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
    writeFileSync(resolve(state, "worker.log"), logs);
  }
};
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
