import { NextResponse } from "next/server";

const maxLoggedMessageLength = 500;

const getErrorStatus = (error: unknown, defaultStatus: number) =>
  error instanceof Error && "status" in error && typeof error.status === "number"
    ? error.status
    : defaultStatus;

const publicMessage = (error: unknown, fallback: string, status: number) => {
  if (status >= 500) return fallback;
  return error instanceof Error ? error.message : fallback;
};

const stringField = (value: unknown) => (typeof value === "string" && value ? value : undefined);

const booleanField = (value: unknown) => (typeof value === "boolean" ? value : undefined);

const compactMessage = (value: string) =>
  value.length > maxLoggedMessageLength ? `${value.slice(0, maxLoggedMessageLength)}...` : value;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parseJsonRecord = (value: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
};

const compactControlPlaneError = (message: string) => {
  const parsed = parseJsonRecord(message);
  if (!parsed) return { message: compactMessage(message) };

  const details = asRecord(parsed.details);
  const error = asRecord(parsed.error);
  const run = asRecord(parsed.run);
  const toolCall = asRecord(parsed.toolCall);
  const toolCallData = asRecord(toolCall?.data);

  return {
    code: stringField(error?.code) ?? stringField(details?.code),
    message:
      stringField(error?.message) ??
      stringField(details?.message) ??
      stringField(parsed.error) ??
      compactMessage(message),
    runId: stringField(run?.id) ?? stringField(parsed.runId),
    workflowIntentId:
      stringField(run?.workflowIntentId) ??
      stringField(parsed.workflowIntentId) ??
      stringField(toolCall?.workflowIntentId),
    toolCallId: stringField(toolCall?.id) ?? stringField(parsed.toolCallId),
    toolId: stringField(toolCall?.toolId) ?? stringField(parsed.toolId),
    traceId: stringField(toolCallData?.traceId) ?? stringField(parsed.traceId),
    retryable: booleanField(error?.retryable) ?? booleanField(details?.retryable),
    redacted: booleanField(error?.redacted) ?? booleanField(details?.redacted),
  };
};

const logPayload = (error: unknown, fallback: string, status: number, errorId?: string) => {
  const base = {
    errorId,
    status,
    name: error instanceof Error ? error.name : "UnknownError",
  };
  if (error instanceof Error && error.name === "ControlPlaneRequestError") {
    return {
      ...base,
      controlPlane: compactControlPlaneError(error.message),
    };
  }
  return {
    ...base,
    error: error instanceof Error ? compactMessage(error.message) : fallback,
  };
};

export const toWorkbenchApiError = (
  error: unknown,
  fallback: string,
  options?: { defaultStatus?: number },
) => {
  const status = getErrorStatus(error, options?.defaultStatus ?? 502);
  const errorId = status >= 500 ? crypto.randomUUID() : undefined;
  const internalMessage = error instanceof Error ? error.message : fallback;
  const message = publicMessage(error, fallback, status);

  const payload = logPayload(error, internalMessage, status, errorId);
  if (status >= 500) {
    console.error(fallback, payload);
  } else {
    console.warn(fallback, payload);
  }

  const runId =
    error instanceof Error && error.name === "ControlPlaneRequestError"
      ? compactControlPlaneError(error.message).runId
      : undefined;
  return NextResponse.json(
    { error: message, ...(errorId ? { errorId } : {}), ...(runId ? { runId } : {}) },
    { status },
  );
};
