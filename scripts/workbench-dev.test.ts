import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalWorkbenchConfiguration } from "./workbench-dev";
import { initializeWorkbench } from "./workbench-init";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local workbench supervisor", () => {
  it("builds one matched frontend, Worker, LangGraph, and signed-runner process set", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "operloom-dev-"));
    roots.push(root);
    mkdirSync(resolve(root, "cloudflare/control-plane"), { recursive: true });
    copyFileSync(resolve(process.cwd(), ".env.example"), resolve(root, ".env.example"));
    for (const file of [".dev.vars.example", "schema.sql", "wrangler.jsonc"]) {
      copyFileSync(
        resolve(process.cwd(), "cloudflare/control-plane", file),
        resolve(root, "cloudflare/control-plane", file),
      );
    }
    await initializeWorkbench({ root, runMigration: false });

    const configuration = createLocalWorkbenchConfiguration(root, {});
    expect(configuration.services.map((service) => service.name)).toEqual([
      "frontend",
      "langgraph",
      "worker",
      "runner",
    ]);
    expect(configuration.services.find((service) => service.name === "frontend")?.args).toEqual([
      "exec",
      "next",
      "dev",
      "--webpack",
      "--disable-source-maps",
      "--hostname",
      "127.0.0.1",
    ]);
    const runner = configuration.services.find((service) => service.name === "runner")!;
    const worker = readFileSync(resolve(root, "cloudflare/control-plane/.dev.vars"), "utf8");
    expect(runner.env.WORKBENCH_RUNNER_SIGNING_SECRET).toBeTruthy();
    expect(worker).toContain(
      `WORKBENCH_RUNNER_SIGNING_SECRET=${runner.env.WORKBENCH_RUNNER_SIGNING_SECRET}`,
    );
    expect(runner.env.WORKBENCH_CALLBACK_ORIGIN).toBe("http://127.0.0.1:8787");
    expect(runner.healthUrl).toBe("http://127.0.0.1:3101/health");
  });
});
