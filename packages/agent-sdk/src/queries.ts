import type { JsonSchema, RuntimeRecord, RuntimeScope } from "./runtime.js";
import type { RuntimeSettings } from "./settings.js";
import type { RuntimeStatePort } from "./state.js";
import { assertSchemaDefinition } from "./schema.js";

/** Read-only inputs for a query; no actions, tools, models, connections or writes are reachable. */
export type RuntimeQueryContext = {
  scope: Readonly<RuntimeScope>;
  pack: Readonly<{ id: string; version: string; runtimeVersion: string }>;
  settings: RuntimeSettings;
  signal: AbortSignal;
  /** The agent's current effect-target scope; present only when the module declares state. */
  state?: Pick<RuntimeStatePort, "get" | "list">;
};
/** A bounded, read-only projection for client read models. */
export type RuntimeQueryBinding = {
  id: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  /** Default 5000, maximum 15000. */
  timeoutMs?: number;
  execute(
    input: RuntimeRecord,
    context: RuntimeQueryContext,
  ): Promise<RuntimeRecord> | RuntimeRecord;
};

export const runtimeQueryDefaultTimeoutMs = 5000;
export const runtimeQueryMaxTimeoutMs = 15000;
const queryId = /^[a-z][a-z0-9._-]{0,63}$/;

export const assertRuntimeQueryBindings = (
  queries: readonly RuntimeQueryBinding[],
  label = "queries",
) => {
  if (!Array.isArray(queries) || queries.length > 32)
    throw new Error(`${label} must be an array of at most 32 bindings`);
  const seen = new Set<string>();
  for (const query of queries) {
    if (typeof query?.id !== "string" || !queryId.test(query.id) || seen.has(query.id))
      throw new Error(`${label} ids must be unique and match ${queryId.source}`);
    seen.add(query.id);
    if (typeof query.description !== "string" || !query.description.trim())
      throw new Error(`${label} ${query.id} requires a description`);
    if (typeof query.execute !== "function")
      throw new Error(`${label} ${query.id} execute must be a function`);
    if (
      query.timeoutMs !== undefined &&
      (!Number.isInteger(query.timeoutMs) ||
        query.timeoutMs < 1 ||
        query.timeoutMs > runtimeQueryMaxTimeoutMs)
    )
      throw new Error(`${label} ${query.id} timeout must be 1-${runtimeQueryMaxTimeoutMs} ms`);
    assertSchemaDefinition(query.inputSchema, `${label} ${query.id} input`);
    assertSchemaDefinition(query.outputSchema, `${label} ${query.id} output`);
    if (query.inputSchema.type !== "object" || query.outputSchema.type !== "object")
      throw new Error(`${label} ${query.id} input and output schemas must be objects`);
  }
};
