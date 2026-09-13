import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { renderEnvironmentConfig } from "./render-environment-config";
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
const execute = process.argv.includes("--execute");
if (!isEnvironmentTarget(target) || target === "local") {
  throw new Error("--target must be acceptance|production|demo");
}
const commit = git("rev-parse", "HEAD");
const confirmation = `${target}:backup-cloudflare:${commit}`;
const rendered = renderEnvironmentConfig(target, { releaseSha: commit });
if (!execute) {
  console.log(`Dry run only: encrypted-storage D1 backup for ${target} at ${commit}.`);
  console.log(`Re-run with --execute --confirm ${confirmation} after approval is recorded.`);
  process.exit(0);
}
if (valueAfter("--confirm") !== confirmation) {
  throw new Error(`backup requires --confirm ${confirmation}`);
}
if (git("status", "--porcelain")) throw new Error("hosted backup requires a clean worktree");
const encryptionKey = Buffer.from(
  process.env.WORKBENCH_BACKUP_ENCRYPTION_KEY?.trim() ?? "",
  "base64",
);
if (encryptionKey.byteLength !== 32) {
  throw new Error("WORKBENCH_BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes");
}

const directory = resolve(process.cwd(), "output/release", commit, "backups");
mkdirSync(directory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const plaintextPath = resolve(directory, `${target}-d1-${stamp}.sql.tmp`);
const backupPath = resolve(directory, `${target}-d1-${stamp}.sql.enc`);
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "d1",
    "export",
    rendered.manifest.cloudflare.d1DatabaseName,
    "--remote",
    "--config",
    rendered.wranglerPath,
    "--output",
    plaintextPath,
  ],
  { cwd: process.cwd(), env: process.env, stdio: "inherit" },
);
if (result.status !== 0) throw new Error(`wrangler d1 export exited with ${result.status}`);
let encrypted: Buffer;
try {
  const plaintext = readFileSync(plaintextPath);
  if (plaintext.byteLength === 0) throw new Error("D1 backup is empty");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  encrypted = Buffer.concat([Buffer.from("AMK1D1", "ascii"), iv, tag, ciphertext]);
  writeFileSync(backupPath, encrypted, { mode: 0o600 });
  chmodSync(backupPath, 0o600);
} finally {
  if (existsSync(plaintextPath)) unlinkSync(plaintextPath);
}
const evidence = {
  schemaVersion: 1,
  target,
  commit,
  kind: "d1-export",
  databaseName: rendered.manifest.cloudflare.d1DatabaseName,
  backupPath,
  encryption: "aes-256-gcm",
  checksum: createHash("sha256").update(encrypted).digest("hex"),
  sizeBytes: encrypted.byteLength,
  createdAt: new Date().toISOString(),
  operator: process.env.WORKBENCH_RELEASE_OPERATOR?.trim() || process.env.USER || "unknown",
};
const evidencePath = resolve(directory, `${target}-d1-${stamp}.json`);
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(`D1 backup and same-commit evidence written to ${directory}.`);
