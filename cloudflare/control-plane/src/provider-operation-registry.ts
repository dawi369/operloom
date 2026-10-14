import {
  assertSchemaValue,
  type RuntimeProviderOperation,
  type RuntimeToolBinding,
} from "@operloom/agent-sdk/control-plane";
import { requireConnectionProvider } from "./connection-providers";
import type { EffectTarget, Env } from "./types";

export type ProviderOperations = readonly RuntimeProviderOperation[];

const outputFields = (operation: RuntimeProviderOperation) => {
  const properties = operation.outputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties))
    throw new Error("provider_operation_output_schema_invalid");
  return Object.keys(properties as Record<string, unknown>);
};

/** Binding and declaration validation only; simulated operations need no provider configuration. */
export const providerOperationReference = (
  binding: RuntimeToolBinding,
  operations: ProviderOperations,
) => {
  const action = binding.action;
  const reference = action?.providerOperation;
  if (!action || !reference) return null;
  if (
    binding.transport !== "cloudflare_inline" ||
    !action.connectionId ||
    action.execute ||
    action.reconcile ||
    !binding.policy.requiresApproval
  )
    throw new Error("provider_operation_binding_invalid");
  const operation = operations.find(
    (item) => item.id === reference.id && item.version === reference.version,
  );
  if (!operation) throw new Error("provider_operation_unavailable");
  const fields = outputFields(operation);
  if (
    !fields.includes(operation.receipt.requestIdField) ||
    !fields.includes(operation.receipt.statusField) ||
    (operation.receipt.referenceField && !fields.includes(operation.receipt.referenceField))
  )
    throw new Error("provider_operation_receipt_invalid");
  return {
    ...operation,
    credentialClass: "api_key" as const,
    timeoutMs: Math.min(operation.timeoutMs, action.timeoutMs),
  };
};
export type ProviderOperationReference = NonNullable<ReturnType<typeof providerOperationReference>>;

export const providerOperationDescriptor = (
  env: Env,
  binding: RuntimeToolBinding,
  operations: ProviderOperations,
  providerId?: string,
) => {
  const operation = providerOperationReference(binding, operations);
  if (!operation) return null;
  if (providerId !== undefined && providerId !== operation.providerId)
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
    !url.pathname.endsWith(operation.path)
  )
    throw new Error("provider_operation_endpoint_invalid");
  return { ...operation, url: url.toString() };
};
export type ProviderOperationDescriptor = NonNullable<
  ReturnType<typeof providerOperationDescriptor>
>;

export const providerOperationFor = (
  env: Env,
  binding: RuntimeToolBinding,
  operations: ProviderOperations,
  target: EffectTarget,
  providerId?: string,
) =>
  target === "simulation"
    ? providerOperationReference(binding, operations)
    : providerOperationDescriptor(env, binding, operations, providerId);

/** Reads the declared receipt fields from a projected output. */
export const providerOperationOutcome = (
  operation: ProviderOperationReference,
  output: Record<string, unknown>,
) => {
  const status = output[operation.receipt.statusField];
  const reference = operation.receipt.referenceField
    ? output[operation.receipt.referenceField]
    : undefined;
  return {
    rejected: typeof status === "string" && operation.receipt.rejectedValues.includes(status),
    externalReference: typeof reference === "string" ? reference : undefined,
  };
};

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
  const output: Record<string, unknown> = {};
  for (const field of outputFields(operation)) if (field in value) output[field] = value[field];
  assertSchemaValue(operation.outputSchema, output, "Provider operation output");
  if (output[operation.receipt.requestIdField] !== requestId)
    throw new Error("provider_response_identity_mismatch");
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
  return output;
};
