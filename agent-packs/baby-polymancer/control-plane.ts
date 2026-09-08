import {
  defineControlPlaneModule,
  type RuntimeRecord,
  type RuntimeResult,
} from "@operloom/agent-sdk/control-plane";

import {
  runPolymarketMarketSearch,
  runPolymarketMarketSnapshot,
  runPolymarketOrderbookSnapshot,
  validatePolymarketMarketSearchInput,
  validatePolymarketMarketSnapshotInput,
  validatePolymarketOrderbookSnapshotInput,
  type PolymarketMarketSearchOutput,
  type PolymarketMarketSnapshotOutput,
  type PolymarketOrderbookSnapshotOutput,
} from "../../lib/workbench/polymarket-readonly";

const readonlyPolicy = (reference: string) => ({
  reference,
  adminVisible: true,
  modelVisible: false,
  requiresApproval: false,
  policyEditable: true,
  mutationRisk: "read_only" as const,
});

const invalid = (error: {
  code: string;
  message: string;
  retryable: boolean;
  redacted: true;
}): RuntimeResult => ({
  ok: false,
  error,
  summary: error.message,
});

const success = (
  result:
    | { ok: true; output: RuntimeRecord }
    | { ok: false; error: { code: string; message: string; retryable: boolean; redacted: true } },
): RuntimeResult =>
  result.ok
    ? {
        ok: true,
        output: result.output,
        summary: String(result.output.summary ?? "Tool completed."),
      }
    : invalid(result.error);

const buildResearchReport = (input: {
  search: PolymarketMarketSearchOutput;
  snapshot: PolymarketMarketSnapshotOutput;
  orderbook?: PolymarketOrderbookSnapshotOutput;
}) => {
  const market = input.snapshot.market;
  const numericLiquidity = Number(market.liquidity);
  const warnings = [
    market.closed ? "The selected market is closed." : null,
    market.active === false ? "The selected market is not active." : null,
    Number.isFinite(numericLiquidity) && numericLiquidity < 1_000
      ? "Visible market liquidity is low."
      : null,
    input.orderbook && (input.orderbook.bidCount === 0 || input.orderbook.askCount === 0)
      ? "The visible order book is one-sided or empty."
      : null,
    !input.orderbook ? "No public order-book snapshot was available." : null,
  ].filter((item): item is string => Boolean(item));
  return {
    status: warnings.length ? "review" : "ok",
    summary: `Read-only market research completed for ${market.question ?? market.slug ?? "market"}.`,
    candidateMarkets: input.search.markets.slice(0, 5),
    selectedMarket: market,
    selectionRationale:
      "Selected the first bounded search result with a market slug and public CLOB token identifiers.",
    outcomeComparison: market.outcomes.map((outcome, index) => ({
      outcome,
      price: market.outcomePrices[index] ?? null,
    })),
    liquidity: market.liquidity ?? null,
    volume: market.volume ?? null,
    orderbook: input.orderbook
      ? {
          tokenId: input.orderbook.tokenId,
          bestBid: input.orderbook.bestBid ?? null,
          bestAsk: input.orderbook.bestAsk ?? null,
          spread: input.orderbook.spread ?? null,
          bidCount: input.orderbook.bidCount,
          askCount: input.orderbook.askCount,
          topBids: input.orderbook.topBids,
          topAsks: input.orderbook.topAsks,
        }
      : null,
    warnings,
    limitations: [
      "Market prices are noisy implied probabilities, not verified facts.",
      "Visible public depth can change and does not guarantee executable liquidity.",
    ],
    risk: {
      financialData: true,
      externalMutation: false,
      requiresSecrets: false,
      trading: false,
      advice: false,
    },
  };
};

