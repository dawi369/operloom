import type { RuntimeRecord } from "./runtime.js";
import type {
  RuntimeStateCommit,
  RuntimeStateDefinition,
  RuntimeStateKey,
  RuntimeStatePort,
} from "./state.js";

/** State kind that stores the last observation a monitor acted on. */
export const monitorCursorKind = "monitor.cursor";

/** Declare in `state` for each namespace that uses {@link observeMonitor}. */
export const monitorCursorState = (namespace: string): RuntimeStateDefinition => ({
  namespace,
  kind: monitorCursorKind,
  schemaVersion: 1,
  schema: {
    type: "object",
    required: ["fingerprint", "observedAt"],
    additionalProperties: false,
    properties: {
      fingerprint: { type: "string", minLength: 1, maxLength: 128 },
      observedAt: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
});

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as RuntimeRecord)[key])}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Monitor observations must be JSON values");
  return encoded;
};

/** SHA-256 of the canonical JSON observation; equal observations share a fingerprint. */
export const monitorFingerprint = async (observation: unknown) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(observation)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export type MonitorObservation = {
  /** False when the stored cursor already holds this fingerprint; the tick should no-op. */
  changed: boolean;
  previousFingerprint: string | null;
  /**
   * Merge into the decision commit. The versioned read makes concurrent or retried ticks for
   * the same observation conflict instead of acting twice.
   */
  commit: Pick<RuntimeStateCommit, "reads" | "writes">;
};

export const observeMonitor = async (
  state: Pick<RuntimeStatePort, "get">,
  input: { namespace: string; key: string; fingerprint: string; observedAt: string },
): Promise<MonitorObservation> => {
  if (!input.fingerprint || input.fingerprint.length > 128)
    throw new Error("Monitor fingerprints must be 1-128 characters");
  const key: RuntimeStateKey = {
    namespace: input.namespace,
    kind: monitorCursorKind,
    key: input.key,
  };
  const previous = await state.get(key);
  const previousFingerprint =
    typeof previous?.data.fingerprint === "string" ? previous.data.fingerprint : null;
  const changed = previousFingerprint !== input.fingerprint;
  return {
    changed,
    previousFingerprint,
    commit: {
      reads: [{ ...key, version: previous?.version ?? 0 }],
      writes: changed
        ? [
            {
              ...key,
              schemaVersion: 1,
              data: { fingerprint: input.fingerprint, observedAt: input.observedAt },
            },
          ]
        : [],
    },
  };
};
