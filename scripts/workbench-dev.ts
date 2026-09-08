import { serviceMemoryBudgetMb, startManagedProcess } from "./managed-process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { diagnoseWorkbench } from "./workbench-doctor-core";
import { assessLocalNodeRuntime } from "./node-runtime";
import { readLocalEnvironment } from "./workbench-local-env";

type ServiceName = "frontend" | "langgraph" | "worker" | "runner";

export type LocalWorkbenchService = {
  name: ServiceName;
  command: string;
  args: string[];
  port: number;
  healthUrl: string;
  env: Record<string, string | undefined>;
};

export type LocalWorkbenchConfiguration = {
  services: LocalWorkbenchService[];
};

const required = (values: Record<string, string>, key: string, source: string) => {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${source} is missing ${key}; run pnpm workbench init`);
  return value;
};

export const createLocalWorkbenchConfiguration = (
  root: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LocalWorkbenchConfiguration => {
  const frontend = readLocalEnvironment(root, ".env.local");
  const worker = readLocalEnvironment(root, "cloudflare/control-plane/.dev.vars");
  if (!frontend || !worker)
    throw new Error("Local environment is missing; run pnpm workbench init");

  const frontendPort = 3000;
  const langGraphPort = 2024;
  const workerPort = 8787;
  const runnerPort = 3101;
  const callbackUrl = new URL(required(worker, "WORKBENCH_CALLBACK_URL", ".dev.vars"));
  const runnerUrl = new URL(required(worker, "WORKBENCH_RUNNER_URL", ".dev.vars"));
  if (worker.WORKBENCH_RUNNER_TRANSPORT !== "fly") {
    throw new Error("Local full-stack development requires WORKBENCH_RUNNER_TRANSPORT=fly");
  }
  if (runnerUrl.origin !== `http://127.0.0.1:${runnerPort}`) {
    throw new Error(`Local runner URL must use http://127.0.0.1:${runnerPort}`);
  }
  if (callbackUrl.origin !== `http://127.0.0.1:${workerPort}`) {
    throw new Error(`Local callback URL must use http://127.0.0.1:${workerPort}`);
  }

  const shared = { ...environment, ...frontend };
  const runnerEnvironment = {
    ...shared,
    ...worker,
    PORT: String(runnerPort),
    LANGGRAPH_UPSTREAM_URL: `http://127.0.0.1:${langGraphPort}`,
    LANGGRAPH_PROXY_TOKEN: required(worker, "LANGGRAPH_UPSTREAM_TOKEN", ".dev.vars"),
    WORKBENCH_CALLBACK_ORIGIN: callbackUrl.origin,
    WORKBENCH_CALLBACK_SIGNING_SECRET: required(
      worker,
      "WORKBENCH_CALLBACK_SIGNING_SECRET",
      ".dev.vars",
    ),
    WORKBENCH_RUNNER_SIGNING_SECRET: required(
      worker,
      "WORKBENCH_RUNNER_SIGNING_SECRET",
      ".dev.vars",
    ),
  };

  return {
    services: [
      {
        name: "frontend",
        command: "pnpm",
        args: [
          "exec",
          "next",
          "dev",
          "--webpack",
          "--disable-source-maps",
          "--hostname",
          "127.0.0.1",
        ],
        port: frontendPort,
        healthUrl: `http://127.0.0.1:${frontendPort}`,
        env: { ...shared, PORT: String(frontendPort) },
      },
      {
        name: "langgraph",
        command: "pnpm",
        args: ["dev:backend"],
        port: langGraphPort,
        healthUrl: `http://127.0.0.1:${langGraphPort}/ok`,
        env: shared,
      },
      {
        name: "worker",
        command: "pnpm",
        args: ["dev:cloudflare"],
        port: workerPort,
        healthUrl: `http://127.0.0.1:${workerPort}/health`,
        env: { ...environment, ...worker },
      },
      {
        name: "runner",
        command: "pnpm",
        args: ["start:langgraph-gateway"],
        port: runnerPort,
        healthUrl: `http://127.0.0.1:${runnerPort}/health`,
        env: runnerEnvironment,
      },
    ],
  };
};

const assertPortAvailable = (port: number) =>
  new Promise<void>((resolveAvailable, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} is already in use`)));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailable()));
  });

const waitForHealth = async (
  service: LocalWorkbenchService,
  signal: AbortSignal,
  timeoutMs = 60_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal.aborted) {
    try {
      const response = await fetch(service.healthUrl, {
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      });
      if (response.status < 500) return;
    } catch {
      // The supervised service is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${service.name} did not become ready at ${service.healthUrl}`);
};

const main = async () => {
  const root = process.cwd();
  const nodeRuntime = assessLocalNodeRuntime();
  if (!nodeRuntime.supported) throw new Error(nodeRuntime.message);
  const diagnosis = await diagnoseWorkbench({ root, offline: true });
  if (diagnosis.failures.length) throw new Error(diagnosis.failures.join("\n"));
  const configuration = createLocalWorkbenchConfiguration(root);
  await Promise.all(configuration.services.map((service) => assertPortAvailable(service.port)));

  console.log("Starting complete local workbench:");
  for (const service of configuration.services) {
    console.log(`- ${service.name.padEnd(10)} ${service.healthUrl}`);
  }

  const children = new Map<ServiceName, ReturnType<typeof startManagedProcess>>();
  let stopping = false;
  const startup = new AbortController();
  const stop = (exitCode: number) => {
    if (stopping) return;
    stopping = true;
    startup.abort();
    for (const child of children.values()) child.stop();
    process.exitCode = exitCode;
  };
  process.on("SIGINT", () => stop(130));
  process.on("SIGTERM", () => stop(143));

  for (const service of configuration.services) {
    const managed = startManagedProcess(service.command, service.args, {
      label: service.name,
      cwd: resolve(root),
      env: service.env as NodeJS.ProcessEnv,
      stdio: "inherit",
      maxRssMb: serviceMemoryBudgetMb(service.name),
    });
    children.set(service.name, managed);
    void managed.completion.then(({ code, signal, reason }) => {
      if (stopping) return;
      console.error(
        reason ?? `${service.name} exited (${signal ?? code ?? "unknown"}); stopping workbench`,
      );
      stop(code && code > 0 ? code : 1);
    });
  }

  try {
    await Promise.all(
      configuration.services.map((service) => waitForHealth(service, startup.signal)),
    );
    console.log("Workbench is ready. Run `pnpm workbench doctor` in another terminal.");
  } catch (error) {
    if (!stopping) console.error(error instanceof Error ? error.message : String(error));
    stop(1);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
