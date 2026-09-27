import type { APIRequestContext } from "@playwright/test";

export const workerOrigin = "http://127.0.0.1:8788";

/** The e2e Worker's default local API principal (`OPERLOOM_LOCAL_API_USER_ID`). */
export const e2eOwner = "e2e-owner";
export const localWorkspaceId = (userId: string) => `workspace:local-api:${userId}:default`;
export const localAgentId = (userId: string) => `agent-${localWorkspaceId(userId)}`;

type RequestOptions = NonNullable<Parameters<APIRequestContext["fetch"]>[1]>;

/**
 * Calls the Worker `/v1` API as one local API principal. Principals share the local token;
 * `x-operloom-local-user` selects which one. Paths are internal operation paths such as
 * `/workbench/actions`, scoped to the principal's default workspace agent unless overridden.
 */
export const workerApi = (
  request: APIRequestContext,
  {
    userId = e2eOwner,
    workspaceId = localWorkspaceId(userId),
    agentId = localAgentId(userId),
  }: { userId?: string; workspaceId?: string; agentId?: string } = {},
) => {
  const headers = {
    authorization: "Bearer e2e-control-plane-token",
    "x-operloom-local-user": userId,
  };
  const scope = `${workerOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`;
  const call =
    (method: string) =>
    (path: string, options: RequestOptions = {}) =>
      request.fetch(`${scope}${path}`, {
        ...options,
        method,
        headers: { ...headers, ...options.headers },
      });
  return {
    userId,
    workspaceId,
    agentId,
    /** Bootstraps the principal's user, default workspace, membership, and agent. */
    account: () => request.get(`${workerOrigin}/v1/account`, { headers }),
    get: call("GET"),
    post: call("POST"),
    patch: call("PATCH"),
    put: call("PUT"),
    delete: call("DELETE"),
  };
};
