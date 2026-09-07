import { defineAgentPack, type LocalAgentPackManifest } from "@operloom/agent-sdk/manifest";

export const manifest: LocalAgentPackManifest = defineAgentPack({
  id: "complex-operator",
  name: "Complex Operator",
  description: "Deterministic external-style package proving the complete extension contract.",
  profile: "operator",
  version: "1.1.1",
  capabilityLevel: "single_agent_app",
  format: "xml",
  folderPath: "examples/complex-operator",
  codePath: "examples/complex-operator/manifest.ts",
  promptPath: "examples/complex-operator/prompt.xml",
  tools: [
    {
      id: "operator.signal.read",
      invocation: "workflow",
      required: true,
      executionModes: ["dry_run"],
      modelVisibleDefault: true,
      purpose: "Read a deterministic signal through the Cloudflare runtime.",
    },
    {
      id: "operator.snapshot",
      invocation: "workflow",
      required: true,
      executionModes: ["dry_run"],
      modelVisibleDefault: false,
      purpose: "Read a deterministic signed-runner snapshot.",
    },
    {
      id: "operator.action.propose",
      invocation: "workflow",
      required: true,
      executionModes: ["dry_run"],
      modelVisibleDefault: false,
      purpose: "Create an auditable dry-run action proposal without mutation authority.",
    },
    {
      id: "operator.action.execute",
      invocation: "workflow",
      required: true,
      executionModes: ["dry_run", "execute"],
      modelVisibleDefault: false,
      purpose: "Execute an approved idempotent synthetic action through platform authority.",
    },
  ],
  workflows: [
    {
      type: "complex-operator.observe",
      engine: "cloudflare",
      status: "declared",
      userInvocable: true,
      description: "Combine inline and signed-runner evidence into a structured operator report.",
    },
    {
      type: "complex-operator.status",
      engine: "cloudflare",
      status: "declared",
      userInvocable: true,
      description: "Check deterministic operator status with explicit input.",
    },
  ],
  ui: {
    primarySurface: "workbench",
    inspectorSections: ["prompt", "tools", "history", "managed-state"],
    configurationMode: "code",
    welcome: {
      title: "Complex Operator",
      description: "Exercise the Runtime Module v1 package contract without external traffic.",
      starters: [
        {
          id: "observe",
          title: "Observe system",
          description: "Create a deterministic multi-step operator report.",
          action: { kind: "workflow", workflowType: "complex-operator.observe" },
        },
        {
          id: "explain",
          title: "Explain boundaries",
          description: "Explain the current operator policy boundaries.",
          action: { kind: "message", prompt: "Explain your runtime and mutation boundaries." },
        },
      ],
    },
  },
  risk: {
    financialData: true,
    externalMutation: true,
    requiresSecrets: false,
    productionGate: "mutation_gate",
  },
  connections: [
    {
      id: "operator.external-account",
      provider: "synthetic-broker",
      principal: "user",
      credentialClass: "api_key",
      custody: "external_broker",
      required: false,
      toolIds: ["operator.action.propose", "operator.action.execute"],
      scopes: ["propose", "execute"],
    },
    {
      id: "operator.oauth-observer",
      provider: "synthetic-broker",
      principal: "user",
      credentialClass: "oauth2",
      custody: "external_broker",
      required: false,
      toolIds: ["operator.signal.read"],
      scopes: ["observe"],
    },
  ],
  context: [
    {
      id: "operator.signal",
      trust: "retrieved",
      description: "Deterministic conformance signal returned by the runtime binding.",
      required: true,
      runtimeBinding: "operator.signal.read",
    },
  ],
  managedState: [
    {
      namespace: "complex-operator",
      schemaVersion: 1,
      description: "Latest deterministic observation for the synthetic operator.",
      recordKinds: ["observation"],
      views: [{ id: "current", title: "Current observation", recordKind: "observation" }],
    },
  ],
  triggers: [
    {
      id: "scheduled-observation",
      kind: "schedule",
      description: "Run a deterministic observation on a schedule.",
      workflowType: "complex-operator.observe",
      enabledByDefault: false,
      cron: "*/15 * * * *",
      timezone: "UTC",
    },
    {
      id: "observation-requested",
      kind: "webhook",
      description: "Run an observation after a signed external request.",
      workflowType: "complex-operator.observe",
      enabledByDefault: false,
      eventType: "complex-operator.observation_requested",
    },
  ],
  artifactRenderers: [
    {
      artifactKind: "complex_operator_report",
      renderer: "table",
      title: "Complex operator report",
      version: 1,
    },
  ],
  healthChecks: [
    {
      id: "signal.binding",
      target: { kind: "tool", id: "operator.signal.read" },
      description: "Verify the inline signal binding.",
      required: true,
    },
    {
      id: "snapshot.binding",
      target: { kind: "tool", id: "operator.snapshot" },
      description: "Verify the signed runner binding.",
      required: true,
    },
    {
      id: "workflow.binding",
      target: { kind: "workflow", type: "complex-operator.observe" },
      description: "Verify the multi-step workflow binding.",
      required: true,
    },
  ],
  evals: [
    {
      id: "operator.static",
      kind: "static_smoke",
      scenarioId: "observe-system",
      description: "Validate package and runtime binding consistency.",
      required: true,
    },
    {
      id: "operator.runtime",
      kind: "deterministic_runtime",
      scenarioId: "observe-system",
      description: "Execute the deterministic multi-step workflow.",
      required: true,
    },
  ],
  compatibility: { packApi: 2, minimumWorkbenchVersion: "0.5.0" },
  resourceLimits: {
    maxRunSeconds: 15,
    maxToolCallsPerRun: 3,
    maxConcurrentRuns: 1,
    maxArtifactBytes: 65_536,
  },
  smokeScenarios: [
    {
      id: "observe-system",
      prompt: "Create a deterministic observation and dry-run action proposal.",
    },
  ],
  prompt: `<identity>
You are a deterministic conformance-only complex operator.
</identity>
<policy>
Observe and propose only. Never claim to execute external mutations.
</policy>`,
});
