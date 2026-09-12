import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  describeProvisionCommandFailure,
  provisionResourceExists,
  type ProvisionResourceKind,
} from "./provision-environment-core";
import {
  isEnvironmentTarget,
  loadWorkbenchEnvironment,
  referencedEnvironmentVariable,
  resolveEnvironmentReferences,
} from "./workbench-environment";

const providers = ["cloudflare", "fly", "vercel", "workos"] as const;
type Provider = (typeof providers)[number];
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
const providerValue = valueAfter("--provider") ?? "";
const execute = process.argv.includes("--execute");
if (!isEnvironmentTarget(target) || target === "local") {
  throw new Error("--target must be acceptance|production|demo");
}
if (!providers.includes(providerValue as Provider)) {
  throw new Error(`--provider must be ${providers.join("|")}`);
}
const provider = providerValue as Provider;
const manifest = loadWorkbenchEnvironment(target);
if (provider === "vercel" && manifest.web.provider !== "vercel") {
  throw new Error(`${target} uses ${manifest.web.provider}; Vercel provisioning is unavailable`);
}
const commit = git("rev-parse", "HEAD");
const confirmation = `${target}:provision-${provider}:${commit}`;
const descriptions: Record<Provider, string[]> = {
  cloudflare: [
    `D1 database ${manifest.cloudflare.d1DatabaseName}`,
    `R2 bucket ${manifest.cloudflare.r2BucketName}`,
    `Queue ${manifest.cloudflare.workerName}-notifications`,
    `Worker and Durable Object namespace ${manifest.cloudflare.workerName} (created on first deploy)`,
  ],
  fly: [`Fly application ${manifest.fly.appName}`],
  vercel: [
    `Vercel project ${manifest.web.projectName}`,
    `Vercel runtime ${manifest.web.framework} on Node ${manifest.web.nodeVersion}`,
  ],
  workos: [
    `AuthKit application ${manifest.workos.applicationName}`,
    `${target === "acceptance" ? "synthetic acceptance" : "isolated production acceptance"} organization/workspace`,
  ],
};

if (!execute) {
  console.log(`Dry run only: provision ${target} ${provider} at ${commit}.`);
  descriptions[provider].forEach((description) => console.log(`- ${description}`));
  console.log(`Re-run with --execute --confirm ${confirmation} after approval is recorded.`);
  if (provider === "workos") {
    console.log(
      "WorkOS AuthKit application and organization provisioning remains a dashboard operation.",
    );
  }
  process.exit(0);
}
if (valueAfter("--confirm") !== confirmation) {
  throw new Error(`provisioning requires --confirm ${confirmation}`);
}
if (git("status", "--porcelain")) throw new Error("hosted provisioning requires a clean worktree");
if (provider === "workos") {
  throw new Error(
    "WorkOS AuthKit application provisioning is not automated; complete the dashboard checklist and record same-commit evidence with release:evidence:record",
  );
}

