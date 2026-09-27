import { defineAgentPack } from "@operloom/agent-sdk/manifest";

export const polymancerPrompt = `<identity>
You are Polymancer, a Polymarket paper-trading operator. You follow the user's saved strategy, copy tracked wallets on paper, and explain holdings and decisions from recorded evidence.
</identity>

<grounding>
- Answer strategy questions from the agent_settings strategyPrompt.
- Answer holdings questions only from the polymancer.portfolio runtime evidence: cash, positions, exposure and PnL. Never invent positions or prices.
- When evidence is missing or stale, say so.
</grounding>

<commands>
- When the user says "start copy trading 0x…", call polymancer.copy.start with that wallet address.
- Paper fills happen automatically when a tracked wallet trades; you do not place orders.
</commands>

<boundaries>
- All trading is paper trading. Never claim to place live orders, move funds or access wallet credentials.
- Do not give financial advice; describe what the strategy and evidence imply.
</boundaries>`;

export const polymancerPack = defineAgentPack({
  id: "polymancer",
  name: "Polymancer",
  description:
    "Paper-trade Polymarket by copying tracked wallets under your strategy and risk limits.",
  profile: "operator",
  version: "1.0.0",
  capabilityLevel: "single_agent_app",
  format: "xml",
  folderPath: "agent-packs/polymancer",
  codePath: "agent-packs/polymancer/index.ts",
  promptPath: "agent-packs/polymancer/prompt.xml",
  tools: [
    {
      id: "polymancer.copy.start",
      invocation: "agent",
      required: true,
      executionModes: ["dry_run"],
      modelVisibleDefault: true,
      purpose: "Start copy trading a Polymarket wallet from chat.",
    },
  ],
  workflows: [
    {
      type: "polymancer.copy.start",
      status: "declared",
      userInvocable: true,
      description: "Track a wallet and mirror its new trades on paper.",
    },
    {
      type: "polymancer.copy.sync",
      status: "declared",
      userInvocable: true,
      description: "Mirror new tracked-wallet trades as paper fills.",
    },
    {
      type: "polymancer.heartbeat",
      status: "declared",
      userInvocable: true,
      description: "Mark positions and record noop or material changes.",
    },
  ],
  ui: {
    primarySurface: "workbench",
    inspectorSections: ["prompt", "history"],
    configurationMode: "code",
    welcome: {
      title: "Polymancer",
      description:
        "Save your strategy in /operations, then say “start copy trading 0x…”. Tracked wallet trades become paper fills.",
      starters: [
        {
          id: "strategy",
          title: "My strategy",
          description: "Summarize the saved strategy.",
          action: { kind: "message", prompt: "What is my current strategy?" },
        },
        {
          id: "holdings",
          title: "My holdings",
          description: "List paper positions, cash and PnL.",
          action: { kind: "message", prompt: "What positions do I hold right now?" },
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
      id: "portfolio",
      trust: "trusted",
      description: "Paper cash, positions, exposure and tracked wallets from the agent's ledger.",
      required: true,
      runtimeBinding: "polymancer.portfolio",
    },
  ],
  managedState: [
    {
      namespace: "polymancer",
      schemaVersion: 1,
      description: "Paper positions, account, tracked wallets, copy activity and market marks.",
      recordKinds: ["position", "account", "wallet", "activity", "market", "heartbeat"],
      views: [],
    },
  ],
  triggers: [
    {
      id: "wallet-activity",
      kind: "monitor",
      description: "Mirror new tracked-wallet trades once a minute.",
      workflowType: "polymancer.copy.sync",
      enabledByDefault: false,
      intervalSeconds: 60,
    },
    {
      id: "heartbeat",
      kind: "monitor",
      description: "Mark positions and record material moves once a minute.",
      workflowType: "polymancer.heartbeat",
      enabledByDefault: false,
      intervalSeconds: 60,
    },
  ],
  artifactRenderers: [],
  healthChecks: [],
  evals: [],
  compatibility: { packApi: 2, minimumWorkbenchVersion: "2.0.0" },
  resourceLimits: {
    maxRunSeconds: 30,
    maxToolCallsPerRun: 1,
    maxConcurrentRuns: 1,
    maxArtifactBytes: 1024,
  },
  smokeScenarios: [{ id: "holdings", prompt: "What positions do I hold right now?" }],
  prompt: polymancerPrompt,
});
