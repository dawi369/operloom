import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeWorkbench } from "./workbench-init";

const roots: string[] = [];
const fixtureRoot = () => {
  const root = mkdtempSync(resolve(tmpdir(), "operloom-init-"));
  roots.push(root);
  mkdirSync(resolve(root, "cloudflare/control-plane"), { recursive: true });
  copyFileSync(resolve(process.cwd(), ".env.example"), resolve(root, ".env.example"));
  for (const file of [".dev.vars.example", "schema.sql", "wrangler.jsonc"]) {
    copyFileSync(
      resolve(process.cwd(), "cloudflare/control-plane", file),
      resolve(root, "cloudflare/control-plane", file),
    );
  }
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const value = (source: string, key: string) =>
  source
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1);

describe("workbench initializer", () => {
  it("creates safe local files with matching generated transport secrets", async () => {
    const root = fixtureRoot();
    const result = await initializeWorkbench({ root, runMigration: false });
    const frontend = readFileSync(resolve(root, ".env.local"), "utf8");
    const worker = readFileSync(resolve(root, "cloudflare/control-plane/.dev.vars"), "utf8");

    expect(result.created).toEqual([".env.local", "cloudflare/control-plane/.dev.vars"]);
    expect(value(frontend, "CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN")).toBe(
      value(worker, "CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN"),
    );
    expect(value(frontend, "WORKBENCH_CALLBACK_SIGNING_SECRET")).toBe(
      value(worker, "WORKBENCH_CALLBACK_SIGNING_SECRET"),
    );
    expect(value(worker, "WORKBENCH_AGENT_CONNECTION_SECRET")?.length).toBeGreaterThan(32);
    expect(value(frontend, "WORKBENCH_RUNNER_SIGNING_SECRET")).toBe(
      value(worker, "WORKBENCH_RUNNER_SIGNING_SECRET"),
    );
    expect(value(worker, "WORKBENCH_RUNNER_TRANSPORT")).toBe("fly");
    expect(value(worker, "WORKBENCH_CALLBACK_URL")).toBe(
      "http://127.0.0.1:8787/workbench/run-callbacks",
    );
    expect(value(frontend, "WORKBENCH_ADMIN_USER_IDS")).toBe("dev-user");
    expect(result.needsProviderKey).toBe(true);
  });

  it("never overwrites configured local values", async () => {
    const root = fixtureRoot();
    writeFileSync(
      resolve(root, ".env.local"),
      readFileSync(resolve(root, ".env.example"), "utf8")
        .replace(
          "CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN=",
          "CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN=existing-token",
        )
        .replace("WORKBENCH_ADMIN_USER_IDS=", "WORKBENCH_ADMIN_USER_IDS=existing-admin"),
    );
    writeFileSync(
      resolve(root, "cloudflare/control-plane/.dev.vars"),
      readFileSync(resolve(root, "cloudflare/control-plane/.dev.vars.example"), "utf8").replace(
        "CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN=replace-with-a-local-token",
        "CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN=existing-token",
      ),
    );

    await initializeWorkbench({ root, runMigration: false });
    const frontend = readFileSync(resolve(root, ".env.local"), "utf8");
    expect(value(frontend, "CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN")).toBe("existing-token");
    expect(value(frontend, "WORKBENCH_ADMIN_USER_IDS")).toBe("existing-admin");
  });

  it("upgrades only the retired inline local transport default", async () => {
    const root = fixtureRoot();
    writeFileSync(
      resolve(root, "cloudflare/control-plane/.dev.vars"),
      readFileSync(resolve(root, "cloudflare/control-plane/.dev.vars.example"), "utf8")
        .replace("WORKBENCH_RUNNER_TRANSPORT=fly", "WORKBENCH_RUNNER_TRANSPORT=inline")
        .replace(
          "WORKBENCH_RUNNER_URL=http://127.0.0.1:3101/workbench/tool-runners/invocations",
          "WORKBENCH_RUNNER_URL=",
        )
        .replace(
          "WORKBENCH_CALLBACK_URL=http://127.0.0.1:8787/workbench/run-callbacks",
          "WORKBENCH_CALLBACK_URL=",
        ),
    );

    await initializeWorkbench({ root, runMigration: false });
    const worker = readFileSync(resolve(root, "cloudflare/control-plane/.dev.vars"), "utf8");
    expect(value(worker, "WORKBENCH_RUNNER_TRANSPORT")).toBe("fly");
    expect(value(worker, "WORKBENCH_RUNNER_URL")).toBe(
      "http://127.0.0.1:3101/workbench/tool-runners/invocations",
    );
    expect(value(worker, "WORKBENCH_CALLBACK_URL")).toBe(
      "http://127.0.0.1:8787/workbench/run-callbacks",
    );
  });
});
