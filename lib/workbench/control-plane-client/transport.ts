import { getWorkbenchSession, type WorkbenchSession } from "@/lib/workbench/agent-identity";

export class ControlPlaneRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ControlPlaneRequestError";
  }
}

const requestTimeoutMs = 10_000;

const forwardedHeaderNames = ["content-type", "accept", "idempotency-key", "last-event-id"];

const controlPlaneBaseUrl = () => {
  const baseUrl = process.env.OPERLOOM_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!baseUrl) throw new Error("OPERLOOM_BACKEND_URL is required");
  return baseUrl;
};

const splitPath = (path: string) => {
  const queryIndex = path.indexOf("?");
  return queryIndex < 0 ? [path, ""] : [path.slice(0, queryIndex), path.slice(queryIndex)];
};

export const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs = requestTimeoutMs,
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ControlPlaneRequestError(
        `Cloudflare control-plane request timed out after ${timeoutMs}ms`,
        504,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const send = (
  session: WorkbenchSession,
  url: string,
  init: RequestInit,
  timeoutMs: number | null,
) => {
  const source = new Headers(init.headers);
  const headers = new Headers({
    authorization: `Bearer ${session.accessToken}`,
    "content-type": "application/json",
  });
  for (const name of forwardedHeaderNames) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  const request: RequestInit = { method: init.method ?? "GET", headers, body: init.body };
  return timeoutMs === null ? fetch(url, request) : fetchWithTimeout(url, request, timeoutMs);
};

/**
 * Calls the Worker `/v1` API as the signed-in user. `/workspace-context` maps to `/v1/account`;
 * every other internal path runs under `/v1/me`, which the Worker scopes to the caller's active
 * workspace agent within the same request.
 */
export const controlPlaneRequest = async (
  path: string,
  init: RequestInit = {},
  timeoutMs: number | null = requestTimeoutMs,
): Promise<Response> => {
  const baseUrl = controlPlaneBaseUrl();
  const session = await getWorkbenchSession();
  const [pathname, query] = splitPath(path);
  const url =
    pathname === "/workspace-context" ? `${baseUrl}/v1/account${query}` : `${baseUrl}/v1/me${path}`;
  return send(session, url, init, timeoutMs);
};

export const parseErrorBody = async (response: Response) => {
  const body = await response.text();
  if (!body) return response.statusText;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; run?: unknown };
    if (parsed.run) return body;
    return typeof parsed.error === "string" ? parsed.error : body;
  } catch {
    return body;
  }
};

export const requestControlPlaneResponse = async (
  path: string,
  init?: RequestInit,
  timeoutMs?: number | null,
) => {
  const response = await controlPlaneRequest(path, init, timeoutMs);
  if (!response.ok) {
    throw new ControlPlaneRequestError(await parseErrorBody(response), response.status);
  }
  return response;
};

export const requestControlPlane = async <T>(
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<T> => (await (await requestControlPlaneResponse(path, init, timeoutMs)).json()) as T;
