import {
  defineControlPlaneModule,
  monitorFingerprint,
  requireRuntimeState,
  type AgentExecutionContext,
  type ControlPlaneRuntimeModule,
  type RuntimeRecord,
  type RuntimeResult,
  type RuntimeStateCommit,
  type RuntimeStatePort,
  type RuntimeStateRecord,
} from "@operloom/agent-sdk/control-plane";

import {
  activityEventKey,
  activityTime,
  activityUrl,
  applyFill,
  checkRisk,
  evaluateHeartbeat,
  exposureUsd,
  isWalletAddress,
  markPosition,
  marketsUrl,
  paperFill,
  positionKey,
  startingCashUsd,
  translateActivity,
  translateMarket,
  type GammaMarket,
  type HeartbeatSnapshot,
  type MarketQuote,
  type PositionState,
  type WalletActivity,
} from "./domain";

const namespace = "polymancer";
const key = (kind: string, recordKey: string) => ({ namespace, kind, key: recordKey });
const read = (record: RuntimeStateRecord | null, kind: string, recordKey: string) =>
  record ?? { ...key(kind, recordKey), version: 0 };
const write = (kind: string, recordKey: string, data: RuntimeRecord) => ({
  ...key(kind, recordKey),
  schemaVersion: 1,
  data,
});
const probability = { type: "number", minimum: 0, maximum: 1 } as const;
const walletSchema = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } as const;

type Account = { cashUsd: number; realizedPnlUsd: number };
const accountOf = (record: RuntimeStateRecord | null): Account => ({
  cashUsd: Number(record?.data.cashUsd ?? startingCashUsd),
  realizedPnlUsd: Number(record?.data.realizedPnlUsd ?? 0),
});
const positionOf = (record: RuntimeStateRecord): PositionState =>
  record.data as unknown as PositionState;

const listAll = async (state: Pick<RuntimeStatePort, "list">, kind: string) => {
  const records: RuntimeStateRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await state.list({ namespace, kind, limit: 100, ...(cursor ? { cursor } : {}) });
    records.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor && records.length < 500);
  return records;
};

/** Holdings, cash and tracked wallets; also the chat's grounding evidence. */
const portfolioView = async (state: Pick<RuntimeStatePort, "get" | "list">) => {
  const [account, positions, wallets] = await Promise.all([
    state.get(key("account", "paper")),
    listAll(state, "position"),
    listAll(state, "wallet"),
  ]);
  const held = positions.map(positionOf).filter((position) => position.shares > 0);
  const marked = held.map(markPosition);
  const exposure = exposureUsd(held);
  const { cashUsd, realizedPnlUsd } = accountOf(account);
  return {
    cashUsd,
    realizedPnlUsd,
    exposureUsd: exposure,
    equityUsd: Number((cashUsd + exposure).toFixed(6)),
    unrealizedPnlUsd: Number(
      marked.reduce((total, item) => total + item.unrealizedPnlUsd, 0).toFixed(6),
    ),
    positions: marked,
    trackedWallets: wallets.map((wallet) => wallet.data),
  };
};

/** Paper execution exists only in simulation; external effects are not bound in this package. */
const requireSimulation = (context: AgentExecutionContext) => {
  const evidence = context.context;
  if (!evidence) throw new Error("Scoped context is required");
  evidence.assertReady();
  if (evidence.snapshot.target !== "simulation")
    throw Object.assign(
      new Error("Live trading is not available; switch the agent to simulation."),
      {
        code: "live_trading_unavailable",
      },
    );
  return evidence;
};

const startCopyTrading = async (
  input: RuntimeRecord,
  context: AgentExecutionContext,
): Promise<RuntimeResult> => {
  const state = requireRuntimeState(context);
  const address = String(input.walletAddress ?? "").toLowerCase();
  if (!isWalletAddress(address))
    return {
      ok: false,
      error: {
        code: "wallet_invalid",
        message: "Provide a 0x wallet address with 40 hex digits.",
        redacted: false,
      },
      summary: "The wallet address is invalid.",
    };
  const existing = await state.get(key("wallet", address));
  if (existing?.data.status === "active")
    return { ok: true, output: { ...existing.data }, summary: `Already copying ${address}.` };
  const wallet = { address, status: "active", activatedAt: new Date().toISOString() };
  await state.commit({
    idempotencyKey: `${context.run.id}.copy-start`,
    reads: [read(existing, "wallet", address)],
    writes: [write("wallet", address, wallet)],
    entries: [
      {
        id: `${context.run.id}.copy-start`,
        type: "decision",
        data: { outcome: "copy_trading_started", wallet: address },
      },
    ],
    events: [
      {
        id: `${context.run.id}.copy-start`,
        type: "copy_trading.started",
        data: { wallet: address },
      },
    ],
  });
  return { ok: true, output: wallet, summary: `Copy trading started for ${address}.` };
};

