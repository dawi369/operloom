import { describe, expect, it } from "vitest";

import { toHumanInterventionEventData, toHumanInterventionSummary } from "./human-interventions";
import type { ControlApprovalRequestRow } from "./types";

const approval: ControlApprovalRequestRow = {
  id: "approval-a",
  user_id: "user-a",
  workspace_id: "workspace-a",
  agent_id: "agent-a",
  workflow_intent_id: "intent-a",
  run_id: "run-a",
  tool_id: "url.inspect",
  status: "requested",
  reason: "Approval required.",
  data_json: "{}",
  created_at: "2026-06-17T10:00:00.000Z",
  updated_at: "2026-06-17T10:00:00.000Z",
};

describe("human intervention summaries", () => {
  it("exposes only bound workflow review content through the portable descriptor", () => {
    const data = {
      kind: "durable_workflow",
      payload: { document: "Review this text" },
      requestHash: "a".repeat(64),
      expiresAt: "2026-10-01T00:00:00.000Z",
      internal: "not presentation content",
    };
    const summary = toHumanInterventionSummary({ ...approval, data_json: JSON.stringify(data) });
    expect(summary.title).toBe("Workflow review");
    expect(summary.review).toEqual({
      payload: data.payload,
      requestHash: data.requestHash,
      expiresAt: data.expiresAt,
    });
    for (const invalid of [
      { ...data, requestHash: "invalid" },
      { ...data, expiresAt: "invalid" },
      { ...data, kind: "tool" },
      { ...data, payload: [] },
    ]) {
      expect(
        toHumanInterventionSummary({ ...approval, data_json: JSON.stringify(invalid) }).review,
      ).toBeUndefined();
    }
  });

  it("maps requested approvals to parked work with approve and deny paths", () => {
    const summary = toHumanInterventionSummary(approval);

    expect(summary).toMatchObject({
      id: "approval-a",
      kind: "approval",
      status: "requested",
      state: "parked",
      requiredAction: "approve_or_deny",
      resumeSurface: "admin_resume",
      runId: "run-a",
      workflowIntentId: "intent-a",
      toolId: "url.inspect",
    });
    expect(summary.approvePath).toContain("/tools/approvals/approval-a/approve");
    expect(summary.denyPath).toContain("/tools/approvals/approval-a/deny");
    expect(JSON.stringify(summary)).not.toMatch(/token|secret|prompt|message/i);
  });

  it("maps live approval events to the same compact intervention shape", () => {
    const event = toHumanInterventionEventData({
      approvalRequestId: "approval-a",
      status: "denied",
      runId: "run-a",
      workflowIntentId: "intent-a",
      toolName: "url.inspect",
      reason: "Denied by user.",
    });

    expect(event).toEqual({
      id: "approval-a",
      kind: "approval",
      status: "denied",
      state: "decided",
      requiredAction: "none",
      resumeSurface: "admin_resume",
      approvalRequestId: "approval-a",
      runId: "run-a",
      workflowIntentId: "intent-a",
      toolId: "url.inspect",
      reason: "Denied by user.",
    });
  });
});
