import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateD1MigrationFiles } from "./d1-migration-policy";

type D1Result<Row> = Array<{
  results: Row[];
  success: boolean;
}>;

type SchemaRow = {
  name: string;
  sql: string;
  type: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, "cloudflare/control-plane/wrangler.jsonc");
const migrationsPath = join(repoRoot, "cloudflare/control-plane/migrations");
const resetSchemaPath = join(repoRoot, "cloudflare/control-plane/schema.sql");
const database = "operloom_local";
const databaseId = "00000000-0000-0000-0000-000000000000";

function wrangler(args: string[]): string {
  return execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "true", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function localArgs(persistTo: string, wranglerConfigPath = configPath): string[] {
  return [database, "--local", "--persist-to", persistTo, "--config", wranglerConfigPath];
}

function executeJson<Row>(persistTo: string, command: string): Row[] {
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
  const parsed = JSON.parse(output.slice(jsonStart)) as D1Result<Row>;
  const result = parsed[0];

  if (!result?.success) {
    throw new Error("Wrangler returned an unsuccessful D1 query result.");
  }

  return result.results;
}

function applyMigrations(persistTo: string): void {
  wrangler(["d1", "migrations", "apply", ...localArgs(persistTo)]);
}

function applyMigrationPrefix(
  persistTo: string,
  tempRoot: string,
  migrationFiles: Array<{ name: string; sql: string }>,
): void {
  const prefixRoot = join(tempRoot, "previous-migration-config");
  const prefixMigrationsPath = join(prefixRoot, "migrations");
  const prefixConfigPath = join(prefixRoot, "wrangler.jsonc");
  mkdirSync(prefixMigrationsPath, { recursive: true });

  for (const migration of migrationFiles) {
    copyFileSync(join(migrationsPath, migration.name), join(prefixMigrationsPath, migration.name));
  }

  writeFileSync(
    prefixConfigPath,
    JSON.stringify(
      {
        name: "operloom-d1-migration-verifier",
        main: join(repoRoot, "cloudflare/control-plane/src/index.ts"),
        compatibility_date: "2026-06-01",
        d1_databases: [
          {
            binding: "DB",
            database_name: database,
            database_id: databaseId,
            migrations_dir: "migrations",
            migrations_table: "d1_migrations",
          },
        ],
      },
      null,
      2,
    ),
  );

  wrangler(["d1", "migrations", "apply", ...localArgs(persistTo, prefixConfigPath)]);
}

function normalizeSchema(rows: SchemaRow[]): SchemaRow[] {
  return rows.map((row) => ({
    ...row,
    sql: row.sql
      .replace(/\bIF NOT EXISTS\b/gi, "")
      .replace(/\s+/g, " ")
      .replace(/\s+([,)])/g, "$1")
      .replace(/([(,])\s+/g, "$1")
      .trim(),
  }));
}

function readMigrationFiles(): Array<{ name: string; sql: string }> {
  return readdirSync(migrationsPath)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(migrationsPath, name), "utf8"),
    }));
}

