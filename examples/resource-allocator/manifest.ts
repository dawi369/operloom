import { defineAgentPack } from "@operloom/agent-sdk/manifest";
export const manifest = defineAgentPack({
  id: "resource-allocator",
  name: "Resource Allocator",
  description:
    "Reference operator loop: monitor a capacity feed, escalate unmet demand to a structured decision, propose a reviewed allocation and project it into a ledger.",
  profile: "operator",
  version: "1.0.0",
  capabilityLevel: "single_agent_app",
  format: "xml",
  folderPath: "examples/resource-allocator",
  codePath: "examples/resource-allocator/control-plane.ts",
  promptPath: "examples/resource-allocator/prompt.xml",
  tools: [
    {
      id: "resource-allocator.allocate",
      invocation: "workflow",
      required: true,
      executionModes: ["dry_run", "execute"],
      modelVisibleDefault: false,
      purpose: "Allocate reviewed capacity through the capacity provider operation.",
    },
  ],
  workflows: [
    {
      type: "resource-allocator.cycle",
      status: "declared",
      userInvocable: true,
      description: "Settle, observe and escalate one allocation cycle.",
    },
  ],
  ui: {
    primarySurface: "workbench",
    inspectorSections: ["tools", "history"],
    configurationMode: "code",
    welcome: {
      title: "Resource Allocator",
      description:
        "A monitor observes capacity each minute. Escalations become allocation proposals that an operator approves.",
      starters: [],
    },
  },
  risk: {
    financialData: false,
    externalMutation: true,
    requiresSecrets: false,
    productionGate: "mutation_gate",
  },
  connections: [
    {
      id: "capacity.service",
      provider: "capacity-service",
      toolIds: ["resource-allocator.allocate"],
      principal: "user",
      credentialClass: "api_key",
      custody: "external_broker",
      required: false,
      scopes: ["allocate"],
    },
  ],
  context: [
    {
      id: "feed",
      trust: "untrusted",
      description: "Mock capacity feed for the observed pool.",
      required: true,
      runtimeBinding: "capacity.feed",
    },
  ],
  managedState: [
    {
      namespace: "capacity",
      schemaVersion: 1,
      description: "Pools, allocation requests and the monitor cursor.",
      recordKinds: ["pool", "request", "monitor.cursor"],
      views: [],
    },
  ],
  triggers: [
    {
      id: "capacity-monitor",
      kind: "monitor",
      description: "Run an allocation cycle once a minute.",
      workflowType: "resource-allocator.cycle",
      enabledByDefault: false,
      intervalSeconds: 60,
    },
  ],
  artifactRenderers: [],
  healthChecks: [],
  evals: [],
  compatibility: { packApi: 2, minimumWorkbenchVersion: "2.0.0" },
  resourceLimits: {
    maxRunSeconds: 20,
    maxToolCallsPerRun: 1,
    maxConcurrentRuns: 1,
    maxArtifactBytes: 1024,
  },
  smokeScenarios: [],
  prompt:
    "<identity>You operate a capacity pool. Explain allocation decisions from recorded evidence. Allocations take effect only after operator approval.</identity>",
});
