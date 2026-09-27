import { isRecord, json } from "./http";
import { authenticatePublicApi } from "./public-api-auth";
import { checkDurableHandlerCompatibility } from "./durable-workflow-runtime";
import type { Env } from "./types";

export type DurableHandlerPin = {
  pack_id: string;
  pack_version: string;
  workflow_type: string;
  workflow_version: string;
  runtime_version: string;
  definition_hash: string;
};

/** Build inspection only. Never exposed by a hosted Worker or tenant API. */
export const handleDurableDeploymentProbe = async (request: Request, env: Env) => {
  if (
    env.OPERLOOM_ENVIRONMENT !== "local" ||
    env.OPERLOOM_LOCAL_API_ENABLED !== "true" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)
  )
    return json({ error: "not_found" }, { status: 404 });
  try {
    await authenticatePublicApi(request, env);
  } catch {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
  // Read with a byte bound rather than trusting Content-Length from the caller.
  const reader = request.body?.getReader();
  if (!reader) return json({ error: "invalid_pins" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 65536) {
      await reader.cancel();
      return json({ error: "payload_too_large" }, { status: 413 });
    }
    chunks.push(part.value);
  }
  let pins: unknown;
  try {
    const payload = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(chunk, offset);
      offset += chunk.byteLength;
    }
    pins = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return json({ error: "invalid_pins" }, { status: 400 });
  }
  const keys = [
    "pack_id",
    "pack_version",
    "workflow_type",
    "workflow_version",
    "runtime_version",
    "definition_hash",
  ];
  if (
    !Array.isArray(pins) ||
    pins.length > 100 ||
    pins.some(
      (pin) =>
        !isRecord(pin) ||
        Object.keys(pin).length !== keys.length ||
        keys.some(
          (key) => typeof pin[key] !== "string" || pin[key].length < 1 || pin[key].length > 256,
        ),
    )
  )
    return json({ error: "invalid_pins" }, { status: 400 });
  const results = [];
  for (const pin of pins)
    results.push(await checkDurableHandlerCompatibility(env, pin as DurableHandlerPin));
  return json({ results });
};
