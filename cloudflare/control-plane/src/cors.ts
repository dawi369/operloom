import type { Env } from "./types";

const defaultLocalOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];

const parseOrigins = (value?: string) =>
  (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const allowedOrigins = (env: Env) => {
  const configured = parseOrigins(env.ALLOWED_ORIGINS);
  return new Set([...configured, ...parseOrigins(env.OPENROUTER_SITE_URL), ...defaultLocalOrigins]);
};

export const corsHeadersForRequest = (request: Request, env: Env): Record<string, string> => {
  const origin = request.headers.get("origin")?.trim();
  if (!origin) return {};

  const allowed = allowedOrigins(env);
  const allowOrigin = allowed.has("*") ? "*" : allowed.has(origin) ? origin : null;
  if (!allowOrigin) return {};

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, content-type, x-agent-name, idempotency-key, last-event-id, x-operloom-client-platform, x-operloom-client-version",
    "Access-Control-Expose-Headers":
      "x-request-id, retry-after, x-content-sha256, content-disposition",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
};

export const withCors = (response: Response, request: Request, env: Env) => {
  const headers = corsHeadersForRequest(request, env);
  try {
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  } catch {
    // WebSocket upgrade responses use status 101, which cannot be reconstructed
    // with `new Response()`. Return the original response rather than breaking
    // the Agent connection path.
    if (response.status < 200 || response.status > 599) return response;

    const clonedHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers)) clonedHeaders.set(key, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: clonedHeaders,
    });
  }
};
