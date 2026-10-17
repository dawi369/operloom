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

/** Unauthenticated probes of the new public surfaces: they must refuse, never leak, never 500. */
const readPublicSurface = async (origin: string) => {
  const probe = async (path: string, init: RequestInit, expectedStatuses: number[]) => {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
    if (!expectedStatuses.includes(response.status))
      throw new Error(
        `${path} answered HTTP ${response.status}, expected ${expectedStatuses.join("/")}`,
      );
    return { path, status: response.status };
  };
  const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await metadata.json().catch(() => null)) as Record<string, unknown> | null;
  if (!metadata.ok || body?.resource !== `${origin}/v1/me/mcp`)
    throw new Error("MCP protected-resource metadata is missing or points elsewhere");
  const challenge = await fetch(`${origin}/v1/me/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (
    challenge.status !== 401 ||
    !challenge.headers.get("www-authenticate")?.includes("resource_metadata")
  )
    throw new Error(`MCP without a bearer answered HTTP ${challenge.status} without a challenge`);
  return [
    { path: "/.well-known/oauth-protected-resource", status: metadata.status },
    { path: "/v1/me/mcp", status: challenge.status },
    await probe("/v1/me/workbench/billing", {}, [401]),
    // Unsigned billing webhooks are refused; a manual provider has no ingress at all.
    await probe("/billing-ingress/stripe", { method: "POST", body: "{}" }, [401, 404]),
    await probe("/v1/openapi.json", {}, [200]),
  ];
};

const main = async () => {
  const web = requiredOrigin("HOSTED_WEB_ORIGIN");
  const cloudflare = requiredOrigin("HOSTED_CLOUDFLARE_ORIGIN");
  const fly = requiredOrigin("HOSTED_FLY_ORIGIN");
  const checks = [
    await readHealth(web, "/api/health", "operloom"),
    await readHealth(web, "/api/health/facade", "operloom-facade"),
    await readHealth(cloudflare, "/health/live", "operloom-control-plane"),
    await readHealth(cloudflare, "/health", "operloom-control-plane"),
    await readHealth(fly, "/health/live", "operloom-runner"),
    await readHealth(fly, "/health", "operloom-runner"),
  ];
  const surfaces = await readPublicSurface(cloudflare);
  const commit = process.env.GITHUB_SHA?.trim() ?? "";
  const report = {
    schemaVersion: 1,
    target: process.env.OPERLOOM_ENVIRONMENT?.trim() ?? "unknown",
    commit,
    generatedAt: new Date().toISOString(),
    ok: true,
    checks,
    surfaces,
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
