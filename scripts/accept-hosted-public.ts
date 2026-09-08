import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { compiledWorkbenchVersion } from "../generated/agent-runtime/platform";

const requiredOrigin = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use https`);
  return url.origin;
};

const forbiddenKeys = /user|workspace|tenant|token|secret|password|apiKey|credential/i;

const readHealth = async (origin: string, path: string, expectedService: string) => {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(10_000) });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || body?.ok !== true || body.service !== expectedService) {
    throw new Error(`${expectedService} ${path} failed with HTTP ${response.status}`);
  }
  if (body.version !== compiledWorkbenchVersion) {
    throw new Error(`${expectedService} ${path} reports a different application version`);
  }
  const leakedKey = Object.keys(body).find((key) => forbiddenKeys.test(key));
  if (leakedKey) throw new Error(`${expectedService} ${path} exposed forbidden key ${leakedKey}`);
  const expectedCommit = process.env.GITHUB_SHA?.trim();
  if (expectedCommit && body.release !== expectedCommit) {
    throw new Error(`${expectedService} ${path} reports a different release`);
  }
  return {
    path,
    status: response.status,
    service: body.service,
    version: body.version,
    release: body.release,
  };
};

const main = async () => {
  const vercel = requiredOrigin("HOSTED_VERCEL_ORIGIN");
  const cloudflare = requiredOrigin("HOSTED_CLOUDFLARE_ORIGIN");
  const fly = requiredOrigin("HOSTED_FLY_ORIGIN");
  const checks = [
    await readHealth(vercel, "/api/health", "operloom"),
    await readHealth(vercel, "/api/health/facade", "operloom-facade"),
    await readHealth(cloudflare, "/health/live", "operloom-control-plane"),
    await readHealth(cloudflare, "/health", "operloom-control-plane"),
    await readHealth(fly, "/health/live", "operloom-langgraph-runtime"),
    await readHealth(fly, "/health", "operloom-langgraph-runtime"),
  ];
  const commit = process.env.GITHUB_SHA?.trim() ?? "";
  const report = {
    schemaVersion: 1,
    target: process.env.WORKBENCH_ENVIRONMENT?.trim() ?? "unknown",
    commit,
    generatedAt: new Date().toISOString(),
    ok: true,
    checks,
    serviceVersions: Object.fromEntries(
      checks.map((check) => [String(check.service), String(check.release)]),
    ),
    applicationVersions: Object.fromEntries(
      checks.map((check) => [String(check.service), String(check.version)]),
    ),
  };
  if (/^[a-f0-9]{40}$/.test(commit)) {
    const directory = resolve(process.cwd(), "output/release", commit);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(directory, "hosted-public-health.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  console.log(JSON.stringify(report, null, 2));
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