function main(): void {
  const migrationFiles = readMigrationFiles();
  const policyErrors = validateD1MigrationFiles(migrationFiles);

  if (migrationFiles.length === 0) {
    policyErrors.push("At least one D1 migration is required.");
  }

  if (policyErrors.length > 0) {
    throw new Error(`D1 migration policy failed:\n- ${policyErrors.join("\n- ")}`);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "operloom-d1-migrations-"));
  const migratedState = join(tempRoot, "migrated");
  const previousState = join(tempRoot, "previous");
  const resetState = join(tempRoot, "reset");

  try {
    applyMigrations(migratedState);
    wrangler(["d1", "execute", ...localArgs(resetState), "--file", resetSchemaPath, "--yes"]);

    const schemaQuery = [
      "SELECT type, name, sql FROM sqlite_master",
      "WHERE sql IS NOT NULL",
      "AND name NOT LIKE 'sqlite_%'",
      "AND name NOT IN ('_cf_METADATA', 'd1_migrations')",
      "ORDER BY type, name",
    ].join(" ");
    const migratedSchema = normalizeSchema(executeJson<SchemaRow>(migratedState, schemaQuery));
    const resetSchema = normalizeSchema(executeJson<SchemaRow>(resetState, schemaQuery));

    if (JSON.stringify(migratedSchema) !== JSON.stringify(resetSchema)) {
      const migratedByName = new Map(
        migratedSchema.map((row) => [`${row.type}:${row.name}`, row.sql]),
      );
      const resetByName = new Map(resetSchema.map((row) => [`${row.type}:${row.name}`, row.sql]));
      const differences = Array.from(new Set([...migratedByName.keys(), ...resetByName.keys()]))
        .filter((name) => migratedByName.get(name) !== resetByName.get(name))
        .map(
          (name) =>
            `${name}\n  migrated: ${migratedByName.get(name) ?? "<missing>"}\n  reset: ${resetByName.get(name) ?? "<missing>"}`,
        );
      throw new Error(
        `Applied migrations do not match cloudflare/control-plane/schema.sql:\n${differences.join("\n")}`,
      );
    }

    executeJson(
      migratedState,
      `INSERT INTO users (id, status, created_at, updated_at) VALUES ('fence-user', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
       INSERT INTO workspaces (id, account_id, account_source, name, status, created_by_user_id, created_at, updated_at) VALUES ('fence-workspace', 'fence-account', 'test', 'Fence workspace', 'active', 'fence-user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
       INSERT INTO control_workspace_write_fences (workspace_id, job_id, status, lease_owner, lease_expires_at, acquired_at, updated_at) VALUES ('fence-workspace', 'fence-job', 'active', 'migration-verifier', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z') RETURNING workspace_id`,
    );
    let fencedWriteRejected = false;
    try {
      executeJson(
        migratedState,
        `INSERT INTO agents (id, workspace_id, name, status, created_by_user_id, created_at, updated_at) VALUES ('fenced-agent', 'fence-workspace', 'Blocked', 'active', 'fence-user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z') RETURNING id`,
      );
    } catch {
      fencedWriteRejected = true;
    }
    if (!fencedWriteRejected) {
      throw new Error("Workspace export fence did not reject a canonical tenant write.");
    }
    executeJson(
      migratedState,
      `DELETE FROM control_workspace_write_fences WHERE workspace_id = 'fence-workspace';
       INSERT INTO agents (id, workspace_id, name, status, created_by_user_id, created_at, updated_at) VALUES ('fenced-agent', 'fence-workspace', 'Accepted', 'active', 'fence-user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z') RETURNING id`,
    );

    const markerId = "migration-verification-user";
    executeJson(
      migratedState,
      `INSERT INTO users (id, status, created_at, updated_at) VALUES ('${markerId}', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z') RETURNING id`,
    );
    applyMigrations(migratedState);

    const marker = executeJson<{ count: number }>(
      migratedState,
      `SELECT COUNT(*) AS count FROM users WHERE id = '${markerId}'`,
    );
    if (marker[0]?.count !== 1) {
      throw new Error("Reapplying migrations did not preserve retained data.");
    }

    const ledger = executeJson<{ count: number }>(
      migratedState,
      "SELECT COUNT(*) AS count FROM d1_migrations",
    );
    if (ledger[0]?.count !== migrationFiles.length) {
      throw new Error(
        `D1 migration ledger has ${ledger[0]?.count ?? 0} rows; expected ${migrationFiles.length}.`,
      );
    }

    if (migrationFiles.length > 1) {
      applyMigrationPrefix(previousState, tempRoot, migrationFiles.slice(0, -1));
      applyMigrations(previousState);

      const upgradedSchema = normalizeSchema(executeJson<SchemaRow>(previousState, schemaQuery));
      if (JSON.stringify(upgradedSchema) !== JSON.stringify(migratedSchema)) {
        throw new Error("Applying the latest migration last did not reach the current schema.");
      }

      const upgradedLedger = executeJson<{ count: number }>(
        previousState,
        "SELECT COUNT(*) AS count FROM d1_migrations",
      );
      if (upgradedLedger[0]?.count !== migrationFiles.length) {
        throw new Error(
          `Upgraded D1 migration ledger has ${upgradedLedger[0]?.count ?? 0} rows; expected ${migrationFiles.length}.`,
        );
      }
    }

    console.log(
      `Verified ${migrationFiles.length} D1 migration(s): empty apply, schema parity, retained-data reapply, ledger integrity${migrationFiles.length > 1 ? ", and latest-migration upgrade parity" : ""}.`,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
