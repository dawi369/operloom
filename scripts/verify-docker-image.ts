import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const sentinelName = `operloom-docker-sentinel-${randomUUID()}`;
const imageTag = `operloom:release-verify-${process.pid}`;
const containerName = `operloom-verify-runtime-${process.pid}`;
let activeChild: ReturnType<typeof spawn> | undefined;
let cancelled = false;
// Ignore repeated cancellation while Docker cleanup is in progress.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (cancelled) return;
    cancelled = true;
    activeChild?.kill("SIGTERM");
  });
}
const builderName = `operloom-verify-${process.pid}`;
const sentinelPaths = [
  ".assistant-mk1",
  ".vercel",
  ".playwright-cli",
  ".omm",
  "apps/mobile/.expo",
  "apps/mobile/ios",
  "apps/mobile/android",
  "output",
  "coverage",
  "cloudflare/control-plane/.wrangler",
  ".cache",
].map((directory) => path.join(root, directory, sentinelName));
sentinelPaths.push(path.join(root, `${sentinelName}.db`));
sentinelPaths.push(path.join(root, `${sentinelName}.sqlite`));

const run = (command: string, args: string[], input?: { quiet?: boolean; cleanup?: boolean }) =>
  new Promise<void>((resolve, reject) => {
    if (cancelled && !input?.cleanup) {
      reject(new Error("Docker verification cancelled"));
      return;
    }
    const child = spawn(command, args, {
      cwd: root,
      stdio: input?.quiet ? "ignore" : "inherit",
    });
    activeChild = child;
    const timeout = setTimeout(() => child.kill("SIGKILL"), input?.cleanup ? 30_000 : 15 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      activeChild = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? "no code"}`));
    });
  });

const main = async () => {
  await run("docker", ["info"], { quiet: true });
  const temporary = await mkdtemp(path.join(tmpdir(), "operloom-buildkit-"));
  const buildkitConfig = path.join(temporary, "buildkitd.toml");
  await writeFile(buildkitConfig, "[worker.oci]\n  max-parallelism = 1\n");
  try {
    await run("docker", [
      "buildx",
      "create",
      "--name",
      builderName,
      "--driver",
      "docker-container",
      "--driver-opt",
      "memory=3g",
      "--driver-opt",
      "memory-swap=3g",
      "--driver-opt",
      "cpu-period=100000",
      "--driver-opt",
      "cpu-quota=200000",
      "--buildkitd-config",
      buildkitConfig,
    ]);
    for (const sentinelPath of sentinelPaths) {
      await mkdir(path.dirname(sentinelPath), { recursive: true });
      await writeFile(sentinelPath, sentinelName, "utf8");
    }
    await run("docker", [
      "buildx",
      "build",
      "--builder",
      builderName,
      "--load",
      "--pull=false",
      "--tag",
      imageTag,
      "--file",
      "Dockerfile.langgraph",
      ".",
    ]);
    await run("docker", [
      "run",
      "--name",
      containerName,
      "--cpus=2",
      "--memory=1g",
      "--memory-swap=1g",
      "--rm",
      "--entrypoint",
      "sh",
      imageTag,
      "-c",
      `test "$(id -u)" != 0 && test -z "$(find /app -path /app/node_modules -prune -o \\( -name '${sentinelName}*' -o -name '.assistant-mk1' -o -name '.vercel' -o -name '.playwright-cli' -o -name '.omm' -o -name 'output' -o -name 'coverage' -o -name '.wrangler' -o -name '.dev.vars' -o -name '.cache' -o -name '*.db' -o -name '*.db-shm' -o -name '*.db-wal' -o -name '*.sqlite' -o -name '*.sqlite3' \\) -print -quit)"`,
    ]);
    await run("docker", [
      "run",
      "--name",
      containerName,
      "--cpus=2",
      "--memory=1g",
      "--memory-swap=1g",
      "--rm",
      "--entrypoint",
      "sh",
      imageTag,
      "-c",
      'test "$(node -p "process.versions.node.split(\'.\')[0]")" = 24 && test -d /app/.langgraph_api && test -w /app/.langgraph_api',
    ]);
    await run("docker", [
      "run",
      "--name",
      containerName,
      "--cpus=2",
      "--memory=1g",
      "--memory-swap=1g",
      "--rm",
      "--entrypoint",
      "pnpm",
      imageTag,
      "exec",
      "tsx",
      "--version",
    ]);
    await run("docker", [
      "run",
      "--name",
      containerName,
      "--cpus=2",
      "--memory=1g",
      "--memory-swap=1g",
      "--rm",
      "--entrypoint",
      "pnpm",
      imageTag,
      "exec",
      "langgraphjs",
      "--help",
    ]);
    await run("docker", [
      "run",
      "--detach",
      "--name",
      containerName,
      "--cpus=2",
      "--memory=1g",
      "--memory-swap=1g",
      "--env",
      "OPENROUTER_API_KEY=operloom-health-fixture-not-a-real-key",
      imageTag,
    ]);
    try {
      await run("docker", [
        "exec",
        containerName,
        "node",
        "-e",
        `
        (async () => {
          for (let attempt = 0; attempt < 90; attempt++) {
            try {
              const response = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(1000) });
              const health = await response.json();
              if (response.ok && health.langGraphReady === true) {
                console.log('Signed runner and LangGraph container readiness verified.');
                return;
              }
            } catch {}
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          throw new Error('Container did not become ready within its startup budget');
        })().catch(error => { console.error(error.message); process.exitCode = 1; });
      `,
      ]);
    } catch (error) {
      await run("docker", ["logs", "--tail", "80", containerName]).catch(() => {});
      throw error;
    }
    console.log("Docker release image boundary and runtime readiness verified.");
  } finally {
    await run("docker", ["rm", "--force", containerName], { quiet: true, cleanup: true }).catch(
      () => {},
    );
    await run("docker", ["buildx", "rm", "--force", builderName], {
      quiet: true,
      cleanup: true,
    }).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
    await Promise.all(sentinelPaths.map((sentinelPath) => rm(sentinelPath, { force: true })));
    await run("docker", ["image", "rm", "--force", imageTag], { quiet: true, cleanup: true }).catch(
      () => {},
    );
  }
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
