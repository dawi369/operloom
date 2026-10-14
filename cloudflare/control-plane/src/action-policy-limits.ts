import type {
  ActionApprovalDecision,
  ActionProposal,
  ApprovalLimit,
  RuntimeSettings,
  RuntimeToolBinding,
} from "@operloom/agent-sdk/control-plane";
import type { AgentIdentity, Env } from "./types";

export type ApprovalLimitEvidence = ApprovalLimit & {
  observed: number | string | null;
  allowed: boolean;
};

export type ApprovalEvidence = {
  decision: ActionApprovalDecision;
  limits: ApprovalLimitEvidence[];
  settingsVersion: number;
  evaluatedAt: string;
  /** Set when a dispatch-time recheck changed an `auto` decision. */
  downgradedBy?: string;
};

const periodStart = (per: "hour" | "day", now: Date) =>
  new Date(now.getTime() - (per === "hour" ? 3_600_000 : 86_400_000)).toISOString();

// Proposals the policy already let through; the current proposal is still `proposed`.
const admittedAutoProposals = `FROM control_action_proposals
  WHERE user_id = ? AND workspace_id = ? AND agent_id = ? AND tool_id = ?
    AND approval_decision = 'auto' AND created_at >= ?
    AND status IN ('approved', 'executing', 'executed', 'outcome_unknown', 'reconciled')`;

const numberField = (preview: Record<string, unknown>, field: string) => {
  const value = preview[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/**
 * Evaluates every declared limit for one proposal. Any limit that cannot be
 * measured counts as breached, so a malformed preview or setting falls back to
 * human review.
 */
export const evaluateApprovalLimits = async (
  env: Env,
  identity: AgentIdentity,
  binding: RuntimeToolBinding,
  proposal: ActionProposal,
  settings: RuntimeSettings,
  now = new Date(),
): Promise<ApprovalEvidence> => {
  const limits = binding.action?.policy?.limits ?? [];
  const evidence: ApprovalLimitEvidence[] = [];
  for (const limit of limits) {
    if (limit.kind === "count") {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n ${admittedAutoProposals}`)
        .bind(
          identity.scope.userId,
          identity.scope.workspaceId,
          identity.agentId,
          proposal.toolId,
          periodStart(limit.per, now),
        )
        .first<{ n: number }>();
      const observed = Number(row?.n ?? 0) + 1;
      evidence.push({ ...limit, observed, allowed: observed <= limit.max });
    } else if (limit.kind === "amount") {
      const current = numberField(proposal.preview, limit.field);
      const row = await env.DB.prepare(
        `SELECT COALESCE(SUM(json_extract(proposal_json, ?)), 0) AS total ${admittedAutoProposals}`,
      )
        .bind(
          `$.preview.${limit.field}`,
          identity.scope.userId,
          identity.scope.workspaceId,
          identity.agentId,
          proposal.toolId,
          periodStart(limit.per ?? "day", now),
        )
        .first<{ total: number }>();
      const observed = current === null ? null : Number(row?.total ?? 0) + current;
      evidence.push({ ...limit, observed, allowed: observed !== null && observed <= limit.max });
    } else {
      const value = proposal.preview[limit.field];
      const allowed = settings.values[limit.settingsKey];
      const observed = typeof value === "string" || typeof value === "number" ? value : null;
      evidence.push({
        ...limit,
        observed,
        allowed:
          observed !== null && Array.isArray(allowed) && allowed.some((item) => item === observed),
      });
    }
  }
  return {
    decision: limits.length > 0 && evidence.every((item) => item.allowed) ? "auto" : "review",
    limits: evidence,
    settingsVersion: settings.version,
    evaluatedAt: now.toISOString(),
  };
};
