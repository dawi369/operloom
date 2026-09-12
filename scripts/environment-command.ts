import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  featureStages,
  renderEnvironmentConfig,
  type FeatureStage,
} from "./render-environment-config";
import {
  environmentTargets,
  isEnvironmentTarget,
  loadWorkbenchEnvironment,
  resolveEnvironmentReferences,
  validateEnvironmentSet,
} from "./workbench-environment";

const phases = [
  "migrate-cloudflare",
  "bootstrap-cloudflare",
  "deploy-cloudflare",
  "deploy-fly",
  "deploy-web",
  "deploy-vercel",
] as const;
type Phase = (typeof phases)[number];
const isPhase = (value: string): value is Phase => phases.includes(value as Phase);
const valueAfter = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const run = (command: string, args: string[], env?: NodeJS.ProcessEnv) => {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? "signal"}`);
};
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
};

const target = valueAfter("--target") ?? "";
const phase = valueAfter("--phase") ?? "";
const execute = process.argv.includes("--execute");
const featureStageValue = valueAfter("--feature-stage") ?? "disabled";
if (!isEnvironmentTarget(target)) {
  throw new Error(`--target must be one of ${environmentTargets.join("|")}`);
}
if (target === "local") throw new Error("external environment commands reject target=local");
if (!isPhase(phase)) throw new Error(`--phase must be one of ${phases.join("|")}`);
if (!featureStages.includes(featureStageValue as FeatureStage)) {
  throw new Error(`--feature-stage must be one of ${featureStages.join("|")}`);
}
const featureStage = featureStageValue as FeatureStage;
if (phase !== "deploy-cloudflare" && featureStage !== "disabled") {
  throw new Error("--feature-stage is supported only for deploy-cloudflare");
}

const configured = environmentTargets.map(loadWorkbenchEnvironment);
const failures = validateEnvironmentSet(configured);
const resolved = resolveEnvironmentReferences(loadWorkbenchEnvironment(target));
if (resolved.unresolved.length)
  failures.push(`missing variables: ${resolved.unresolved.join(", ")}`);
if (failures.length) throw new Error(failures.join("; "));

const sha = git("rev-parse", "HEAD");
const confirmation = `${target}:${phase}:${featureStage}:${sha}`;
const rendered = renderEnvironmentConfig(target, {
  bootstrap: phase === "bootstrap-cloudflare",
  featureStage,
  releaseSha: sha,
});
const deployWeb =
  rendered.manifest.web.provider === "railway"
    ? {
        command: "railway",
        args: [
          "up",
          "--project",
          rendered.manifest.web.projectId,
          "--environment",
          rendered.manifest.web.environmentId,
          "--service",
          rendered.manifest.web.serviceId,
          "--detach",
          "-m",
          `Deploy Operloom ${target} ${sha}`,
        ],
        env: {
          ...process.env,
          RAILWAY_CALLER: "skill:use-railway@1.2.1",
          RAILWAY_AGENT_SESSION: `operloom-${target}-${sha.slice(0, 12)}`,
        },
      }
    : {
        command: "vercel",
        args: [
          "--prod",
          "--yes",
          "--build-env",
          `WORKBENCH_RELEASE_SHA=${sha}`,
          "--env",
          `WORKBENCH_RELEASE_SHA=${sha}`,
          "--build-env",
          `WORKBENCH_ENVIRONMENT=${target}`,
          "--env",
          `WORKBENCH_ENVIRONMENT=${target}`,
          "--build-env",
          `WORKBENCH_OPERATOR_ALERT_CONFORMANCE_MODE=${target === "acceptance" ? "true" : "false"}`,
          "--env",
          `WORKBENCH_OPERATOR_ALERT_CONFORMANCE_MODE=${target === "acceptance" ? "true" : "false"}`,
        ],
        env: {
          ...process.env,
          VERCEL_ORG_ID: rendered.manifest.web.organizationId,
          VERCEL_PROJECT_ID: rendered.manifest.web.projectId,
        },
      };

const commands: Record<Phase, { command: string; args: string[]; env?: NodeJS.ProcessEnv }> = {
  "migrate-cloudflare": {
    command: "pnpm",
    args: [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      rendered.manifest.cloudflare.d1DatabaseName,
      "--remote",
      "--config",
      rendered.wranglerPath,
    ],
  },
  "bootstrap-cloudflare": {
    command: "pnpm",
    args: ["exec", "wrangler", "deploy", "--config", rendered.wranglerPath],
  },
  "deploy-cloudflare": {
    command: "pnpm",
    args: ["exec", "wrangler", "deploy", "--config", rendered.wranglerPath],
  },
  "deploy-fly": {
    command: "fly",
    args: [
      "deploy",
      "--config",
      rendered.flyPath,
      "--app",
      rendered.manifest.fly.appName,
      "--ha=false",
    ],
  },
  "deploy-web": deployWeb,
  "deploy-vercel": {
    command: "vercel",
    args: [
      "--prod",
      "--yes",
      "--build-env",
      `WORKBENCH_RELEASE_SHA=${sha}`,
      "--env",
      `WORKBENCH_RELEASE_SHA=${sha}`,
      "--build-env",
      `WORKBENCH_ENVIRONMENT=${target}`,
      "--env",
      `WORKBENCH_ENVIRONMENT=${target}`,
      "--build-env",
      `WORKBENCH_OPERATOR_ALERT_CONFORMANCE_MODE=${target === "acceptance" ? "true" : "false"}`,
      "--env",
      `WORKBENCH_OPERATOR_ALERT_CONFORMANCE_MODE=${target === "acceptance" ? "true" : "false"}`,
    ],
    env: {
      ...process.env,
      VERCEL_ORG_ID:
        rendered.manifest.web.provider === "vercel" ? rendered.manifest.web.organizationId : "",
      VERCEL_PROJECT_ID:
        rendered.manifest.web.provider === "vercel" ? rendered.manifest.web.projectId : "",
    },
  },
};
const selected = commands[phase];

if (!execute) {
  console.log(`Dry run only: ${target} ${phase} (${featureStage}) at ${sha}.`);
  console.log(`Re-run with --execute --confirm ${confirmation} after approval is recorded.`);
  process.exit(0);
}
if (valueAfter("--confirm") !== confirmation) {
  throw new Error(`execution requires --confirm ${confirmation}`);
}
if (git("status", "--porcelain")) throw new Error("hosted execution requires a clean worktree");
if (phase === "migrate-cloudflare") {
  const backupPath = valueAfter("--backup-evidence");
  if (!backupPath || !existsSync(backupPath)) {
    throw new Error("migration execution requires --backup-evidence <same-commit JSON>");
  }
  const backup = JSON.parse(readFileSync(backupPath, "utf8")) as {
    target?: unknown;
    commit?: unknown;
    checksum?: unknown;
  };
  if (backup.target !== target || backup.commit !== sha || typeof backup.checksum !== "string") {
    throw new Error("backup evidence must match target and commit and include a checksum");
  }
}
if (["deploy-cloudflare", "deploy-fly", "deploy-web", "deploy-vercel"].includes(phase)) {
  const secretEvidencePath = resolve(
    process.cwd(),
    "output/release",
    sha,
    `secret-configuration-${target}.json`,
  );
  if (!existsSync(secretEvidencePath)) {
    throw new Error(`${phase} requires same-commit provider secret configuration evidence`);
  }
  const secretEvidence = JSON.parse(readFileSync(secretEvidencePath, "utf8")) as {
    target?: unknown;
    commit?: unknown;
    status?: unknown;
  };
  if (
    secretEvidence.target !== target ||
    secretEvidence.commit !== sha ||
    secretEvidence.status !== "configured"
  ) {
    throw new Error(`provider secret configuration evidence for ${target} is invalid`);
  }
}
if (phase === "deploy-vercel" && rendered.manifest.web.provider !== "vercel") {
  throw new Error(`${target} uses ${rendered.manifest.web.provider}; run deploy:web instead`);
}
if (phase === "deploy-cloudflare" && featureStage !== "disabled") {
  const stageOrder: FeatureStage[] = ["disabled", "retained-data", "connections", "mutations"];
  const previousStage = stageOrder[stageOrder.indexOf(featureStage) - 1];
  const previousPath = resolve(
    process.cwd(),
    "output/release",
    sha,
    `promotion-${target}-${previousStage}.json`,
  );
  if (!previousStage || !existsSync(previousPath)) {
    throw new Error(`feature promotion to ${featureStage} requires ${previousStage} evidence`);
  }
  const previous = JSON.parse(readFileSync(previousPath, "utf8")) as {
    target?: unknown;
    commit?: unknown;
    featureStage?: unknown;
    status?: unknown;
  };
  if (
    previous.target !== target ||
    previous.commit !== sha ||
    previous.featureStage !== previousStage ||
    previous.status !== "deployed"
  ) {
    throw new Error(`feature promotion evidence for ${previousStage} is invalid`);
  }
}
run(selected.command, selected.args, selected.env);
const evidenceDirectory = resolve(process.cwd(), "output/release", sha);
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(
  resolve(
    evidenceDirectory,
    phase === "deploy-cloudflare"
      ? `promotion-${target}-${featureStage}.json`
      : `deployment-${target}-${phase}.json`,
  ),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      target,
      commit: sha,
      phase,
      featureStage,
      status: phase === "bootstrap-cloudflare" ? "bootstrapped" : "deployed",
      ...(phase === "bootstrap-cloudflare" ? { publicIngress: false } : {}),
      completedAt: new Date().toISOString(),
      operator: process.env.WORKBENCH_RELEASE_OPERATOR?.trim() || process.env.USER || "unknown",
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
