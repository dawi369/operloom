import { assertSchemaValue, type RuntimeToolBinding } from "@operloom/agent-sdk/control-plane";
import { requireConnectionProvider } from "./connection-providers";
import type { Env } from "./types";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["resource", "units"],
  properties: {
    resource: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" },
    units: { type: "integer", minimum: 1, maximum: 1000000 },
  },
} as const;
const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "resourceId", "lifecycle"],
  properties: {
    requestId: { type: "string", pattern: "^[a-f0-9]{64}$" },
    resourceId: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" },
    lifecycle: { type: "string", enum: ["pending", "active", "rejected"] },
  },
} as const;

// Trusted build-time registry. Runtime packages cannot add credential handlers.
const operations = [
  { id: "capacity.allocate", version: "1", providerId: "capacity-service", auth: "bearer" },
  {
    id: "capacity.allocate-signed",
    version: "1",
    providerId: "signed-capacity-service",
    auth: "hmac-sha256",
  },
] as const;

export const providerOperationDescriptor = (
  env: Env,
  binding: RuntimeToolBinding,
  providerId?: string,
) => {
  const reference = binding.action?.providerOperation;
  if (!reference) return null;
  if (env.WORKBENCH_PROVIDER_OPERATIONS_ENABLED !== "true")
    throw new Error("provider_operations_disabled");
  if (
    binding.action?.target !== "external" ||
    binding.transport !== "cloudflare_inline" ||
    !binding.action.connectionId ||
    binding.action.execute ||
    binding.action.reconcile ||
    binding.action.approval !== "required" ||
    !binding.policy.requiresApproval
  )
    throw new Error("provider_operation_binding_invalid");
  const operation = operations.find(
    (item) => item.id === reference.id && item.version === reference.version,
  );
  if (!operation || (providerId !== undefined && providerId !== operation.providerId))
    throw new Error("provider_operation_unavailable");
  let provider;
  try {
    provider = requireConnectionProvider(env, operation.providerId);
  } catch {
    throw new Error("provider_operation_configuration_invalid");
  }
  if (!provider.actionUrl) throw new Error("provider_operation_endpoint_missing");
  const url = new URL(provider.actionUrl);
  if (
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !url.pathname.endsWith("/allocations")
  )
    throw new Error("provider_operation_endpoint_invalid");
  return {
    ...operation,
    url: url.toString(),
    method: "POST" as const,
    credentialClass: "api_key" as const,
    inputSchema,
    outputSchema,
    timeoutMs: Math.min(5000, binding.action.timeoutMs),
    maxResponseBytes: 65536,
  };
};
export type ProviderOperationDescriptor = NonNullable<
  ReturnType<typeof providerOperationDescriptor>
>;

export const providerOperationOutput = (
  operation: ProviderOperationDescriptor,
  raw: unknown,
  requestId: string,
  secret: string,
) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("provider_response_invalid");
  const value = raw as Record<string, unknown>;
  // Projection is an allowlist: arbitrary provider fields never leave the broker.
  const output = {
    requestId: value.requestId,
    resourceId: value.resourceId,
    lifecycle: value.lifecycle,
  };
  assertSchemaValue(operation.outputSchema, output, "Provider operation output");
  if (output.requestId !== requestId) throw new Error("provider_response_identity_mismatch");
  const serialized = JSON.stringify(output);
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(secret)));
  if (
    [
      secret,
      encodeURIComponent(secret),
      encoded,
      encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    ].some((value) => value.length > 0 && serialized.includes(value))
  )
    throw new Error("provider_response_secret_rejected");
  return output as {
    requestId: string;
    resourceId: string;
    lifecycle: "pending" | "active" | "rejected";
  };
};