const fetchActivity = async (wallet: string, signal: AbortSignal): Promise<WalletActivity[]> => {
  const response = await fetch(activityUrl(wallet), {
    headers: { accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) throw new Error(`Wallet activity request failed (${response.status})`);
  const body = (await response.json()) as unknown;
  return Array.isArray(body) ? (body as WalletActivity[]).slice(0, 100) : [];
};

const fetchQuotes = async (
  marketIds: readonly string[],
  signal: AbortSignal,
): Promise<MarketQuote[]> => {
  if (!marketIds.length) return [];
  const response = await fetch(marketsUrl(marketIds), {
    headers: { accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) throw new Error(`Market quote request failed (${response.status})`);
  const body = (await response.json()) as unknown;
  return Array.isArray(body)
    ? (body as GammaMarket[]).flatMap((market) => translateMarket(market) ?? [])
    : [];
};

/** Mirrors each new tracked-wallet trade once: activity, fill ledger entry, position and cash commit together. */
const syncCopyTrades = async (
  input: RuntimeRecord,
  context: AgentExecutionContext,
): Promise<RuntimeResult> => {
  const state = requireRuntimeState(context);
  requireSimulation(context);
  const limits = {
    maxPositionUsd: Number(context.settings.values.maxPositionUsd),
    maxOpenPositions: Number(context.settings.values.maxOpenPositions),
  };
  const fixture = Array.isArray(input.activity) ? (input.activity as WalletActivity[]) : null;
  const wallets = (await listAll(state, "wallet")).filter(
    (wallet) => wallet.data.status === "active",
  );
  const summary = {
    wallets: wallets.length,
    copied: 0,
    skipped: 0,
    duplicates: 0,
    errors: [] as string[],
  };
  for (const wallet of wallets) {
    const address = String(wallet.data.address);
    let activity: WalletActivity[];
    try {
      activity = fixture ?? (await fetchActivity(address, context.signal));
    } catch (error) {
      summary.errors.push(
        `${address}: ${error instanceof Error ? error.message : "request failed"}`,
      );
      continue;
    }
    const since = Date.parse(String(wallet.data.activatedAt));
    const ordered = activity
      .filter((item) => !item.proxyWallet || item.proxyWallet.toLowerCase() === address)
      .map((item) => ({ item, at: activityTime(item) }))
      .filter(
        (entry): entry is { item: WalletActivity; at: string } =>
          entry.at !== null && Date.parse(entry.at) >= since,
      )
      .sort((left, right) => left.at.localeCompare(right.at));
    for (const { item, at } of ordered) {
      const eventKey = activityEventKey(item);
      const activityKey = await monitorFingerprint({ wallet: address, eventKey });
      const seen = await state.get(key("activity", activityKey));
      if (seen) {
        summary.duplicates += 1;
        continue;
      }
      const marketId = item.conditionId ?? item.slug;
      const base = { wallet: address, eventKey, observedAt: at, ...(marketId ? { marketId } : {}) };
      const translation = translateActivity(item);
      const skip = async (code: string, message: string) => {
        summary.skipped += 1;
        await state.commit({
          idempotencyKey: `activity-${activityKey}`,
          reads: [read(null, "activity", activityKey)],
          writes: [write("activity", activityKey, { ...base, status: "skipped", code, message })],
        });
      };
      if (!translation.ok) {
        await skip(translation.code, translation.message);
        continue;
      }
      const order = translation.order;
      const recordKey = positionKey(order.marketId, order.side);
      const [positionRecord, accountRecord, openPositions] = await Promise.all([
        state.get(key("position", recordKey)),
        state.get(key("account", "paper")),
        listAll(state, "position"),
      ]);
      const held = positionRecord ? positionOf(positionRecord) : null;
      const holding = held && held.shares > 0 ? held : null;
      const fill = paperFill(order, holding?.shares ?? 0);
      if (!fill) {
        await skip("nothing_to_sell", "No paper shares are held for this sell.");
        continue;
      }
      const next = applyFill(holding, fill);
      const account = accountOf(accountRecord);
      const risk = checkRisk({
        fill,
        next,
        opensPosition: !holding,
        openPositions: openPositions.filter((record) => Number(record.data.shares) > 0).length,
        cashUsd: account.cashUsd,
        limits,
      });
      if (!risk.ok) {
        await skip(risk.code, risk.message);
        continue;
      }
      const realized =
        fill.orderType === "sell" && holding
          ? (fill.fillPrice - holding.avgEntryPrice) * fill.shares
          : 0;
      const nextAccount = {
        cashUsd: Number(
          (account.cashUsd + (fill.orderType === "buy" ? -1 : 1) * fill.notionalUsd).toFixed(6),
        ),
        realizedPnlUsd: Number((account.realizedPnlUsd + realized).toFixed(6)),
      };
      const fillId = `fill-${activityKey}`;
      const commit: RuntimeStateCommit = {
        idempotencyKey: `activity-${activityKey}`,
        reads: [
          read(null, "activity", activityKey),
          read(positionRecord, "position", recordKey),
          read(accountRecord, "account", "paper"),
        ],
        writes: [
          write("activity", activityKey, { ...base, status: "copied", fillId, fill }),
          write("account", "paper", nextAccount),
          // A closed position is kept at zero shares so its history stays readable.
          write(
            "position",
            recordKey,
            next ?? { ...holding!, shares: 0, currentPrice: fill.fillPrice },
          ),
        ],
        entries: [
          {
            id: fillId,
            type: "effect",
            data: { ...fill, wallet: address, eventKey, realizedPnlUsd: realized },
          },
        ],
        events: [{ id: fillId, type: "paper.fill", data: { ...fill, wallet: address } }],
      };
      await state.commit(commit);
      summary.copied += 1;
    }
    await state.commit({
      idempotencyKey: `${context.run.id}.synced-${address}`,
      reads: [wallet],
      writes: [
        write("wallet", address, { ...wallet.data, lastSyncedAt: new Date().toISOString() }),
      ],
    });
  }
  return {
    ok: true,
    output: summary,
    summary: `Copied ${summary.copied} trade(s), skipped ${summary.skipped}.`,
  };
};

/** Marks positions to the latest quotes and records whether anything moved materially. */
const heartbeat = async (
  input: RuntimeRecord,
  context: AgentExecutionContext,
): Promise<RuntimeResult> => {
  const state = requireRuntimeState(context);
  const evidence = requireSimulation(context);
  const quotes = new Map<string, MarketQuote>(
    (await listAll(state, "market")).map((record) => [
      record.key,
      record.data as unknown as MarketQuote,
    ]),
  );
  const positionRecords = (await listAll(state, "position")).filter(
    (record) => Number(record.data.shares) > 0,
  );
  // Tests supply quotes; a monitor tick marks held markets from Polymarket's public API.
  const fresh = Array.isArray(input.markets)
    ? (input.markets as MarketQuote[])
    : await fetchQuotes(
        positionRecords.map((record) => positionOf(record).marketId),
        context.signal,
      );
  for (const quote of fresh) quotes.set(quote.marketId, quote);
  const marked = positionRecords.map((record) => {
    const position = positionOf(record);
    const quote = quotes.get(position.marketId);
    const currentPrice = quote
      ? position.side === "yes"
        ? quote.yesPrice
        : quote.noPrice
      : position.currentPrice;
    return { record, position: { ...position, currentPrice } };
  });
  const current: HeartbeatSnapshot = {
    positions: marked.map(({ position }) => ({
      marketId: position.marketId,
      side: position.side,
      currentPrice: position.currentPrice,
    })),
    markets: [...quotes.values()],
    totalExposureUsd: exposureUsd(marked.map(({ position }) => position)),
  };
  const baseline = await state.get(key("heartbeat", "latest"));
  const thresholds = {
    priceMoveAbs: Number(context.settings.values.priceMoveAbs),
    exposureMovePct: Number(context.settings.values.exposureMovePct),
  };
  const evaluation = evaluateHeartbeat(
    (baseline?.data as unknown as HeartbeatSnapshot | undefined) ?? null,
    current,
    thresholds,
  );
  const marketWrites = [...new Set(fresh.map((quote) => quote.marketId))];
  const marketRecords = await Promise.all(
    marketWrites.map((marketId) => state.get(key("market", marketId))),
  );
  const decisionId = `${context.run.id}.heartbeat`;
  await state.commit({
    idempotencyKey: decisionId,
    reads: [
      read(baseline, "heartbeat", "latest"),
      ...marked.map(({ record }) => record),
      ...marketWrites.map((marketId, index) =>
        read(marketRecords[index] ?? null, "market", marketId),
      ),
    ],
    writes: [
      write("heartbeat", "latest", { ...current, capturedAt: new Date().toISOString() }),
      ...marked.map(({ record, position }) => write("position", record.key, position)),
      ...marketWrites.map((marketId) => write("market", marketId, quotes.get(marketId)!)),
    ],
    entries: [
      {
        id: decisionId,
        type: "decision",
        data: {
          outcome: evaluation.status,
          changes: evaluation.changes,
          exposureUsd: current.totalExposureUsd,
          snapshotId: evidence.snapshot.id,
          settingsVersion: context.settings.version,
        },
      },
    ],
    ...(evaluation.status === "material"
      ? {
          events: [
            { id: decisionId, type: "heartbeat.material", data: { changes: evaluation.changes } },
          ],
        }
      : {}),
  });
  return {
    ok: true,
    output: {
      status: evaluation.status,
      changes: evaluation.changes,
      exposureUsd: current.totalExposureUsd,
    },
    summary: evaluation.status === "material" ? "Material change detected." : "No material change.",
  };
};

const workflow = (
  type: string,
  label: string,
  description: string,
  properties: Record<string, unknown>,
  execute: (input: RuntimeRecord, context: AgentExecutionContext) => Promise<RuntimeResult>,
  required: string[] = [],
  conformanceInput: RuntimeRecord = {},
) => ({
  type,
  label,
  description,
  inputSchema: { type: "object", additionalProperties: false, required, properties },
  outputSchema: { type: "object" },
  conformanceInput,
  form: [],
  toolIds: [],
  cancellation: { adapter: "none" as const, physicalAbort: "unsupported" as const },
  execute,
});

const activitySchema = { type: "array", maxItems: 100, items: { type: "object" } };
const quoteSchema = {
  type: "array",
  maxItems: 100,
  items: {
    type: "object",
    required: ["marketId", "question", "yesPrice", "noPrice"],
    properties: {
      marketId: { type: "string", minLength: 1, maxLength: 120 },
      question: { type: "string", maxLength: 500 },
      yesPrice: probability,
      noPrice: probability,
    },
  },
};

export const controlPlane: ControlPlaneRuntimeModule = defineControlPlaneModule<
  Omit<ControlPlaneRuntimeModule, "apiVersion" | "kind">
>({
  packId: "polymancer",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  requirements: {
    minimumBackendVersion: "2.0.0",
    capabilities: ["workflow.request", "context.snapshots", "state.atomic"],
  },
  settings: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        strategyPrompt: {
          type: "string",
          maxLength: 4000,
          description: "Your trading strategy, in plain language.",
        },
        maxPositionUsd: {
          type: "number",
          minimum: 1,
          maximum: 1000000,
          description: "Largest cost basis per position.",
        },
        maxOpenPositions: { type: "integer", minimum: 1, maximum: 100 },
        priceMoveAbs: {
          type: "number",
          minimum: 0.001,
          maximum: 1,
          description: "Heartbeat price move that counts as material.",
        },
        exposureMovePct: {
          type: "number",
          minimum: 0.001,
          maximum: 10,
          description: "Heartbeat exposure change (fraction) that counts as material.",
        },
      },
    },
    defaults: {
      strategyPrompt: "Mirror high-conviction tracked wallet trades while respecting risk limits.",
      maxPositionUsd: 100,
      maxOpenPositions: 10,
      priceMoveAbs: 0.05,
      exposureMovePct: 0.1,
    },
    editable: [
      "strategyPrompt",
      "maxPositionUsd",
      "maxOpenPositions",
      "priceMoveAbs",
      "exposureMovePct",
    ],
  },
  tools: [
    {
      id: "polymancer.copy.start",
      description:
        "Start copy trading a Polymarket wallet. Use when the user says 'start copy trading 0x…'.",
      inputSchema: {
        type: "object",
        required: ["walletAddress"],
        additionalProperties: false,
        properties: { walletAddress: walletSchema },
      },
      outputSchema: { type: "object" },
      executionModes: ["dry_run"],
      transport: "cloudflare_inline",
      adapterVersion: "copy-start-v1",
      timeoutMs: 5000,
      maxArtifactBytes: 1024,
      policy: {
        reference: "polymancer.copy.start.v1",
        adminVisible: true,
        modelVisible: true,
        requiresApproval: false,
        policyEditable: true,
        mutationRisk: "read_only",
      },
      execute: startCopyTrading,
    },
  ],
  health: [],
  evals: [],
  context: [
    {
      id: "polymancer.portfolio",
      version: "1",
      maxAgeMs: 60000,
      timeoutMs: 2000,
      schema: {
        type: "object",
        required: ["cashUsd", "exposureUsd", "positions", "trackedWallets"],
      },
      async resolve({ state }) {
        if (!state) return { status: "missing" };
        return {
          status: "available",
          data: await portfolioView(state),
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          provenance: [{ reference: "polymancer:paper-ledger", version: "1" }],
        };
      },
    },
  ],
  state: [
    {
      namespace,
      kind: "position",
      schemaVersion: 1,
      schema: {
        type: "object",
        required: ["marketId", "question", "side", "shares", "avgEntryPrice", "currentPrice"],
        additionalProperties: false,
        properties: {
          marketId: { type: "string", minLength: 1, maxLength: 120 },
          question: { type: "string", maxLength: 500 },
          side: { type: "string", enum: ["yes", "no"] },
          shares: { type: "number", minimum: 0 },
          avgEntryPrice: { type: "number", minimum: 0, maximum: 1 },
          currentPrice: probability,
        },
      },
    },
    {
      namespace,
      kind: "account",
      schemaVersion: 1,
      schema: {
        type: "object",
        required: ["cashUsd", "realizedPnlUsd"],
        additionalProperties: false,
        properties: { cashUsd: { type: "number" }, realizedPnlUsd: { type: "number" } },
      },
    },
    {
      namespace,
      kind: "wallet",
      schemaVersion: 1,
      schema: {
        type: "object",
        required: ["address", "status", "activatedAt"],
        additionalProperties: false,
        properties: {
          address: walletSchema,
          status: { type: "string", enum: ["active", "stopped"] },
          activatedAt: { type: "string" },
          lastSyncedAt: { type: "string" },
        },
      },
    },
    {
      namespace,
      kind: "activity",
      schemaVersion: 1,
      indexes: [{ name: "status", field: "status" }],
      schema: {
        type: "object",
        required: ["wallet", "eventKey", "observedAt", "status"],
        additionalProperties: false,
        properties: {
          wallet: walletSchema,
          eventKey: { type: "string", maxLength: 500 },
          observedAt: { type: "string" },
          marketId: { type: "string", maxLength: 120 },
          status: { type: "string", enum: ["copied", "skipped"] },
          code: { type: "string" },
          message: { type: "string" },
          fillId: { type: "string" },
          fill: { type: "object" },
        },
      },
    },
    {
      namespace,
      kind: "market",
      schemaVersion: 1,
      schema: {
        type: "object",
        required: ["marketId", "question", "yesPrice", "noPrice"],
        additionalProperties: false,
        properties: {
          marketId: { type: "string" },
          question: { type: "string" },
          yesPrice: probability,
          noPrice: probability,
        },
      },
    },
    {
      namespace,
      kind: "heartbeat",
      schemaVersion: 1,
      schema: {
        type: "object",
        required: ["positions", "markets", "totalExposureUsd", "capturedAt"],
      },
    },
  ],
  queries: [
    {
      id: "polymancer.portfolio",
      description: "Paper cash, marked positions, exposure and PnL.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "object",
        required: ["cashUsd", "exposureUsd", "equityUsd", "positions"],
      },
      execute: async (_input, context) => portfolioView(context.state!),
    },
    {
      id: "polymancer.operator-state",
      description: "Portfolio, tracked wallets and the latest copy-trading activity.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: { type: "object", required: ["portfolio", "activity"] },
      async execute(_input, context) {
        const [portfolio, activity] = await Promise.all([
          portfolioView(context.state!),
          listAll(context.state!, "activity"),
        ]);
        return {
          portfolio,
          activity: activity
            .map((record) => record.data)
            .sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)))
            .slice(0, 50),
        };
      },
    },
  ],
  workflows: [
    workflow(
      "polymancer.copy.start",
      "Start copy trading",
      "Track a Polymarket wallet and mirror its new trades on paper.",
      { walletAddress: walletSchema },
      startCopyTrading,
      ["walletAddress"],
      { walletAddress: "0x1111111111111111111111111111111111111111" },
    ),
    workflow(
      "polymancer.copy.sync",
      "Sync tracked wallets",
      "Mirror each new tracked-wallet trade once as a paper fill.",
      { activity: activitySchema },
      syncCopyTrades,
    ),
    workflow(
      "polymancer.heartbeat",
      "Heartbeat",
      "Mark positions to the latest quotes and record noop or material changes.",
      { markets: quoteSchema },
      heartbeat,
    ),
  ],
});
