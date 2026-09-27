import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { startManagedProcess } from "./managed-process";
import {
  withDurableDeploymentGate,
  activateDeploymentFence,
  type DeploymentSql,
} from "./durable-deployment-gate";

// This file and its two dependency-free helpers are compiled into every artifact.
const main = async () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const value = (flag: string) => process.argv[process.argv.indexOf(flag) + 1];
  const originValue = process.argv.includes("--origin") ? value("--origin") : "";
  const origin = new URL(originValue);
  const checkOnly = process.argv.includes("--check");
  const local = process.argv.includes("--local");
  const localState =
    local && process.argv.includes("--persist-to") ? value("--persist-to") : undefined;
  if (
    (local
      ? !checkOnly ||
        !localState ||
        origin.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      : !process.argv.includes("--remote") || origin.protocol !== "https:") ||
    (local && process.argv.includes("--remote")) ||
    origin.origin !== originValue ||
    origin.username ||
    origin.password
  )
    throw new Error(
      "Use --remote --origin https://<target-worker-origin>, or --check --local --persist-to <state> --origin http://127.0.0.1",
    );
  if (checkOnly && (process.argv.includes("--resume") || process.argv.includes("--release")))
    throw new Error("Inspection cannot resume or release an uncertain deployment");
  const artifact = JSON.parse(readFileSync(resolve(root, "runtime-manifest.json"), "utf8"));
  const configurationBytes = readFileSync(resolve(root, "wrangler.json"), "utf8");
  const config = JSON.parse(configurationBytes);
  const hash = () =>
    createHash("sha256")
      .update(readFileSync(resolve(root, "worker/index.js")))
      .digest("hex");
  if (hash() !== artifact.bundleSha256) throw new Error("Worker bundle differs from its manifest");
  const dependency = realpathSync(resolve(root, "node_modules/wrangler/package.json"));
  if (relative(realpathSync(root), dependency).startsWith(".."))
    throw new Error("Install artifact-local Wrangler before deployment");
  const database = config.d1_databases?.find((item: { binding: string }) => item.binding === "DB");
  if (!database?.database_id || !database.database_name)
    throw new Error("Candidate requires an explicit DB binding");
  const deploymentId = process.argv.includes("--resume")
    ? value("--resume")!
    : process.argv.includes("--release")
      ? value("--release")!
      : randomUUID();
  const fence = {
    deploymentId,
    artifactSha256: createHash("sha256")
      .update(artifact.bundleSha256)
      .update(configurationBytes)
      .digest("hex"),
  };
  mkdirSync(resolve(root, "deployment-evidence"), { recursive: true });
  const evidenceFile = resolve(root, "deployment-evidence", `${deploymentId}.json`);
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(deploymentId)) throw new Error("Invalid deployment identity");
  const record = (status: string) =>
    writeFileSync(
      evidenceFile,
      JSON.stringify(
        {
          ...fence,
          status,
          origin: origin.origin,
          databaseId: database.database_id,
          release: config.vars?.WORKBENCH_RELEASE_SHA ?? null,
          at: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  const command = async (args: string[]) => {
    if (
      hash() !== artifact.bundleSha256 ||
      readFileSync(resolve(root, "wrangler.json"), "utf8") !== configurationBytes
    )
      throw new Error("Artifact code or configuration changed during deployment");
    const process = startManagedProcess("pnpm", ["exec", "wrangler", ...args], {
      cwd: root,
      label: "runtime-deployment",
      stdio: "pipe",
      maxRssMb: 1536,
    });
    let stdout = "";
    process.child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 4_000_000) process.stop("Deployment output limit exceeded");
    });
    // Provider errors may contain private configuration. Report only the phase.
    process.child.stderr?.resume();
    const timer = setTimeout(() => process.stop("Deployment command timed out"), 120000);
    try {
      const result = await process.completion;
      if (result.code !== 0 || result.reason)
        throw new Error(`Wrangler ${args[0]} failed; inspect provider state before resuming`);
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  };
  const sql: DeploymentSql = async (query) => {
    const result = JSON.parse(
      await command([
        "d1",
        "execute",
        database.database_name,
        ...(local ? ["--local", "--persist-to", resolve(localState!)] : ["--remote"]),
        "--config",
        resolve(root, "wrangler.json"),
        "--json",
        "--command",
        query,
      ]),
    );
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      result[0]?.success !== true ||
      !Array.isArray(result[0].results)
    )
      throw new Error("Invalid D1 deployment response");
    return result[0].results;
  };
  const verify = async () => {
    const deadline = Date.now() + 45000;
    do {
      try {
        const response = await fetch(new URL("/health/live", origin), {
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        const body = (await response.json()) as {
          ok?: boolean;
          deploymentId?: string;
          release?: string;
        };
        if (
          response.ok &&
          body.ok &&
          body.deploymentId === deploymentId &&
          body.release === (config.vars?.WORKBENCH_RELEASE_SHA ?? "development")
        )
          return;
      } catch {
        /* Keep the fence until the exact deployment is observed. */
      }
      await new Promise((done) => setTimeout(done, 1000));
    } while (Date.now() < deadline);
    throw new Error("Exact deployment was not observed; admission remains fenced");
  };
  if (process.argv.includes("--release")) {
    await verify();
    await activateDeploymentFence(sql, fence);
    record("verified_and_released");
    return;
  }
  const directory = mkdtempSync(resolve(root, ".deployment-"));
  const deployConfig = resolve(directory, "deploy.json");
  // Absolute module paths preserve the exact frozen bundle with the nested config.
  const candidate = {
    ...config,
    main: resolve(root, config.main),
    d1_databases: config.d1_databases.map((db: { migrations_dir?: string }) => ({
      ...db,
      migrations_dir: resolve(root, db.migrations_dir ?? "migrations"),
    })),
    vars: { ...config.vars, WORKBENCH_DEPLOYMENT_ID: deploymentId },
  };
  writeFileSync(deployConfig, JSON.stringify(candidate), { mode: 0o600 });
  record("prepared");
  try {
    await withDurableDeploymentGate({
      sql,
      fence,
      resume: process.argv.includes("--resume"),
      activate: !checkOnly,
      async check(pins) {
        if (!pins.length) return;
        const server = createServer();
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const port = (server.address() as { port: number }).port;
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done())),
        );
        const token = randomUUID();
        const probeConfig = resolve(directory, "probe.json");
        writeFileSync(
          probeConfig,
          JSON.stringify({
            ...candidate,
            triggers: {},
            vars: {
              ...candidate.vars,
              WORKBENCH_ENVIRONMENT: "local",
              WORKBENCH_LOCAL_API_ENABLED: "true",
              CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN: token,
            },
          }),
          { mode: 0o600 },
        );
        const probe = startManagedProcess(
          "pnpm",
          [
            "exec",
            "wrangler",
            "dev",
            "--local",
            "--config",
            probeConfig,
            "--port",
            String(port),
            "--persist-to",
            resolve(directory, "state"),
          ],
          { cwd: root, label: "worker-deployment-probe", stdio: "pipe", maxRssMb: 1536 },
        );
        probe.child.stdout?.resume();
        probe.child.stderr?.resume();
        try {
          const readyBy = Date.now() + 30000;
          while (true) {
            try {
              if (
                (
                  await fetch(`http://127.0.0.1:${port}/health/live`, {
                    signal: AbortSignal.timeout(1000),
                  })
                ).ok
              )
                break;
            } catch {}
            if (Date.now() > readyBy) throw new Error("Candidate Worker did not start");
            await new Promise((done) => setTimeout(done, 200));
          }
          for (let offset = 0; offset < pins.length; offset += 100) {
            const page = pins.slice(offset, offset + 100);
            const response = await fetch(
              `http://127.0.0.1:${port}/__operloom/durable-deployment-probe`,
              {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify(page),
                signal: AbortSignal.timeout(10000),
              },
            );
            const result = (await response.json()) as {
              results?: { ok: boolean; code?: string }[];
            };
            if (
              !response.ok ||
              !Array.isArray(result.results) ||
              result.results.length !== page.length
            )
              throw new Error("Candidate compatibility response is invalid");
            const failed = result.results.findIndex((row) => row.ok !== true);
            if (failed >= 0) {
              const pin = page[failed]!;
              throw new Error(
                `Candidate cannot retain ${pin.pack_id}@${pin.pack_version}/${pin.workflow_type}: ${result.results[failed]!.code ?? "incompatible"}`,
              );
            }
          }
        } finally {
          probe.stop();
          await probe.completion;
          unlinkSync(probeConfig);
        }
      },
      async deploy() {
        if (checkOnly) return;
        if (hash() !== artifact.bundleSha256)
          throw new Error("Worker changed after inspection; admission remains fenced");
        record("deploying");
        await command(["deploy", "--no-bundle", "--config", deployConfig]);
        record("uploaded");
      },
      verify: checkOnly ? async () => {} : verify,
    });
    record(checkOnly ? "compatible_inspection" : "verified_and_released");
    console.log(
      `${checkOnly ? "Runtime compatibility inspection passed" : "Runtime deployed and verified"}: ${deploymentId}. Evidence: ${evidenceFile}`,
    );
  } catch (error) {
    record("failed_inspect_fence_before_retry");
    console.error(
      `Deployment ${deploymentId} failed. Resume this exact artifact with --resume ${deploymentId}; an uncertain deployment keeps admission fenced.`,
    );
    throw error;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Runtime deployment failed");
  process.exitCode = 1;
});
