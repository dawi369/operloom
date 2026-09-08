import { defineAgentPack } from "@operloom/agent-sdk/manifest";

export const babyPolymancerPrompt = `<identity>
You are Polymancer Research, a read-only Polymarket research specialist. You turn bounded public market and order-book evidence into clear comparisons while making uncertainty, liquidity risk, and data limitations explicit.
</identity>

<hard_boundaries>
- Read-only market analysis only.
- Do not provide financial advice, investment advice, betting advice, portfolio advice, or trade recommendations.
- Do not place orders, preview orders, cancel orders, sign payloads, manage wallets, request wallet credentials, request API keys, or use private/user position data.
- Do not claim access to trading, balances, private positions, authenticated endpoints, secrets, or wallet state.
- If the user asks for trading, execution, wallet auth, secrets, or private account data, refuse that part and offer a read-only market-analysis alternative.
</hard_boundaries>

<market_research_behavior>
- Start by clarifying the market, event, slug, tag, or token the user wants to inspect.
- Use public market discovery and CLOB read endpoints only when the runtime exposes them.
- Summarize outcomes, prices, active/closed state, liquidity, volume, CLOB token ids, and visible order book depth when available.
- Separate market-implied probabilities from factual claims about the real-world event.
- Call out stale, closed, illiquid, ambiguous, or thinly traded markets.
- Treat market prices as noisy signals, not truth.
</market_research_behavior>

<tool_policy>
- Expected tools are polymarket.market.search, polymarket.market.snapshot, and polymarket.orderbook.snapshot.
- These tools are dry-run/read-only workflow internals and are not directly user-invoked.
- Never construct or call Polymarket order, cancel, auth, wallet, balance, allowance, or user-position endpoints.
- Never include raw provider payloads, secrets, request headers, private ids, or unbounded JSON in user-facing output.
</tool_policy>

<output_style>
- Be concise, analytical, and explicit about uncertainty.
- Use compact tables or bullets when comparing markets or outcome prices.
- End with a read-only next research step when useful.
</output_style>`;

export const babyPolymancerPack = defineAgentPack({
  id: "baby-polymancer",
  name: "Polymancer · Example",
  description: "Read-only Polymarket discovery, pricing, liquidity, and order-book research.",
  profile: "analyst",
  version: "1.1.2",
  capabilityLevel: "single_agent_app",
  format: "xml",
  folderPath: "agent-packs/baby-polymancer",
  codePath: "agent-packs/baby-polymancer/index.ts",
  promptPath: "agent-packs/baby-polymancer/prompt.xml",
  tools: [
    {
      id: "polymarket.market.search",
      invocation: "workflow",
      required: true,
      executionModes: ["dry_run"],
      modelVisibleDefault: false,
      purpose: "Discover public Polymarket markets or events by query, slug, or tag.",
    },
    {
      id: "polymarket.market.snapshot",
      invocation: "workflow",
      required: true,
      executionModes: ["dry_run"],
      modelVisibleDefault: false,
      purpose: "Return compact public market metadata, outcome prices, liquidity, and token ids.",
    },
    {
      id: "polymarket.orderbook.snapshot",
      invocation: "workflow",
      required: true,
      executionModes: ["dry_run"],
      modelVisibleDefault: false,
      purpose: "Return a compact public CLOB order book summary for a market token id.",
    },
  ],
  workflows: [
    {
      type: "polymancer.market_research",
      engine: "cloudflare",
      status: "declared",
      userInvocable: true,
      description:
        "Cloudflare workflow for multi-step read-only market research and report synthesis.",
    },
  ],
  ui: {
    primarySurface: "workbench",
    inspectorSections: ["markets", "orderbook", "tools", "risk", "history"],
    configurationMode: "code",
    welcome: {
      title: "Polymancer Research",
      description: "Compare public prediction markets without trading or private account access.",
      starters: [
        {
          id: "market-research",
          title: "Research a market topic",
          description: "Search candidates and inspect pricing, liquidity, and depth.",
          action: { kind: "workflow", workflowType: "polymancer.market_research" },
        },
        {
          id: "pricing-explainer",
          title: "Explain market pricing",
          description: "Interpret outcomes and implied probabilities with caveats.",
          action: {
            kind: "message",
            prompt: "Explain how to evaluate a public Polymarket market's prices and liquidity.",
          },
        },
        {
          id: "orderbook-risk",
          title: "Inspect order-book risk",
          description: "Focus on spread, visible depth, and thin-market warnings.",
          action: {
            kind: "message",
            prompt: "Show me how to assess spread, visible depth, and thin-market risk read-only.",
          },
        },
        {
          id: "candidate-comparison",
          title: "Compare market candidates",
          description: "Rank relevant markets by fit, liquidity, and evidence quality.",
          action: {
            kind: "message",
            prompt:
              "Compare relevant public Polymarket candidates by question fit, liquidity, spread, and evidence quality.",
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
  connections: [
    {
      id: "polymarket.public-data",
      provider: "polymarket",
      principal: "none",
      credentialClass: "none",
      custody: "none",
      required: true,
      toolIds: [
        "polymarket.market.search",
        "polymarket.market.snapshot",
        "polymarket.orderbook.snapshot",
      ],
      scopes: [],
    },
  ],
  context: [
    {
      id: "polymarket.public_market_data",
      trust: "untrusted",
      description: "Public market and CLOB evidence returned by registered read-only adapters.",
      required: true,
      runtimeBinding: "polymarket.public",
    },
    {
      id: "runtime.history",
      trust: "trusted",
      description: "Tenant-scoped prior run evidence supplied by the workbench.",
      required: false,
      runtimeBinding: "workbench.history",
    },
  ],
  managedState: [],
  triggers: [],
  artifactRenderers: [
    {
      artifactKind: "market_research_report",
      renderer: "json",
      title: "Market research report",
      version: 1,
    },
  ],
  healthChecks: [
    {
      id: "market.search.binding",
      target: { kind: "tool", id: "polymarket.market.search" },
      description: "Verify that public market discovery is registered.",
      required: true,
    },
    {
      id: "market.research.binding",
      target: { kind: "workflow", type: "polymancer.market_research" },
      description: "Verify that the bounded research workflow is registered.",
      required: true,
    },
  ],
  evals: [
    {
      id: "market.discovery.static",
      kind: "static_smoke",
      scenarioId: "market-discovery",
      description: "Validate the checked-in market-discovery declarations and mappings.",
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
      id: "market-discovery",
      prompt: "Find active public markets about a topic and summarize the top candidates.",
    },
    {
      id: "market-snapshot",
      prompt: "Inspect one public market and explain outcome prices, liquidity, and token ids.",
    },
    {
      id: "orderbook-read",
      prompt: "Inspect a token order book and summarize visible spread and top depth.",
    },
  ],
  prompt: babyPolymancerPrompt,
});
