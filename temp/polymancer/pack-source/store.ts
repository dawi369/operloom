/** Typed-state helpers shared by the Polymancer runtime modules. */
import {
  monitorFingerprint,
  type AgentExecutionContext,
  type RuntimeRecord,
  type RuntimeStatePort,
  type RuntimeStateRecord,
} from "@operloom/agent-sdk/control-plane";

export const namespace = "polymancer";
export const key = (kind: string, recordKey: string) => ({ namespace, kind, key: recordKey });
/** The versioned read a write needs; version 0 when the record does not exist yet. */
export const read = (record: RuntimeStateRecord | null, kind: string, recordKey: string) =>
  record ?? { ...key(kind, recordKey), version: 0 };
export const write = (kind: string, recordKey: string, data: RuntimeRecord) => ({
  ...key(kind, recordKey),
  schemaVersion: 1,
  data,
});
/** Drops undefined fields, which typed state rejects. */
export const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const listAll = async (
  state: Pick<RuntimeStatePort, "list">,
  kind: string,
  index?: { name: string; value: string },
) => {
  const records: RuntimeStateRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await state.list({
      namespace,
      kind,
      limit: 100,
      ...(index ? { index } : {}),
      ...(cursor ? { cursor } : {}),
    });
    records.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor && records.length < 500);
  return records;
};

/** Short stable id derived from its inputs, so retries produce the same record key. */
export const stableId = async (prefix: string, ...parts: string[]) =>
  `${prefix}-${(await monitorFingerprint(parts)).slice(0, 12)}`;

export const fail = (code: string, message: string) => ({
  ok: false as const,
  error: { code, message, redacted: false },
  summary: message,
});

/** Paper execution exists only in simulation; external effects are not bound in this package. */
export const requireSimulation = (context: AgentExecutionContext) => {
  const evidence = context.context;
  if (!evidence) throw new Error("Scoped context is required");
  evidence.assertReady();
  if (evidence.snapshot.target !== "simulation")
    throw Object.assign(
      new Error("Live trading is not available; switch the agent to simulation."),
      { code: "live_trading_unavailable" },
    );
  return evidence;
};
