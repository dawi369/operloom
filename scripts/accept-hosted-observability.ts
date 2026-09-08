import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const token = process.env.SENTRY_AUTH_TOKEN?.trim();
if (!token) throw new Error("SENTRY_AUTH_TOKEN is required");
const organization = process.env.SENTRY_ORG?.trim() || "t23";
const project = process.env.SENTRY_PROJECT?.trim() || "operloom";
const commit = process.env.GITHUB_SHA?.trim() || "";
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("GITHUB_SHA must be a full commit");
const target = process.env.WORKBENCH_ENVIRONMENT?.trim() || "unknown";
const main = async () => {
  const response = await fetch(
    `https://sentry.io/api/0/projects/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/rules/`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok)
    throw new Error(`Sentry alert rule inventory failed with HTTP ${response.status}`);
  const rules = (await response.json()) as { id?: unknown; name?: unknown; status?: unknown }[];
  const requiredNames = [
    "Production new errors",
    "Production error burst",
    "Critical operator alerts",
    "Production regressions",
  ];
  const active = rules.filter(
    (rule) =>
      rule.status === "active" && typeof rule.name === "string" && typeof rule.id === "string",
  );
  const missing = requiredNames.filter((name) => !active.some((rule) => rule.name === name));
  const report = {
    schemaVersion: 1,
    target,
    commit,
    generatedAt: new Date().toISOString(),
    ok: missing.length === 0,
    project: `${organization}/${project}`,
    ruleIds: Object.fromEntries(
      active
        .filter((rule) => requiredNames.includes(rule.name as string))
        .map((rule) => [rule.name as string, rule.id as string]),
    ),
    missing,
  };
  const directory = resolve(process.cwd(), "output/release", commit);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, `hosted-observability-${target}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
  if (missing.length) process.exitCode = 1;
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
