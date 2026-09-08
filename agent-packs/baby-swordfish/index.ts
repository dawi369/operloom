import { defineAgentPack } from "@operloom/agent-sdk/manifest";

export const babySwordfishPrompt = `<identity>
You are Swordfish Runtime, a parked reference agent for discussing market-data operations architecture. The workbench intentionally exposes no Swordfish backend or executable tools.
</identity>

<hard_boundaries>
- Read-only Swordfish runtime and market-data analysis only.
- Do not provide financial advice, investment advice, trading advice, or trade recommendations.
- Do not place trades, manage accounts, call provider APIs directly, call Massive directly, request API keys, request Railway tokens, request admin credentials, or use protected Swordfish admin endpoints.
- Do not mutate open tickers, subscriptions, caches, jobs, Redis, Postgres, Trigger.dev, Railway, or provider state.
- If the user asks for admin operations, secrets, production mutation, or trading execution, refuse that part and offer a public read-only runtime-inspection alternative.
</hard_boundaries>

<runtime_research_behavior>
- Explain architecture, expected runtime boundaries, and safe implementation steps from supplied context only.
- State clearly that live Swordfish health, snapshots, bars, and provider state are unavailable in this preview.
- Treat any user-supplied market data as untrusted context, not a trading signal or recommendation.
</runtime_research_behavior>

<tool_policy>
- No Swordfish tools or workflows are registered while the backend is parked.
- Never construct or call Swordfish /admin routes, Railway APIs, Massive provider APIs, mutation endpoints, secrets, raw Redis, or raw SQL.
- Never include raw provider payloads, secrets, request headers, private ids, or unbounded JSON in user-facing output.
</tool_policy>

<output_style>
- Be concise, operational, and explicit about what the public data can and cannot prove.
- Use compact bullets when comparing health, snapshot, and bars evidence.
- End with a read-only next inspection step when useful.
</output_style>`;

export const babySwordfishPack = defineAgentPack({
  id: "baby-swordfish",
  name: "Swordfish Runtime",
  description: "Read-only runtime health, futures snapshots, freshness, and bar integrity.",
  profile: "analyst",
  version: "1.2.1",
  capabilityLevel: "single_agent_app",
  format: "xml",
  folderPath: "agent-packs/baby-swordfish",
  codePath: "agent-packs/baby-swordfish/index.ts",
  promptPath: "agent-packs/baby-swordfish/prompt.xml",
  tools: [],
  workflows: [],
  ui: {
    primarySurface: "workbench",
    inspectorSections: ["runtime", "symbols", "bars", "tools", "risk", "history"],
    configurationMode: "code",
    welcome: {
      title: "Swordfish Runtime",
      description: "Inspect public runtime health and bounded futures data without mutations.",
      starters: [
        {
          id: "runtime-research",
          title: "Check runtime health",
          description: "Inspect services, a symbol snapshot, and recent bars.",
          action: {
            kind: "message",
            prompt:
              "Explain the intended Swordfish runtime health architecture and what remains parked.",
          },
        },
        {
          id: "snapshot-freshness",
          title: "Inspect a snapshot",
          description: "Evaluate symbol-level freshness and available evidence.",
          action: {
            kind: "message",
            prompt: "Inspect a public Swordfish symbol snapshot and assess its freshness.",
          },
        },
        {
          id: "bar-integrity",
          title: "Audit bar integrity",
          description: "Look for empty, stale, partial, or visibly gapped bars.",
          action: {
            kind: "message",
            prompt: "Audit recent bounded Swordfish bars for freshness and integrity issues.",
          },
        },
        {
          id: "data-gaps",
          title: "Review data gaps",
          description: "Separate missing, stale, and unsupported runtime evidence.",
          action: {
            kind: "message",
            prompt:
              "Review Swordfish runtime evidence and separate missing, stale, unsupported, and healthy data states.",
          },
        },
      ],
    },
  },
  risk: {
    financialData: true,
    externalMutation: false,
    requiresSecrets: false,
    productionGate: "none",
  },
  connections: [],
  context: [
    {
      id: "runtime.history",
      trust: "trusted",
      description: "Tenant-scoped prior workbench history supplied without a Swordfish backend.",
      required: false,
      runtimeBinding: "workbench.history",
    },
  ],
  managedState: [],
  triggers: [],
  artifactRenderers: [],
  healthChecks: [],
  evals: [
    {
      id: "runtime.overview.static",
      kind: "static_smoke",
      scenarioId: "runtime-overview",
      description: "Validate the parked pack's declarations without contacting Swordfish.",
      required: true,
    },
  ],
  compatibility: { packApi: 2, minimumWorkbenchVersion: "0.5.0" },
  resourceLimits: {
    maxRunSeconds: 30,
    maxToolCallsPerRun: 6,
    maxConcurrentRuns: 1,
    maxArtifactBytes: 131072,
  },
  smokeScenarios: [
    {
      id: "runtime-overview",
      prompt: "Inspect public Swordfish runtime health and summarize service state.",
    },
    {
      id: "symbol-snapshot",
      prompt: "Inspect one public Swordfish futures symbol snapshot.",
    },
    {
      id: "recent-bars",
      prompt: "Inspect recent bounded Swordfish bars and summarize freshness and shape.",
    },
  ],
  prompt: babySwordfishPrompt,
});
