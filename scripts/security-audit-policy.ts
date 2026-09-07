type AuditFinding = {
  paths?: unknown;
};

type AuditAdvisory = {
  severity?: unknown;
  module_name?: unknown;
  github_advisory_id?: unknown;
  patched_versions?: unknown;
  findings?: unknown;
};

type AuditReport = {
  advisories?: unknown;
};

export type BlockedAuditAdvisory = {
  id: string;
  moduleName: string;
  severity: string;
  githubAdvisoryId: string;
  paths: string[];
};

export type SecurityAuditDecision = {
  blocked: BlockedAuditAdvisory[];
  allowed: BlockedAuditAdvisory[];
};

export type SecurityAuditPolicyOptions = {
  locallyRemediatedAdvisories?: ReadonlySet<string>;
};

function normalizeAdvisory(id: string, advisory: AuditAdvisory): BlockedAuditAdvisory {
  const findings = Array.isArray(advisory.findings) ? (advisory.findings as AuditFinding[]) : [];
  const paths = findings.flatMap((finding) =>
    Array.isArray(finding.paths)
      ? finding.paths.filter((path): path is string => typeof path === "string")
      : [],
  );

  return {
    id,
    moduleName: typeof advisory.module_name === "string" ? advisory.module_name : "unknown",
    severity: typeof advisory.severity === "string" ? advisory.severity : "unknown",
    githubAdvisoryId:
      typeof advisory.github_advisory_id === "string" ? advisory.github_advisory_id : "unknown",
    paths,
  };
}

export function evaluateSecurityAudit(
  report: AuditReport,
  options: SecurityAuditPolicyOptions = {},
): SecurityAuditDecision {
  const advisories =
    report.advisories && typeof report.advisories === "object"
      ? (report.advisories as Record<string, AuditAdvisory>)
      : {};
  const decision: SecurityAuditDecision = { blocked: [], allowed: [] };

  for (const [id, advisory] of Object.entries(advisories)) {
    if (advisory.severity !== "high" && advisory.severity !== "critical") continue;
    const normalized = normalizeAdvisory(id, advisory);
    if (options.locallyRemediatedAdvisories?.has(normalized.githubAdvisoryId)) {
      decision.allowed.push(normalized);
    } else {
      decision.blocked.push(normalized);
    }
  }

  return decision;
}
