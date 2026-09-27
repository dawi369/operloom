import { describe, expect, it } from "vitest";

import { executeRuntimeToolBinding } from "./runtime-tool-execution";
import type { AgentIdentity, Env } from "./types";

const identity = {
  scope: { userId: "user-1", workspaceId: "workspace-1" },
  agentId: "agent-1",
} as AgentIdentity;

describe("runtime tool execution", () => {
  it("normalizes runner failures into a persistable summary", async () => {
    const result = await executeRuntimeToolBinding({
      env: {} as Env,
      identity,
      binding: {
        id: "fixture.fly",
        description: "Fixture Fly tool",
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: { type: "object" },
        executionModes: ["dry_run"],
        transport: "fly",
        adapterVersion: "fixture-v1",
        timeoutMs: 1_000,
        maxArtifactBytes: 1_024,
        policy: {
          reference: "fixture.fly.v1",
          adminVisible: true,
          modelVisible: false,
          requiresApproval: false,
          policyEditable: false,
          mutationRisk: "read_only",
        },
      },
      toolInput: {},
      context: { pack: { id: "fixture", version: "1.0.0" } } as never,
      execution: {
        runId: "run-1",
        workflowIntentId: "intent-1",
        toolCallId: "tool-call-1",
        packVersion: "1.0.0",
        runtimeVersion: "1.0.0",
        bindingVersion: 1,
        source: "agent-pack",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      summary: "Fly runner transport is not configured.",
      error: { code: "runner_not_configured" },
    });
  });
});
