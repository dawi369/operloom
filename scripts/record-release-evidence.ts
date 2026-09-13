import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { isEnvironmentTarget } from "./workbench-environment";

const valueAfter = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
};

const target = valueAfter("--target") ?? "";
const kind = valueAfter("--kind")?.trim() ?? "";
const inputPath = valueAfter("--input");
if (!isEnvironmentTarget(target) || target === "local") {
  throw new Error("--target must be acceptance|production|demo");
}
if (!/^hosted\.[a-z0-9][a-z0-9.-]+$/.test(kind)) throw new Error("--kind is invalid");
if (!inputPath || !existsSync(inputPath))
  throw new Error("--input must name an evidence JSON file");
const commit = git("rev-parse", "HEAD");
if (git("status", "--porcelain")) throw new Error("release evidence requires a clean worktree");
const confirmation = `${target}:${kind}:${commit}`;
if (valueAfter("--confirm") !== confirmation) {
  throw new Error(`recording requires --confirm ${confirmation}`);
}

const input = JSON.parse(readFileSync(inputPath, "utf8")) as {
  schemaVersion?: unknown;
  target?: unknown;
  commit?: unknown;
  status?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  operator?: unknown;
  artifactPaths?: unknown;
  identifiers?: unknown;
  serviceVersions?: unknown;
  evidence?: unknown;
};
if (
  input.schemaVersion !== 1 ||
  input.target !== target ||
  input.commit !== commit ||
  input.status !== "passed" ||
  typeof input.startedAt !== "string" ||
  typeof input.completedAt !== "string" ||
  !Number.isFinite(Date.parse(input.startedAt)) ||
  !Number.isFinite(Date.parse(input.completedAt)) ||
  Date.parse(input.completedAt) < Date.parse(input.startedAt)
) {
  throw new Error("evidence input must be passed, same-target, same-commit, and timestamped");
}
if (
  kind === "hosted.soak-24h" &&
  Date.parse(input.completedAt) - Date.parse(input.startedAt) < 24 * 60 * 60 * 1_000
) {
  throw new Error("24-hour soak evidence must contain at least 24 elapsed hours");
}
const artifactPaths = Array.isArray(input.artifactPaths)
  ? input.artifactPaths.filter((value): value is string => typeof value === "string")
  : [];
for (const path of artifactPaths) {
  if (!existsSync(resolve(process.cwd(), path)))
    throw new Error(`evidence artifact is missing: ${path}`);
}
const record = {
  schemaVersion: 1,
  target,
  commit,
  kind,
  command: ["manual-observation", inputPath],
  operator:
    typeof input.operator === "string" && input.operator.trim()
      ? input.operator.trim()
      : process.env.WORKBENCH_RELEASE_OPERATOR?.trim() || process.env.USER || "unknown",
  startedAt: input.startedAt,
  completedAt: input.completedAt,
  durationMs: Date.parse(input.completedAt) - Date.parse(input.startedAt),
  status: "passed" as const,
  exitCode: 0,
  artifactPaths,
  identifiers:
    input.identifiers && typeof input.identifiers === "object" ? input.identifiers : undefined,
  serviceVersions:
    input.serviceVersions && typeof input.serviceVersions === "object"
      ? input.serviceVersions
      : undefined,
  evidence: input.evidence,
};
const serialized = `${JSON.stringify(record, null, 2)}\n`;
if (/(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]+/i.test(serialized)) {
  throw new Error("release evidence contains a credential-shaped value");
}
const recordsDirectory = resolve(process.cwd(), "output/release", commit, "records");
mkdirSync(recordsDirectory, { recursive: true });
const path = resolve(
  recordsDirectory,
  `${new Date(input.completedAt).toISOString().replace(/[:.]/g, "-")}-${kind}.json`,
);
writeFileSync(path, serialized, { mode: 0o600 });
console.log(`Recorded ${kind} evidence at ${path}.`);
