import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { manifest } from "../examples/complex-operator/manifest";

const root = process.cwd();
const outputDirectory = resolve(root, "output/playwright");
const seedFile = resolve(outputDirectory, "complex-operator-seed.sql");
const prompt = readFileSync(resolve(root, manifest.promptPath), "utf8");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

const behavior = {
  source: "template-snapshot",
  format: manifest.format,
  templateId: "pack-complex-operator",
  version: manifest.version,
  authoring: {
    kind: "local_agent_pack",
    format: manifest.format,
    source: "agent-pack",
    editable: false,
    snapshotOnCreate: true,
    packId: manifest.id,
    packVersion: manifest.version,
    folderPath: manifest.folderPath,
    codePath: manifest.codePath,
    promptPath: manifest.promptPath,
  },
  pack: {
    apiVersion: manifest.apiVersion,
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    capabilityLevel: manifest.capabilityLevel,
    folderPath: manifest.folderPath,
    codePath: manifest.codePath,
    promptPath: manifest.promptPath,
    tools: manifest.tools,
    workflows: manifest.workflows,
    ui: manifest.ui,
    risk: manifest.risk,
    connections: manifest.connections,
    context: manifest.context,
    managedState: manifest.managedState,
    triggers: manifest.triggers,
    artifactRenderers: manifest.artifactRenderers,
    healthChecks: manifest.healthChecks,
    evals: manifest.evals,
    compatibility: manifest.compatibility,
    resourceLimits: manifest.resourceLimits,
    smokeScenarios: manifest.smokeScenarios,
  },
  prompt,
};

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  seedFile,
  `INSERT INTO agents (
  id, workspace_id, name, description, status, is_default, created_by_user_id,
  data_json, created_at, updated_at
) VALUES (
  'e2e-complex-agent',
  'workspace:local-api:e2e-owner:default',
  'Complex Operator Conformance',
  'Generated Runtime Module v1 service-boundary fixture.',
  'active',
  0,
  'e2e-owner',
  ${quote(JSON.stringify({ profile: "operator", behavior }))},
  '2026-07-30T00:00:00.000Z',
  '2026-07-30T00:00:00.000Z'
);
`,
);

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "d1",
    "execute",
    "assistant_mk1_local",
    "--local",
    "--persist-to",
    "output/playwright/state",
    "--file",
    seedFile,
    "--config",
    "cloudflare/control-plane/wrangler.jsonc",
    "--yes",
  ],
  { cwd: root, encoding: "utf8" },
);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  throw new Error(`Complex Operator E2E seed failed with exit code ${result.status ?? "unknown"}.`);
}
