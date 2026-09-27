import type { AgentPackContextSource } from "./manifest.js";
import type { RuntimeRecord, RuntimeScope, JsonSchema } from "./runtime.js";
import type { RuntimeStatePort } from "./state.js";
import { assertSchemaDefinition, assertSchemaValue } from "./schema.js";

export type RuntimeContextBinding = {
  id: string;
  version: string;
  schema: JsonSchema;
  maxAgeMs: number;
  timeoutMs: number;
  resolve(input: {
    scope: Readonly<RuntimeScope>;
    input: Readonly<RuntimeRecord>;
    state?: Pick<RuntimeStatePort, "get" | "list">;
    signal: AbortSignal;
  }): Promise<RuntimeContextObservation> | RuntimeContextObservation;
};
export type RuntimeContextObservation =
  | { status: "missing" }
  | {
      status: "available";
      data: RuntimeRecord;
      observedAt: string;
      expiresAt: string;
      provenance: readonly { reference: string; version?: string }[];
    };
export type RuntimeContextSourceResult = {
  id: string;
  binding: string;
  version: string;
  trust: AgentPackContextSource["trust"];
  required: boolean;
  status: "fresh" | "stale" | "missing" | "invalid" | "failed";
  observedAt?: string;
  expiresAt?: string;
  data?: RuntimeRecord;
  provenance?: readonly { reference: string; version?: string }[];
};
export type RuntimeContextEvidence = {
  capturedAt: string;
  status: "ready" | "blocked";
  sources: RuntimeContextSourceResult[];
};
export type RuntimeContextSnapshot = RuntimeContextEvidence & {
  id: string;
  runId: string;
  runKind: "workflow" | "chat";
  target: "simulation" | "external";
  agentRevision: number;
  packId: string;
  packVersion: string;
  runtimeVersion: string;
  configurationHash: string;
  inputHash: string;
  contentHash: string;
  /** Absent on historical snapshots. Chosen by the platform, never by the package. */
  captureKey?: string;
  revision?: number;
  stepId?: string;
};
export type RuntimeContextPort = {
  snapshot: Readonly<RuntimeContextSnapshot>;
  assertReady(): void;
};
const key = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const assertRuntimeContextBindings = (
  descriptors: readonly AgentPackContextSource[],
  bindings: readonly RuntimeContextBinding[],
) => {
  if (
    descriptors.length > 16 ||
    bindings.length > 16 ||
    new Set(descriptors.map((item) => item.id)).size !== descriptors.length ||
    new Set(bindings.map((item) => item.id)).size !== bindings.length
  )
    throw new Error("Context requires at most 16 uniquely identified sources and bindings");
  for (const binding of bindings) {
    if (
      !key.test(binding.id) ||
      !key.test(binding.version) ||
      typeof binding.resolve !== "function" ||
      !Number.isInteger(binding.maxAgeMs) ||
      binding.maxAgeMs < 1 ||
      binding.maxAgeMs > 86400000 ||
      !Number.isInteger(binding.timeoutMs) ||
      binding.timeoutMs < 1 ||
      binding.timeoutMs > 5000
    )
      throw new Error("Context binding version, resolver, age or deadline is invalid");
    assertSchemaDefinition(binding.schema, `context ${binding.id}`);
    if (binding.schema.type !== "object")
      throw new Error("Context output schema must be an object");
  }
  for (const source of descriptors)
    if (
      !key.test(source.id) ||
      !["trusted", "retrieved", "untrusted"].includes(source.trust) ||
      typeof source.required !== "boolean" ||
      !bindings.some((binding) => binding.id === source.runtimeBinding)
    )
      throw new Error(`Context source ${source.id} requires an executable scoped binding`);
  for (const binding of bindings)
    if (!descriptors.some((source) => source.runtimeBinding === binding.id))
      throw new Error("Unused context binding");
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
export const assertRuntimeContextReady = (snapshot: RuntimeContextEvidence, now = Date.now()) => {
  if (
    snapshot.status === "blocked" ||
    snapshot.sources.some(
      (source) =>
        source.required &&
        (source.status !== "fresh" || !source.expiresAt || Date.parse(source.expiresAt) <= now),
    )
  )
    throw Object.assign(
      new Error("Required context is unavailable or stale. Refresh evidence before retrying."),
      { code: "context_blocked" },
    );
};

export const collectRuntimeContext = async (input: {
  descriptors: readonly AgentPackContextSource[];
  bindings: readonly RuntimeContextBinding[];
  scope: RuntimeScope;
  input: RuntimeRecord;
  state?: Pick<RuntimeStatePort, "get" | "list">;
  signal: AbortSignal;
}): Promise<RuntimeContextEvidence> => {
  assertRuntimeContextBindings(input.descriptors, input.bindings);
  input.signal.throwIfAborted();
  const sources: RuntimeContextSourceResult[] = [];
  let bytes = 0;
  for (const descriptor of input.descriptors) {
    input.signal.throwIfAborted();
    const binding = input.bindings.find((item) => item.id === descriptor.runtimeBinding)!;
    const source: RuntimeContextSourceResult = {
      id: descriptor.id,
      binding: binding.id,
      version: binding.version,
      trust: descriptor.trust,
      required: descriptor.required,
      status: "failed",
    };
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() =>
          binding.resolve({
            scope: freeze({ ...input.scope }),
            input: freeze(structuredClone(input.input)),
            state: input.state,
            signal,
          }),
        ),
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          timeout = setTimeout(
            () => controller.abort(new Error("Context deadline exceeded")),
            binding.timeoutMs,
          );
        }),
      ]);
      input.signal.throwIfAborted();
      if (result?.status === "missing") source.status = "missing";
      else {
        source.status = "invalid";
        if (result?.status !== "available") throw new Error("Invalid context output");
        const serialized = JSON.stringify(result, (_key, value) => {
          if (
            typeof value === "function" ||
            typeof value === "bigint" ||
            (typeof value === "number" && !Number.isFinite(value))
          )
            throw new Error("Invalid context JSON");
          return value;
        });
        const size = new TextEncoder().encode(serialized).length;
        if (size > 16384 || bytes + size > 114688) throw new Error("Context size exceeded");
        const normalized = JSON.parse(serialized) as typeof result;
        assertSchemaValue(binding.schema, normalized.data, "context result");
        const observed = Date.parse(normalized.observedAt),
          expires = Date.parse(normalized.expiresAt),
          now = Date.now();
        if (
          typeof normalized.observedAt !== "string" ||
          typeof normalized.expiresAt !== "string" ||
          !Number.isFinite(observed) ||
          !Number.isFinite(expires) ||
          observed > now ||
          expires <= observed ||
          !Array.isArray(normalized.provenance) ||
          !normalized.provenance.length ||
          normalized.provenance.length > 16 ||
          normalized.provenance.some(
            (item) =>
              !item ||
              typeof item.reference !== "string" ||
              !item.reference.trim() ||
              item.reference.length > 512 ||
              (item.version !== undefined &&
                (typeof item.version !== "string" || item.version.length > 128)),
          )
        )
          throw new Error("Invalid provenance or observation timestamps");
        const effectiveExpiry = Math.min(expires, observed + binding.maxAgeMs);
        Object.assign(source, {
          status: effectiveExpiry <= now ? "stale" : "fresh",
          data: structuredClone(normalized.data),
          observedAt: new Date(observed).toISOString(),
          expiresAt: new Date(effectiveExpiry).toISOString(),
          provenance: normalized.provenance.map((item) => ({
            reference: item.reference,
            ...(item.version === undefined ? {} : { version: item.version }),
          })),
        });
        bytes += size;
      }
    } catch {
      input.signal.throwIfAborted();
      // Resolver failures never expose exception text, credentials or partial data.
    } finally {
      clearTimeout(timeout);
      if (abort) signal.removeEventListener("abort", abort);
    }
    sources.push(source);
  }
  const capturedAt = new Date().toISOString();
  for (const source of sources)
    if (source.status === "fresh" && Date.parse(source.expiresAt!) <= Date.parse(capturedAt))
      source.status = "stale";
  return {
    capturedAt,
    status: sources.some((source) => source.required && source.status !== "fresh")
      ? "blocked"
      : "ready",
    sources,
  };
};
