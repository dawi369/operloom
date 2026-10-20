import { spawnSync } from "node:child_process";

import { evaluateSecurityAudit } from "./security-audit-policy";

const result = spawnSync("pnpm", ["audit", "--audit-level", "high", "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

if (result.error) throw result.error;
if (result.signal || result.status === null) {
  process.stderr.write(
    `pnpm audit did not complete${result.signal ? ` (signal: ${result.signal})` : ""}\n`,
  );
  process.exit(1);
}
if (!result.stdout.trim()) {
  process.stderr.write(result.stderr || "pnpm audit returned no JSON output\n");
  process.exit(1);
}

let report: unknown;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write("pnpm audit returned invalid JSON\n");
  process.stderr.write(result.stderr);
  process.exit(1);
}

/**
 * Advisories accepted for now. Each needs a path that never reaches a shipped
 * artifact, a reason, and an expiry; the gate fails again the day after.
 */
const acceptedAdvisories: Array<{ id: string; pathPrefix: string; reason: string; until: string }> =
  [
    {
      id: "GHSA-86w9-cpqp-85rv",
      pathPrefix: "apps__mobile>expo>@expo/cli>",
      reason: "node-forge is used by the Expo CLI at build time only; no patched release exists.",
      until: "2026-12-31",
    },
    {
      id: "GHSA-vfj7-8cjw-p6xm",
      pathPrefix: "apps__mobile>expo>@expo/metro>",
      reason:
        "braces is used by Metro's file watcher at build time only; no patched release exists.",
      until: "2026-12-31",
    },
  ];
const today = new Date().toISOString().slice(0, 10);
const accepted = new Set(
  acceptedAdvisories.filter((entry) => entry.until >= today).map((entry) => entry.id),
);

const decision = evaluateSecurityAudit(report as { advisories?: unknown }, {
  locallyRemediatedAdvisories: accepted,
});
for (const advisory of decision.allowed) {
  const entry = acceptedAdvisories.find((candidate) => candidate.id === advisory.githubAdvisoryId)!;
  const stray = advisory.paths.filter(
    (path) => !(path === entry.pathPrefix || path.startsWith(entry.pathPrefix.replace(/>?$/, ">"))),
  );
  if (stray.length) {
    console.error(
      `${advisory.githubAdvisoryId} is accepted only under ${entry.pathPrefix}; also reached via ${stray.join(", ")}`,
    );
    process.exit(1);
  }
}

for (const advisory of decision.allowed) {
  const entry = acceptedAdvisories.find((candidate) => candidate.id === advisory.githubAdvisoryId)!;
  console.warn(`${advisory.githubAdvisoryId} accepted until ${entry.until}: ${entry.reason}`);
}

if (decision.blocked.length > 0) {
  console.error("High or critical dependency advisories block this release:");
  for (const advisory of decision.blocked) {
    console.error(
      `- ${advisory.githubAdvisoryId} ${advisory.moduleName} (${advisory.severity}) via ${advisory.paths.join(", ") || "unknown path"}`,
    );
  }
  process.exit(1);
}

if (result.status !== 0 && decision.allowed.length === 0) {
  process.stderr.write(result.stderr || `pnpm audit exited with status ${result.status}\n`);
  process.exit(1);
}

console.log("Security audit passed: no unapproved high or critical advisories.");
