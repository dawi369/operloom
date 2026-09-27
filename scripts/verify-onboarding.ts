import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { initializeWorkbench } from "./workbench-init";
import { diagnoseWorkbench } from "./workbench-doctor-core";

const root = process.cwd();
const fixture = resolve(root, "output/onboarding-check");

const main = async () => {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(resolve(fixture, "cloudflare/control-plane"), { recursive: true });
  copyFileSync(resolve(root, ".env.example"), resolve(fixture, ".env.example"));
  for (const file of [".dev.vars.example", "schema.sql", "wrangler.jsonc"]) {
    copyFileSync(
      resolve(root, "cloudflare/control-plane", file),
      resolve(fixture, "cloudflare/control-plane", file),
    );
  }
  await initializeWorkbench({ root: fixture, runMigration: false });
  const result = await diagnoseWorkbench({
    root: fixture,
    offline: true,
    environment: {},
    allowMissingProviderKey: true,
  });
  if (result.failures.length) throw new Error(result.failures.join("\n"));
  const worker = readFileSync(resolve(fixture, "cloudflare/control-plane/.dev.vars"), "utf8");
  if (worker.includes("OPERLOOM_EXECUTOR_")) {
    throw new Error("Local setup still contains retired executor configuration");
  }
  console.log("Clean-clone local configuration and offline doctor contract verified.");
};

void main()
  .finally(() => rmSync(fixture, { recursive: true, force: true }))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