export const controlPlane = defineControlPlaneModule({
  packId: "baby-polymancer",
  runtimeVersion: "1.1.1",
  compatiblePackVersions: "^1.1.0",
  tools: [
    {
      id: "polymarket.market.search",
      description: "Search bounded public Polymarket metadata.",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 80 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
      },
      outputSchema: { type: "object" },
      executionModes: ["dry_run"],
      transport: "cloudflare_inline",
      adapterVersion: "polymarket-market-search-v1",
      timeoutMs: 8_000,
      maxArtifactBytes: 65_536,
      policy: readonlyPolicy("polymarket-readonly-v0"),
      async execute(input) {
        const parsed = validatePolymarketMarketSearchInput({ ...input, limit: input.limit ?? 5 });
        return "code" in parsed
          ? invalid(parsed)
          : success(await runPolymarketMarketSearch(parsed));
      },
    },
    {
      id: "polymarket.market.snapshot",
      description: "Read bounded public market metadata.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      executionModes: ["dry_run"],
      transport: "cloudflare_inline",
      adapterVersion: "polymarket-market-snapshot-v1",
      timeoutMs: 8_000,
      maxArtifactBytes: 65_536,
      policy: readonlyPolicy("polymarket-readonly-v0"),
      async execute(input) {
        const parsed = validatePolymarketMarketSnapshotInput(input);
        return "code" in parsed
          ? invalid(parsed)
          : success(await runPolymarketMarketSnapshot(parsed));
      },
    },
    {
      id: "polymarket.orderbook.snapshot",
      description: "Read a bounded public order-book snapshot.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      executionModes: ["dry_run"],
      transport: "cloudflare_inline",
      adapterVersion: "polymarket-orderbook-snapshot-v1",
      timeoutMs: 8_000,
      maxArtifactBytes: 65_536,
      policy: readonlyPolicy("polymarket-readonly-v0"),
      async execute(input) {
        const parsed = validatePolymarketOrderbookSnapshotInput(input);
        return "code" in parsed
          ? invalid(parsed)
          : success(await runPolymarketOrderbookSnapshot(parsed));
      },
    },
  ],
  workflows: [
    {
      type: "polymancer.market_research",
      engine: "cloudflare",
      label: "Market research",
      description: "Search public Polymarket markets and write a compact report.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string", minLength: 1, maxLength: 80, default: "Bitcoin" } },
      },
      outputSchema: { type: "object" },
      form: [
        {
          name: "query",
          label: "Market query",
          description: "Public Polymarket search query.",
          kind: "text",
          placeholder: "Bitcoin",
        },
      ],
      toolIds: [
        "polymarket.market.search",
        "polymarket.market.snapshot",
        "polymarket.orderbook.snapshot",
      ],
      cancellation: { adapter: "none", physicalAbort: "unsupported" },
      smokeCommand: "pnpm smoke:polymarket-readonly",
      normalizeInput: (input) => {
        const query = typeof input.query === "string" ? input.query.trim() : "";
        return { query: (query || "Bitcoin").slice(0, 80) };
      },
      async execute(input, context) {
        const search = await context.tools.invoke("polymarket.market.search", {
          query: String(input.query ?? "Bitcoin"),
          limit: 5,
        });
        if (!search.ok) return search;
        const searchOutput = search.output as PolymarketMarketSearchOutput;
        const market = searchOutput.markets.find(
          (candidate) => candidate.slug && candidate.clobTokenIds.length > 0,
        );
        if (!market?.slug) {
          return invalid({
            code: "market_not_found",
            message: "Search returned no market with a slug and CLOB token ids.",
            retryable: false,
            redacted: true,
          });
        }
        const snapshot = await context.tools.invoke("polymarket.market.snapshot", {
          slug: market.slug,
        });
        if (!snapshot.ok) return snapshot;
        const tokenId = market.clobTokenIds[0];
        const orderbook = tokenId
          ? await context.tools.invoke("polymarket.orderbook.snapshot", { tokenId })
          : null;
        const report = buildResearchReport({
          search: searchOutput,
          snapshot: snapshot.output as PolymarketMarketSnapshotOutput,
          orderbook: orderbook?.ok
            ? (orderbook.output as PolymarketOrderbookSnapshotOutput)
            : undefined,
        });
        return {
          ok: true,
          output: report,
          summary: report.summary,
          artifacts: [
            {
              kind: "market_research_report",
              title: "Polymancer market research report",
              mimeType: "application/json",
              data: {
                source: "polymancer_market_research",
                workflowType: "polymancer.market_research",
                packId: "baby-polymancer",
                report,
              },
            },
          ],
        };
      },
    },
  ],
  health: [
    {
      id: "market.search.binding",
      required: true,
      check: () => ({ ok: true, summary: "Market research bindings compiled." }),
    },
    {
      id: "market.research.binding",
      required: true,
      check: () => ({ ok: true, summary: "Market research workflow compiled." }),
    },
  ],
  evals: [
    {
      id: "market.discovery.static",
      required: true,
      run: () => ({ ok: true, summary: "Polymancer static contract compiled." }),
    },
  ],
});
