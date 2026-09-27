import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  repoSnapshotError,
  validateRepoSnapshotInput,
  type RepoSnapshotCommandMetric,
  type RepoSnapshotOutput,
  type RepoSnapshotResult,
} from "./repo-snapshot";

const timeoutMs = 10_000;
const maxStdoutBytes = 64 * 1024;
const maxStderrBytes = 8 * 1024;

const redactOutput = (value: string) =>
  value
    .replace(/(api[_-]?key|token|secret|password)=?[^\s"']*/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");

const byteSlice = (value: string, maxBytes: number) => {
  const buffer = Buffer.from(value, "utf8");
  return buffer.length <= maxBytes
    ? value
    : `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated]`;
};

const runCommand = async (
  name: string,
  command: string,
  args: string[],
): Promise<{ metric: RepoSnapshotCommandMetric; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = byteSlice(stdout + chunk.toString("utf8"), maxStdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = byteSlice(stderr + chunk.toString("utf8"), maxStderrBytes);
    });
    child.on("error", (error: Error) => {
      clearTimeout(timeout);
      resolve({
        stdout: "",
        stderr: redactOutput(error.message),
        metric: {
          name,
          command: [command, ...args].join(" "),
          status: "unavailable",
          durationMs: Date.now() - startedAt,
          stdoutBytes: 0,
          stderrBytes: Buffer.byteLength(error.message),
        },
      });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timeout);
      const safeStdout = redactOutput(stdout);
      const safeStderr = redactOutput(stderr);
      resolve({
        stdout: safeStdout,
        stderr: safeStderr,
        metric: {
          name,
          command: [command, ...args].join(" "),
          status: timedOut ? "timeout" : code === 0 ? "completed" : "failed",
          durationMs: Date.now() - startedAt,
          exitCode: code ?? undefined,
          stdoutBytes: Buffer.byteLength(safeStdout),
          stderrBytes: Buffer.byteLength(safeStderr),
        },
      });
    });
  });

const skipped = (name: string) => ({
  stdout: "",
  stderr: "",
  metric: {
    name,
    command: "skipped",
    status: "completed" as const,
    durationMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
  },
});

const readPackageJson = async () => {
  try {
    const parsed = JSON.parse(await readFile("package.json", "utf8")) as {
      packageManager?: string;
      scripts?: Record<string, unknown>;
    };
    return {
      packageManager: parsed.packageManager,
      scripts: parsed.scripts
        ? Object.keys(parsed.scripts)
            .filter((name) => /^[a-z0-9:_-]{1,64}$/i.test(name))
            .sort()
            .slice(0, 40)
        : [],
    };
  } catch {
    return { packageManager: undefined, scripts: [] };
  }
};

export const runRepoSnapshot = async (input: unknown): Promise<RepoSnapshotResult> => {
  const parsed = validateRepoSnapshotInput(input);
  if ("code" in parsed) return { ok: false, error: parsed };
  const startedAt = Date.now();
  const [files, docs, configs, packageInfo] = await Promise.all([
    runCommand("repo-files", "rg", [
      "--files",
      "-g",
      "!node_modules",
      "-g",
      "!.next",
      "-g",
      "!.git",
      "-g",
      "!.env*",
      "-g",
      "!*.tsbuildinfo",
    ]),
    parsed.includeDocs === false
      ? Promise.resolve(skipped("docs"))
      : runCommand("docs", "rg", ["--files", "docs"]),
    parsed.includeConfig === false
      ? Promise.resolve(skipped("config"))
      : runCommand("config", "rg", [
          "--files",
          "-g",
          "package.json",
          "-g",
          "pnpm-lock.yaml",
          "-g",
          "*.config.*",
          "-g",
          "*.toml",
          "-g",
          "*.jsonc",
          "-g",
          "Dockerfile*",
          "-g",
          ".dockerignore",
        ]),
    readPackageJson(),
  ]);
  const commandMetrics = [files.metric, docs.metric, configs.metric];
  if (files.metric.status === "unavailable") {
    return {
      ok: false,
      error: repoSnapshotError("repo_snapshot_unavailable", "ripgrep is not available."),
    };
  }
  const list = (stdout: string, limit: number) =>
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith(".env"))
      .slice(0, limit);
  const repoFiles = list(files.stdout, 80);
  const docFiles = list(docs.stdout, 40);
  const configFiles = list(configs.stdout, 40);
  const output: RepoSnapshotOutput = {
    status: "ok",
    summary: `Repository snapshot captured ${repoFiles.length} files, ${docFiles.length} docs, and ${configFiles.length} config files.`,
    packageManager: packageInfo.packageManager,
    scripts: parsed.includeScripts === false ? [] : packageInfo.scripts,
    repoFiles,
    docs: docFiles,
    configFiles,
    signals: [
      ...(packageInfo.packageManager
        ? [
            {
              kind: "package" as const,
              title: "Package manager",
              value: packageInfo.packageManager,
            },
          ]
        : []),
      { kind: "runtime", title: "Runner", value: "operloom-runner" },
      ...configFiles
        .slice(0, 8)
        .map((file) => ({ kind: "config" as const, title: "Config file", value: file })),
      ...docFiles
        .slice(0, 8)
        .map((file) => ({ kind: "docs" as const, title: "Doc file", value: file })),
    ],
    commandMetrics,
    timingMs: Date.now() - startedAt,
  };
  return { ok: true, output };
};
