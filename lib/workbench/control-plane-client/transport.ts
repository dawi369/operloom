import { publicApiScopePath } from "@operloom/workbench-client";
import { cookies } from "next/headers";

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

export const targetCookieName = "operloom_target";

const forwardedHeaderNames = ["content-type", "accept", "idempotency-key", "last-event-id"];

/** Successful calls that move the Worker-owned active workspace or agent. */
const targetChangingRoutes: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", /^\/workspaces$/],
  ["POST", /^\/workspaces\/[^/]+\/activate$/],
  ["POST", /^\/agents$/],
  ["POST", /^\/agents\/[^/]+\/activate$/],
  ["POST", /^\/agent-packs\/[^/]+\/instantiate$/],
  ["POST", /^\/chat\/session\/agent-switch$/],
  ["POST", /^\/workbench\/workspace-deletion(?:\/retry)?$/],
  ["DELETE", /^\/workbench\/workspace-deletion$/],
];

type Target = { workspaceId: string; agentId: string };
type StoredTarget = Target & { principal: string };

const isTargetId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

const sameTarget = (left: Target, right: Target) =>
  left.workspaceId === right.workspaceId && left.agentId === right.agentId;

// A target cached for one user or organization is never replayed for another.
const principalKey = (session: WorkbenchSession) =>
  session.authMode === "workos"
    ? `workos:${session.userId}:${session.organizationId ?? ""}`
    : "local-dev";

const readTargetCookie = async (principal: string): Promise<Target | null> => {
  const value = (await cookies()).get(targetCookieName)?.value;
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredTarget>;
    return parsed.principal === principal &&
      isTargetId(parsed.workspaceId) &&
      isTargetId(parsed.agentId)
      ? { workspaceId: parsed.workspaceId, agentId: parsed.agentId }
      : null;
  } catch {
    return null;
  }
};

const writeTargetCookie = async (target: StoredTarget | null) => {
  try {
    const store = await cookies();
    if (!target) {
      store.delete({ name: targetCookieName, path: "/" });
      return;
    }
    store.set(targetCookieName, JSON.stringify(target), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
  } catch {
    // Server Components cannot write cookies; they re-resolve the target on each request.
  }
};

const controlPlaneBaseUrl = () => {
  const baseUrl = process.env.CLOUDFLARE_CONTROL_PLANE_URL?.trim().replace(/\/$/, "");
  if (!baseUrl) throw new Error("CLOUDFLARE_CONTROL_PLANE_URL is required");
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

const resolveTarget = async (session: WorkbenchSession, baseUrl: string): Promise<Target> => {
  const response = await send(session, `${baseUrl}/v1/account`, {}, requestTimeoutMs);
  if (!response.ok) {
    throw new ControlPlaneRequestError(await parseErrorBody(response), response.status);
  }
  const body = (await response.json()) as {
    context?: { identity?: { workspaceId?: unknown; agentId?: unknown } };
  };
  const workspaceId = body.context?.identity?.workspaceId;
  const agentId = body.context?.identity?.agentId;
  if (!isTargetId(workspaceId) || !isTargetId(agentId)) {
    throw new ControlPlaneRequestError("The account has no active workspace agent", 409);
  }
  await writeTargetCookie({ principal: principalKey(session), workspaceId, agentId });
  return { workspaceId, agentId };
};

/**
 * Calls the Worker `/v1` API as the signed-in user. `/workspace-context` maps to `/v1/account`;
 * every other internal path is scoped to the active workspace agent kept in `operloom_target`.
 */
export const controlPlaneRequest = async (
  path: string,
  init: RequestInit = {},
  timeoutMs: number | null = requestTimeoutMs,
): Promise<Response> => {
  const baseUrl = controlPlaneBaseUrl();
  const session = await getWorkbenchSession();
  const [pathname, query] = splitPath(path);
  if (pathname === "/workspace-context") {
    return send(session, `${baseUrl}/v1/account${query}`, init, timeoutMs);
  }

  const method = (init.method ?? "GET").toUpperCase();
  const stored = await readTargetCookie(principalKey(session));
  const target = stored ?? (await resolveTarget(session, baseUrl));
  const sendTargeted = (scope: Target) =>
    send(session, `${baseUrl}${publicApiScopePath(scope)}${path}`, init, timeoutMs);
  let response = await sendTargeted(target);

  if (stored && [401, 403, 404].includes(response.status)) {
    await writeTargetCookie(null);
    if (method === "GET") {
      const fresh = await resolveTarget(session, baseUrl).catch(() => null);
      if (fresh && !sameTarget(fresh, target)) {
        await response.body?.cancel();
        response = await sendTargeted(fresh);
      }
    }
  } else if (
    response.ok &&
    targetChangingRoutes.some(([verb, pattern]) => verb === method && pattern.test(pathname))
  ) {
    await writeTargetCookie(null);
  }
  return response;
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
