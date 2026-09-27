import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const walk = (directory: string): string[] =>
  readdirSync(join(root, directory)).flatMap((name) => {
    const path = join(directory, name);
    return statSync(join(root, path)).isDirectory() ? walk(path) : [path];
  });
const readMatching = (directory: string, pattern: RegExp) =>
  walk(directory)
    .filter((path) => pattern.test(path))
    .sort()
    .map(read)
    .join("\n");
const finalTableSql = (table: string) => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(read("cloudflare/control-plane/schema.sql"));
    const row = database
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    if (!row) throw new Error(`schema.sql does not create ${table}`);
    return String(row.sql);
  } finally {
    database.close();
  }
};

describe("runtime extension architecture", () => {
  it("keeps executable runner registries outside the Worker graph", () => {
    const workerSources = walk("cloudflare/control-plane/src").filter(
      (path) => path.endsWith(".ts") && !path.endsWith("runtime-architecture.test.ts"),
    );
    for (const path of workerSources) {
      const source = read(path);
      expect(source, path).not.toMatch(/generated\/agent-runtime\/runner/);
      expect(source, path).not.toMatch(/core-runner-provider/);
    }
  });

  it("keeps runner and Admin/model dispatch generic", () => {
    const runner = read("runner/server.ts");
    const dispatchers = [
      read("cloudflare/control-plane/src/runtime-admin-tool.ts"),
      read("cloudflare/control-plane/src/runtime-admin-execution.ts"),
      read("cloudflare/control-plane/src/model-tools.ts"),
    ];
    for (const concreteToolId of ["repo.snapshot", "url.inspect", "polymarket.market.search"]) {
      expect(runner).not.toContain(concreteToolId);
      for (const dispatcher of dispatchers) expect(dispatcher).not.toContain(concreteToolId);
    }
  });

  it("has no obsolete runtime routes or compatibility registries", () => {
    const obsolete = [
      "cloudflare/control-plane/src/core-workflow-provider.ts",
      "cloudflare/control-plane/src/generic-workflow-kernel.ts",
      "cloudflare/control-plane/src/demo-run-store.ts",
      "cloudflare/control-plane/src/demo-runs.ts",
      "lib/workbench/tool-registry.ts",
      "lib/workbench/demo-tool.ts",
      "app/api/workbench/cloudflare-demo-runs/route.ts",
      "app/api/workbench/executors/demo-inspect/route.ts",
      "app/api/workbench/data-export/route.ts",
    ];
    expect(obsolete.filter((path) => existsSync(join(root, path)))).toEqual([]);
    expect(read("cloudflare/control-plane/src/index.ts")).not.toContain(
      "/internal/workbench/run-callbacks",
    );
    expect(read("cloudflare/control-plane/src/index.ts")).not.toContain(
      'url.pathname === "/workbench/data-export"',
    );
  });

  it("keeps extension execution modules bounded", () => {
    const modules = [...walk("cloudflare/control-plane/src"), "runner/server.ts"].filter((path) =>
      /(?:runtime|tool-(?:execution|approvals|policy-admin)|runner\/server)\.ts$/.test(
        relative(root, join(root, path)),
      ),
    );
    for (const path of modules) {
      expect(read(path).split("\n").length, path).toBeLessThanOrEqual(1_200);
    }
  });

  it("keeps decomposed runtime modules and compatibility facades bounded", () => {
    const productionModules = [
      ...walk("cloudflare/control-plane/src").filter((path) =>
        /(?:workspace-data|action-authority|session-agent|connection-broker).*\.ts$/.test(path),
      ),
      ...walk("lib/workbench/contracts").filter((path) => path.endsWith(".ts")),
      ...walk("lib/workbench/control-plane-client").filter((path) => path.endsWith(".ts")),
      ...walk("lib/workbench/agent-connection").filter((path) => /\.tsx?$/.test(path)),
    ].filter((path) => !path.endsWith(".test.ts"));
    for (const path of productionModules) {
      expect(read(path).split("\n").length, path).toBeLessThanOrEqual(800);
    }
    for (const path of [
      "cloudflare/control-plane/src/workspace-data-lifecycle.ts",
      "cloudflare/control-plane/src/action-authority.ts",
      "cloudflare/control-plane/src/session-agent.ts",
      "cloudflare/control-plane/src/connection-broker.ts",
      "lib/workbench/workbench-types.ts",
      "lib/workbench/cloudflare-control-plane-client.ts",
      "lib/workbench/use-agent-connection.tsx",
    ]) {
      expect(read(path).split("\n").length, path).toBeLessThanOrEqual(300);
    }
  });

  it("keeps decomposed runtime value imports acyclic", () => {
    const modules = [
      ...walk("cloudflare/control-plane/src").filter((path) =>
        /(?:workspace-data|action-authority|session-agent|connection-broker).*\.ts$/.test(path),
      ),
      ...walk("lib/workbench/contracts").filter((path) => path.endsWith(".ts")),
      ...walk("lib/workbench/control-plane-client").filter((path) => path.endsWith(".ts")),
      ...walk("lib/workbench/agent-connection").filter((path) => /\.tsx?$/.test(path)),
    ].filter((path) => !path.endsWith(".test.ts"));
    const moduleSet = new Set(modules);
    const graph = new Map(
      modules.map((path) => {
        const dependencies = [
          ...read(path).matchAll(/import\s+(?!type\b)[\s\S]*?\sfrom\s+"(\.[^"]+)";/g),
        ]
          .map((match) => normalize(join(dirname(path), match[1] ?? "")))
          .flatMap((target) => [target, `${target}.ts`, `${target}.tsx`])
          .filter((target) => moduleSet.has(target));
        return [path, dependencies] as const;
      }),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (path: string) => {
      if (visiting.has(path)) throw new Error(`runtime import cycle includes ${path}`);
      if (visited.has(path)) return;
      visiting.add(path);
      for (const dependency of graph.get(path) ?? []) visit(dependency);
      visiting.delete(path);
      visited.add(path);
    };
    for (const path of modules) visit(path);
  });

  it("keeps credential values out of durable schemas and Fly envelopes", () => {
    for (const path of [
      "cloudflare/control-plane/schema.sql",
      ...walk("cloudflare/control-plane/migrations").filter((entry) => entry.endsWith(".sql")),
    ]) {
      expect(read(path), path).not.toMatch(
        /\b(access_token|refresh_token|client_secret|api_key_value|credential_value)\b/i,
      );
    }
    const runner = read("runner/server.ts");
    expect(runner).not.toMatch(/accessToken\??:|refreshToken\??:|apiKey\??:|credential\??:/);
    const runnerInvocation = read("cloudflare/control-plane/src/tool-runner.ts");
    expect(runnerInvocation).toContain("connectionCapability");
    expect(runnerInvocation).not.toMatch(
      /accessToken\??:|refreshToken\??:|apiKey\??:|clientSecret\??:/,
    );
    const capabilities = finalTableSql("control_connection_capabilities");
    expect(capabilities).toContain("token_sha256");
    expect(capabilities).not.toMatch(/credential|access_token|refresh_token/i);
  });

  it("keys Vault objects by tenant-scoped connection records", () => {
    const broker = readMatching("cloudflare/control-plane/src", /connection-broker.*\.ts$/);
    expect(broker).toContain("name: `connection:${recordId}`");
    expect(broker).toContain("name: `connection:${connection.id}`");
    expect(broker).not.toContain(
      "name: `connection:${identity.agentId}:${pack.id}:${connectionId}`",
    );
    expect(broker).toContain("await vault.delete(stored).catch(() => undefined)");
  });

  it("retains only a non-identifying receipt after final workspace purge", () => {
    const lifecycle = readMatching(
      "cloudflare/control-plane/src",
      /workspace-data-(?!lifecycle\.test).*\.ts$/,
    );
    const broker = readMatching("cloudflare/control-plane/src", /connection-broker.*\.ts$/);
    expect(lifecycle).toContain("INSERT INTO control_deletion_receipts");
    expect(lifecycle).toContain("DELETE FROM workspaces WHERE id = ? AND status = 'purging'");
    expect(lifecycle).toContain("DELETE FROM ${table} WHERE workspace_id = ?");
    expect(lifecycle).not.toContain("DELETE FROM ${table} WHERE user_id = ?");
    expect(broker).toContain(
      "FROM control_connections WHERE workspace_id = ? AND status <> 'revoked'",
    );
    expect(lifecycle).not.toContain("name = 'Deleted workspace'");
    expect(finalTableSql("control_deletion_receipts")).not.toMatch(
      /user_id|workspace_id|account_id|email|name/i,
    );
  });

  it("purges Durable Object chat storage without starting a model turn", () => {
    const threadAgent = read("cloudflare/control-plane/src/thread-chat-agent.ts");
    const lifecycleRoute = threadAgent.match(
      /if \(url\.pathname === "\/internal\/lifecycle-unfreeze"\)([\s\S]*?)if \(this\.lifecycleFence\(\)/,
    )?.[1];
    expect(lifecycleRoute).toBeDefined();
    expect(lifecycleRoute).toContain(
      "await this.persistMessages([], [], { _deleteStaleRows: true })",
    );
    expect(lifecycleRoute).toContain("this.turnReceipts().purge()");
    expect(lifecycleRoute).not.toContain("saveMessages");
  });

  it("enforces snapshot export fences at every exported durable table", () => {
    const lifecycle = readMatching(
      "cloudflare/control-plane/src",
      /workspace-data-(?!lifecycle\.test).*\.ts$/,
    );
    const schema = read("cloudflare/control-plane/schema.sql");
    const migrations = readMatching("cloudflare/control-plane/migrations", /\.sql$/);
    const exportedTables = [
      ...lifecycle.matchAll(/tenantCollection\(\s*"([^"]+)"/g),
      ...lifecycle.matchAll(/name:\s*"(users|workspaces|agents)"/g),
    ].map((match) => match[1]);
    expect(new Set(exportedTables).size).toBe(exportedTables.length);
    const omissionBlock = lifecycle.match(
      /workspaceExportOmittedTables\s*=\s*\[([\s\S]*?)\]\s*as const/,
    )?.[1];
    expect(omissionBlock).toBeDefined();
    const omittedTables = [...(omissionBlock ?? "").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    // Inspect the resulting schema, including forward table rebuilds and renamed tables.
    // Parsing CREATE statements alone incorrectly includes temporary migration tables.
    const database = new DatabaseSync(":memory:");
    let workspaceScopedTables: string[];
    let finalTriggers: Set<string>;
    try {
      database.exec(schema);
      workspaceScopedTables = database
        .prepare("SELECT name,sql FROM sqlite_master WHERE type='table'")
        .all()
        .filter((row) => /\bworkspace_id\s+TEXT\b/.test(String(row.sql)))
        .map((row) => String(row.name));
      finalTriggers = new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
          .all()
          .map((row) => String(row.name)),
      );
    } finally {
      database.close();
    }
    const coveredTables = new Set([...exportedTables, ...omittedTables]);
    expect(
      workspaceScopedTables.filter((table) => !coveredTables.has(table)),
      "new workspace-scoped tables require an export projection or explicit omission",
    ).toEqual([]);
    for (const table of exportedTables) {
      const actions =
        table === "users" || table === "workspaces"
          ? ["update", "delete"]
          : ["insert", "update", "delete"];
      for (const action of actions) {
        expect(migrations, `${table} ${action}`).toContain(
          `CREATE TRIGGER export_fence_${table}_${action}`,
        );
        expect(finalTriggers, `${table} ${action} must survive migrations`).toContain(
          `export_fence_${table}_${action}`,
        );
      }
    }
    expect(lifecycle).not.toMatch(/\bOFFSET\b/);
    expect(lifecycle).toContain("ORDER BY collection_name ASC, row_key ASC");
    for (const phase of [
      "awaiting_quiescence",
      "fenced",
      "do_frozen",
      "d1_materialized",
      "r2_pinned",
      "released",
      "assembling",
    ]) {
      expect(lifecycle).toContain(`"${phase}"`);
    }
    expect(lifecycle).toContain("workspace_export_fence_recovery_failed");
  });

  it("keeps hosted targets out of local configs and requires signed callback origins", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["db:cloudflare:migrate:remote"]).toBeUndefined();
    expect(packageJson.scripts?.["db:cloudflare:rebuild:remote"]).toBeUndefined();
    expect(read("cloudflare/control-plane/wrangler.jsonc")).not.toMatch(
      /acceptance|production|workers\.dev|fly\.dev|vercel\.app/,
    );
    expect(read("fly.runner.toml")).not.toMatch(/acceptance|production|workers\.dev|fly\.dev/);
    const runner = read("runner/server.ts");
    expect(runner).toContain("WORKBENCH_CALLBACK_ORIGIN");
    expect(runner).toContain("callbackUrl.origin !== allowedCallbackOrigin");
    const client = readMatching("lib/workbench/control-plane-client", /\.ts$/);
    expect(client).toContain("baseUrl && (token || signingSecret)");
    const webhook = read("app/api/external-signals/[publicId]/route.ts");
    expect(webhook).toContain("!baseUrl || !signingSecret");
  });
});
