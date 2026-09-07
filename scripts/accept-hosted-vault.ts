import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createWorkOSCredentialVault } from "../cloudflare/control-plane/src/credential-vault";
import type { Env } from "../cloudflare/control-plane/src/types";
import { isEnvironmentTarget } from "./workbench-environment";

const main = async () => {
  const enabled = process.env.WORKBENCH_HOSTED_VAULT_MODE === "true";
  const target = process.env.WORKBENCH_ENVIRONMENT?.trim() ?? "";
  const commit = process.env.GITHUB_SHA?.trim() ?? "";
  const workspaceId = process.env.HOSTED_VAULT_WORKSPACE_ID?.trim() ?? "";
  if (!enabled) throw new Error("WORKBENCH_HOSTED_VAULT_MODE=true is required");
  if (!isEnvironmentTarget(target) || target === "local") {
    throw new Error("WORKBENCH_ENVIRONMENT must be acceptance|production");
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("GITHUB_SHA must be a full commit");
  if (!workspaceId) throw new Error("HOSTED_VAULT_WORKSPACE_ID is required");
  if (!process.env.WORKOS_API_KEY?.trim()) throw new Error("WORKOS_API_KEY is required");

  const vault = createWorkOSCredentialVault({
    WORKOS_API_KEY: process.env.WORKOS_API_KEY,
    WORKOS_VAULT_API_URL: process.env.WORKOS_VAULT_API_URL,
  } as Env);
  const firstValue = `vault-acceptance-${crypto.randomUUID()}`;
  const secondValue = `vault-acceptance-rotated-${crypto.randomUUID()}`;
  const created = await vault.create({
    context: { workspaceId },
    name: `assistant-mk1-acceptance-${Date.now()}`,
    value: firstValue,
  });
  const read = await vault.read(created);
  if (read.value !== firstValue || read.version !== created.version)
    throw new Error("Vault read evidence mismatch");
  const rotated = await vault.replace({ ...created, value: secondValue });
  const rotatedRead = await vault.read(rotated);
  if (rotatedRead.value !== secondValue || rotatedRead.version !== rotated.version)
    throw new Error("Vault rotation evidence mismatch");
  await vault.revoke(rotated);
  const deletionProbe = await vault.create({
    context: { workspaceId },
    name: `operloom-delete-acceptance-${Date.now()}`,
    value: `vault-delete-acceptance-${crypto.randomUUID()}`,
  });
  await vault.delete(deletionProbe);

  const report = {
    schemaVersion: 1,
    target,
    commit,
    generatedAt: new Date().toISOString(),
    ok: true,
    checks: ["create", "read-version", "replace", "read-rotated-version", "revoke", "delete"],
    secretDisclosure: false,
  };
  const directory = resolve(process.cwd(), "output/release", commit);
  mkdirSync(directory, { recursive: true });
  const outputPath = resolve(directory, "vault-acceptance.json");
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...report, outputPath }, null, 2));
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
