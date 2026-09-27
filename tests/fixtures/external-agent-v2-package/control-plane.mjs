import { defineControlPlaneModuleV2 } from "@operloom/agent-sdk/control-plane";

export const controlPlane = defineControlPlaneModuleV2({
  requirements: {
    minimumBackendVersion: "1.0.0",
    capabilities: [
      "runtime.module.v2",
      "state.atomic.v2",
      "state.migrations.v2",
      "context.snapshots.v2",
    ],
  },
  packId: "external-agent-v2-fixture",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  context: [
    {
      id: "document.input",
      version: "1",
      schema: { type: "object" },
      maxAgeMs: 1000,
      timeoutMs: 100,
      resolve: () => ({ status: "missing" }),
    },
  ],
  tools: [
    {
      id: "capacity.allocate",
      description: "Propose non-financial capacity allocation.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      executionModes: ["dry_run", "execute"],
      transport: "cloudflare_inline",
      adapterVersion: "capacity-v1",
      timeoutMs: 5000,
      maxArtifactBytes: 1024,
      policy: {
        reference: "capacity-allocation",
        adminVisible: true,
        modelVisible: false,
        requiresApproval: true,
        policyEditable: true,
        mutationRisk: "mutation_capable",
      },
      action: {
        target: "external",
        connectionId: "capacity.service",
        proposalSchema: {
          type: "object",
          additionalProperties: false,
          required: ["resource", "units"],
          properties: { resource: { type: "string" }, units: { type: "integer", minimum: 1 } },
        },
        resultSchema: { type: "object", required: ["requestId", "resourceId", "lifecycle"] },
        idempotency: "required",
        approval: "required",
        timeoutMs: 4000,
        providerOperation: { id: "capacity.allocate", version: "1" },
      },
    },
  ],
  workflows: [],
  health: [],
  evals: [],
  state: [1, 2].map((schemaVersion) => ({
    namespace: "documents",
    kind: "review",
    schemaVersion,
    schema: {
      type: "object",
      properties: { title: { type: "string" }, status: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
  })),
  stateMigrations: [
    {
      id: "review-v2",
      namespace: "documents",
      kind: "review",
      fromVersion: 1,
      toVersion: 2,
      operations: [{ op: "default", field: "status", value: "pending" }],
    },
  ],
});
