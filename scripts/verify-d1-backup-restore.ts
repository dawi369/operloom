import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type D1Result<Row> = Array<{ results: Row[]; success: boolean }>;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, "cloudflare/control-plane/wrangler.jsonc");
const database = "assistant_mk1_local";

const wrangler = (args: string[]) =>
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "true", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

const localArgs = (persistTo: string) => [
  database,
  "--local",
  "--persist-to",
  persistTo,
  "--config",
  configPath,
];

const execute = <Row>(persistTo: string, command: string): Row[] => {
  const output = wrangler([
    "d1",
    "execute",
    ...localArgs(persistTo),
    "--command",
    command,
    "--json",
  ]);
  const jsonStart = output.indexOf("[");
  if (jsonStart < 0) throw new Error("Wrangler did not return JSON output.");
  const result = (JSON.parse(output.slice(jsonStart)) as D1Result<Row>)[0];
  if (!result?.success) throw new Error("Wrangler returned an unsuccessful D1 query result.");
  return result.results;
};

const findSqliteDatabase = (root: string) => {
  const entry = readdirSync(root, { recursive: true, withFileTypes: true }).find(
    (item) => item.isFile() && item.name.endsWith(".sqlite"),
  );
  if (!entry) throw new Error("Wrangler local D1 database file was not found.");
  return join(entry.parentPath, entry.name);
};

const sqliteJson = <Row>(databasePath: string, query: string): Row[] => {
  const output = execFileSync("sqlite3", ["-json", databasePath, query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.trim() ? (JSON.parse(output) as Row[]) : [];
};

const main = () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "operloom-d1-backup-"));
  const sourceState = join(tempRoot, "source");
  const restoredDatabase = join(tempRoot, "restored.sqlite");
  const backupPath = join(tempRoot, "backup.sql");
  const userId = "backup-verification-user";
  const workspaceId = "backup-verification-workspace";
  const artifactId = "backup-verification-artifact";

  try {
    wrangler(["d1", "migrations", "apply", ...localArgs(sourceState)]);
    execute(
      sourceState,
      [
        `INSERT INTO users (id, status, created_at, updated_at) VALUES ('${userId}', 'active', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')`,
        `INSERT INTO workspaces (id, account_id, account_source, name, status, is_default, created_by_user_id, created_at, updated_at) VALUES ('${workspaceId}', 'backup-account', 'test', 'Backup verification', 'active', 1, '${userId}', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')`,
        `INSERT INTO control_artifacts (id, user_id, workspace_id, kind, uri, title, mime_type, size_bytes, retention_class, data_json, created_at) VALUES ('${artifactId}', '${userId}', '${workspaceId}', 'backup-verification', 'artifact://${artifactId}', 'Backup verification artifact', 'application/json', 2, 'permanent', '{"ok":true}', '2026-07-12T00:00:00.000Z')`,
      ].join("; "),
    );
    const sourceDatabase = findSqliteDatabase(sourceState);
    const dump = execFileSync("sqlite3", [sourceDatabase, ".dump"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(backupPath, dump, { mode: 0o600 });
    execFileSync("sqlite3", [restoredDatabase], {
      input: dump,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const restored = sqliteJson<{
      id: string;
      user_id: string;
      workspace_id: string;
      retention_class: string;
      data_json: string;
    }>(
      restoredDatabase,
      `SELECT id, user_id, workspace_id, retention_class, data_json FROM control_artifacts WHERE id = '${artifactId}'`,
    );
    if (
      restored.length !== 1 ||
      restored[0]?.user_id !== userId ||
      restored[0]?.workspace_id !== workspaceId ||
      restored[0]?.retention_class !== "permanent" ||
      restored[0]?.data_json !== '{"ok":true}'
    ) {
      throw new Error("Restored D1 state did not preserve the verification artifact.");
    }

    const migrationCount = sqliteJson<{ count: number }>(
      restoredDatabase,
      "SELECT COUNT(*) AS count FROM d1_migrations",
    )[0]?.count;
    if (!migrationCount || migrationCount < 5) {
      throw new Error("Restored D1 state did not preserve the migration ledger.");
    }

    const checksum = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
    console.log(
      `Verified D1 backup and restore with ${migrationCount} migrations; backup sha256=${checksum}.`,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
};

main();
