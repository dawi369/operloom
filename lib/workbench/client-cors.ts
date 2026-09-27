const allowedRequestHeaders = [
  "authorization",
  "content-type",
  "idempotency-key",
  "last-event-id",
  "x-operloom-client-platform",
  "x-operloom-client-version",
].join(", ");

const allowedMethods = "DELETE, GET, OPTIONS, PATCH, POST";

export const parseWorkbenchClientOrigins = (value: string | undefined) =>
  new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => {
        try {
          return new URL(entry).origin === entry && entry !== "null";
        } catch {
          return false;
        }
      }),
  );

export const applyWorkbenchClientCors = (
  headers: Headers,
  input: { origin: string | null; configuredOrigins: string | undefined; preflight?: boolean },
) => {
  const origins = parseWorkbenchClientOrigins(input.configuredOrigins);
  if (!input.origin || !origins.has(input.origin)) return false;
  headers.set("access-control-allow-origin", input.origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-expose-headers", "x-request-id");
  headers.append("vary", "Origin");
  if (input.preflight) {
    headers.set("access-control-allow-headers", allowedRequestHeaders);
    headers.set("access-control-allow-methods", allowedMethods);
    headers.set("access-control-max-age", "600");
  }
  return true;
};
