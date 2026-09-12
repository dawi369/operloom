import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { isEnvironmentTarget, loadWorkbenchEnvironment } from "./workbench-environment";

type EvidenceRecord = {
  schemaVersion: 1;
  target: string;
  commit: string;
  kind: string;
  status: "passed" | "failed";
  command?: string[];
  operator?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  artifactPaths?: string[];
  identifiers?: Record<string, string>;
  serviceVersions?: Record<string, string>;
};

const valueAfter = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
};
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const target = valueAfter("--target") ?? "";
if (!isEnvironmentTarget(target) || target === "local") {
  throw new Error("--target must be acceptance|production|demo");
}
const commit = git("rev-parse", "HEAD");
if (git("status", "--porcelain")) throw new Error("evidence collection requires a clean worktree");
const root = resolve(process.cwd(), "output/release", commit);
const recordsDirectory = resolve(root, "records");
if (!existsSync(recordsDirectory)) throw new Error(`no evidence records found for ${commit}`);

const records = readdirSync(recordsDirectory)
  .filter((name) => name.endsWith(".json"))
  .map((name) => {
    const path = resolve(recordsDirectory, name);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as EvidenceRecord;
    if (parsed.schemaVersion !== 1 || parsed.commit !== commit || parsed.target !== target) {
      throw new Error(`${name} mixes target, commit, or evidence schema`);
    }
    return { ...parsed, path: path.slice(process.cwd().length + 1) };
  });
if (!records.length) throw new Error(`no ${target} evidence records found for ${commit}`);

const requiredKinds: Record<"acceptance" | "production" | "demo", string[]> = {
  acceptance: [
    "hosted.preflight",
    "hosted.public",
    "hosted.level3",
    "hosted.vault",
    "hosted.mutation",
    "hosted.data-lifecycle",
    "hosted.signed-in",
    "hosted.soak-24h",
    "hosted.alert-outage-redelivery",
  ],
  production: [
    "hosted.preflight",
    "hosted.configuration",
    "hosted.observability",
    "hosted.public",
    "hosted.signed-in-readonly",
  ],
  demo: [
    "hosted.preflight",
    "hosted.configuration",
    "hosted.observability",
    "hosted.public",
    "hosted.signed-in-readonly",
    "hosted.scale-to-zero",
  ],
};
const latestByKind = new Map<string, (typeof records)[number]>();
for (const record of records) {
  const existing = latestByKind.get(record.kind);
  if (!existing || Date.parse(record.completedAt) > Date.parse(existing.completedAt)) {
    latestByKind.set(record.kind, record);
  }
}
const missingKinds = requiredKinds[target].filter(
  (kind) => latestByKind.get(kind)?.status !== "passed",
);
if (missingKinds.length) {
  throw new Error(`missing passed ${target} evidence: ${missingKinds.join(", ")}`);
}

const requiredPromotionStages =
  target === "acceptance"
    ? ["disabled", "retained-data", "connections", "mutations"]
    : target === "demo"
      ? ["disabled"]
      : ["disabled", "retained-data", "connections"];
let previousPromotionTime = 0;
for (const featureStage of requiredPromotionStages) {
  const path = resolve(root, `promotion-${target}-${featureStage}.json`);
  if (!existsSync(path)) throw new Error(`missing ${target} ${featureStage} promotion evidence`);
  const promotion = JSON.parse(readFileSync(path, "utf8")) as {
    target?: unknown;
    commit?: unknown;
    featureStage?: unknown;
    status?: unknown;
    completedAt?: unknown;
  };
  const completedAt =
    typeof promotion.completedAt === "string" ? Date.parse(promotion.completedAt) : NaN;
  if (
    promotion.target !== target ||
    promotion.commit !== commit ||
    promotion.featureStage !== featureStage ||
    promotion.status !== "deployed" ||
    !Number.isFinite(completedAt) ||
    completedAt < previousPromotionTime
  ) {
    throw new Error(`${target} ${featureStage} promotion evidence is invalid or out of order`);
  }
  previousPromotionTime = completedAt;
}

const manifestSource = readFileSync(
  resolve(process.cwd(), "config/environments", `${target}.json`),
  "utf8",
);
const evidenceArtifacts = readdirSync(root)
  .filter((name) => name.endsWith(".json") && name !== "manifest.json")
  .sort()
  .map((name) => {
    const path = resolve(root, name);
    return {
      path: path.slice(process.cwd().length + 1),
      bytes: statSync(path).size,
      sha256: sha256(readFileSync(path)),
    };
  });
const screenshotDirectory = resolve(process.cwd(), "docs/assets/release");
const screenshots = existsSync(screenshotDirectory)
  ? readdirSync(screenshotDirectory)
      .filter((name) => name.endsWith(".png"))
      .sort()
      .map((name) => {
        const path = resolve(screenshotDirectory, name);
        return {
          path: path.slice(process.cwd().length + 1),
          bytes: statSync(path).size,
          sha256: sha256(readFileSync(path)),
        };
      })
  : [];
const manifest = {
  schemaVersion: 1,
  target,
  commit,
  collectedAt: new Date().toISOString(),
  environmentManifestSha256: sha256(manifestSource),
  status: missingKinds.length === 0 ? "passed" : "failed",
  requiredKinds: requiredKinds[target],
  featurePromotionOrder: requiredPromotionStages,
  operators: [...new Set(records.map((record) => record.operator).filter(Boolean))].sort(),
  serviceVersions: Object.assign({}, ...records.map((record) => record.serviceVersions ?? {})),
  identifiers: Object.assign({}, ...records.map((record) => record.identifiers ?? {})),
  evidenceArtifacts,
  screenshots,
  records,
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
if (/(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]+/i.test(serialized)) {
  throw new Error("release evidence contains a credential-shaped value");
}
loadWorkbenchEnvironment(target);
writeFileSync(resolve(root, "manifest.json"), serialized, { mode: 0o600 });
console.log(`Collected ${records.length} same-commit ${target} records under ${root}.`);
