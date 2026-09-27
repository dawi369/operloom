import { defineAgentPack } from "@operloom/agent-sdk/manifest";

export const manifest = defineAgentPack({
  id: "provider-operation-fixture",
  name: "Provider Operation Fixture",
  description: "Non-financial capacity service acceptance.",
  profile: "operator",
  version: "1.0.0",
  capabilityLevel: "single_agent_app",
  format: "xml",
  folderPath: "external",
  codePath: "external",
  promptPath: "prompt.xml",
  tools: ["capacity.allocate", "capacity.allocate-signed"].map((id) => ({
    id,
    invocation: "workflow" as const,
    required: true,
    executionModes: ["dry_run", "execute"] as const,
    modelVisibleDefault: false,
    purpose: "Request an approved capacity allocation.",
  })),
  workflows: [
    ...["capacity.seed", "capacity.project"].map((type) => ({
      type,
      status: "declared" as const,
      userInvocable: true,
      description: "Manage canonical capacity state.",
    })),
    {
      type: "capacity.request",
      status: "declared",
      userInvocable: true,
      description: "Propose a capacity allocation for operator review.",
    },
  ],
  ui: {
    primarySurface: "workbench",
    inspectorSections: ["tools", "history"],
    configurationMode: "code",
    welcome: {
      title: "Capacity service",
      description: "Provider operation conformance.",
      starters: [],
    },
  },
  risk: {
    financialData: false,
    externalMutation: true,
    requiresSecrets: true,
    productionGate: "mutation_gate",
  },
  connections: [
    { id: "capacity.service", provider: "capacity-service", toolIds: ["capacity.allocate"] },
    {
      id: "capacity.signed-service",
      provider: "signed-capacity-service",
      toolIds: ["capacity.allocate-signed"],
    },
  ].map((item) => ({
    ...item,
    principal: "user" as const,
    credentialClass: "api_key" as const,
    custody: "external_broker" as const,
    required: false,
    scopes: ["allocate"],
  })),
  context: [],
  managedState: [],
  triggers: [],
  artifactRenderers: [],
  healthChecks: [],
  evals: [],
  compatibility: { packApi: 2, minimumWorkbenchVersion: "2.0.0" },
  resourceLimits: {
    maxRunSeconds: 10,
    maxToolCallsPerRun: 2,
    maxConcurrentRuns: 2,
    maxArtifactBytes: 1024,
  },
  smokeScenarios: [],
  prompt:
    "<system>Propose capacity allocations. External effects require operator approval.</system>",
});
