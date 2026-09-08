import type { RuntimeToolBinding } from "@operloom/agent-sdk/runner";

import {
  runnerEchoAdapterVersion,
  runnerEchoPolicy,
  runnerEchoToolName,
  runRunnerEcho,
} from "../workbench/admin-test-tools";

export const platformRunnerTools = [
  {
    id: runnerEchoToolName,
    description: "Echo bounded text through the signed runner boundary.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: { type: "string", maxLength: 160 },
        uppercase: { type: "boolean" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status", "summary", "message", "echoed", "uppercase", "length", "timingMs"],
      properties: {
        status: { type: "string", enum: ["ok"] },
        summary: { type: "string" },
        message: { type: "string" },
        echoed: { type: "string" },
        uppercase: { type: "boolean" },
        length: { type: "integer", minimum: 0 },
        timingMs: { type: "integer", minimum: 0 },
      },
    },
    executionModes: ["dry_run"],
    transport: "fly",
    adapterVersion: runnerEchoAdapterVersion,
    timeoutMs: 5_000,
    maxArtifactBytes: 0,
    sandbox: {
      template: "runner-echo-no-egress-v1",
      maxRuntimeMs: 5_000,
      maxArtifactBytes: 0,
      network: { egress: "none", privateNetwork: "deny", dnsPinning: "required" },
    },
    policy: {
      reference: runnerEchoPolicy,
      adminVisible: true,
      modelVisible: false,
      requiresApproval: false,
      policyEditable: false,
      mutationRisk: "read_only",
    },
    execute(input) {
      const result = runRunnerEcho(input);
      return result.ok
        ? { ok: true, output: result.output, summary: result.output.summary }
        : { ok: false, error: result.error, summary: result.error.message };
    },
  },
] as const satisfies readonly RuntimeToolBinding[];

export const resolvePlatformRunnerTool = (toolId: string) =>
  platformRunnerTools.find((tool) => tool.id === toolId);
