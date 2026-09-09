import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const localPatchPath = resolve(process.cwd(), "patches/extract-zip@2.0.1.patch");
const localPatchSha256 = createHash("sha256").update(readFileSync(localPatchPath)).digest("hex");
const expectedLocalPatchSha256 = "eaa4a82363cf0ed0cb1f097123ff4f378c93c47032560ae80168ef12d8145759";
const locallyRemediatedAdvisories = new Set<string>();
if (localPatchSha256 === expectedLocalPatchSha256) {
  locallyRemediatedAdvisories.add("GHSA-jmr9-qjv8-65gv");
  locallyRemediatedAdvisories.add("GHSA-7pqw-9j4j-h8q3");
}
const decision = evaluateSecurityAudit(report as { advisories?: unknown }, {
  locallyRemediatedAdvisories,
});

for (const advisory of decision.allowed) {
  console.warn(`${advisory.githubAdvisoryId} is constrained or locally remediated.`);
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