type ProvisionCommand = {
  kind: ProvisionResourceKind;
  resourceName: string;
  inspect: [string, string[]];
  create: [string, string[]];
};
const commands: Record<Exclude<Provider, "workos">, ProvisionCommand[]> = {
  cloudflare: [
    {
      kind: "cloudflare-d1",
      resourceName: manifest.cloudflare.d1DatabaseName,
      inspect: ["pnpm", ["exec", "wrangler", "d1", "list", "--json"]],
      create: ["pnpm", ["exec", "wrangler", "d1", "create", manifest.cloudflare.d1DatabaseName]],
    },
    {
      kind: "cloudflare-r2",
      resourceName: manifest.cloudflare.r2BucketName,
      inspect: ["pnpm", ["exec", "wrangler", "r2", "bucket", "list"]],
      create: [
        "pnpm",
        ["exec", "wrangler", "r2", "bucket", "create", manifest.cloudflare.r2BucketName],
      ],
    },
    ...(target === "demo"
      ? []
      : [
          {
            kind: "cloudflare-queue",
            resourceName: `${manifest.cloudflare.workerName}-notifications`,
            inspect: ["pnpm", ["exec", "wrangler", "queues", "list"]],
            create: [
              "pnpm",
              [
                "exec",
                "wrangler",
                "queues",
                "create",
                `${manifest.cloudflare.workerName}-notifications`,
              ],
            ],
          } satisfies ProvisionCommand,
        ]),
  ],
  fly: [
    {
      kind: "fly-app",
      resourceName: manifest.fly.appName,
      inspect: ["fly", ["apps", "list", "--json"]],
      create: ["fly", ["apps", "create", manifest.fly.appName]],
    },
  ],
  vercel: [
    {
      kind: "vercel-project",
      resourceName: manifest.web.projectName,
      inspect: ["vercel", ["project", "list", "--non-interactive"]],
      create: ["vercel", ["project", "add", manifest.web.projectName, "--non-interactive"]],
    },
  ],
};
const commandEvidence: Array<{
  command: string;
  status: "configured" | "created" | "existing";
}> = [];
for (const resource of commands[provider]) {
  const [inspectCommand, inspectArgs] = resource.inspect;
  const inspected = spawnSync(inspectCommand, inspectArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (inspected.status !== 0) {
    throw new Error(
      describeProvisionCommandFailure({
        command: inspectCommand,
        args: inspectArgs,
        status: inspected.status,
        stdout: inspected.stdout,
        stderr: inspected.stderr,
      }),
    );
  }
  if (provisionResourceExists(resource.kind, inspected.stdout, resource.resourceName)) {
    commandEvidence.push({
      command: [inspectCommand, ...inspectArgs].join(" "),
      status: "existing",
    });
    continue;
  }

  const [createCommand, createArgs] = resource.create;
  const created = spawnSync(createCommand, createArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (created.status !== 0) {
    throw new Error(
      describeProvisionCommandFailure({
        command: createCommand,
        args: createArgs,
        status: created.status,
        stdout: created.stdout,
        stderr: created.stderr,
      }),
    );
  }
  commandEvidence.push({
    command: [createCommand, ...createArgs].join(" "),
    status: "created",
  });
}
if (provider === "vercel") {
  const web = manifest.web;
  if (web.provider !== "vercel") throw new Error("Vercel manifest required");
  const resolved = resolveEnvironmentReferences(manifest);
  if (resolved.manifest.web.provider !== "vercel") throw new Error("resolved web provider changed");
  const organizationVariable = referencedEnvironmentVariable(web.organizationId);
  if (organizationVariable && resolved.unresolved.includes(organizationVariable)) {
    throw new Error("Vercel provisioning requires the target organization ID variable");
  }
  const args = [
    "api",
    `/v9/projects/${manifest.web.projectName}`,
    "--method",
    "PATCH",
    "--raw-field",
    `framework=${manifest.web.framework}`,
    "--raw-field",
    `nodeVersion=${manifest.web.nodeVersion}`,
    "--silent",
  ];
  const configured = spawnSync("vercel", args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VERCEL_ORG_ID: resolved.manifest.web.organizationId,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (configured.status !== 0) {
    throw new Error(
      describeProvisionCommandFailure({
        command: "vercel",
        args,
        status: configured.status,
        stdout: configured.stdout,
        stderr: configured.stderr,
      }),
    );
  }
  commandEvidence.push({
    command: "vercel api /v9/projects/<target> --method PATCH",
    status: "configured",
  });
}
const directory = resolve(process.cwd(), "output/release", commit);
mkdirSync(directory, { recursive: true });
const evidencePath = resolve(directory, `provision-${target}-${provider}.json`);
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      target,
      commit,
      provider,
      status: "provisioned",
      resources: descriptions[provider],
      commands: commandEvidence,
      completedAt: new Date().toISOString(),
      operator: process.env.WORKBENCH_RELEASE_OPERATOR?.trim() || process.env.USER || "unknown",
      followUp:
        "Record provider resource IDs in protected target variables before rendering or deploying.",
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log(`Provisioned ${target} ${provider}; evidence written to ${evidencePath}.`);
