import {
  loadAccessTokenConfig,
  parseAuthoritativeBearer,
  verifyWorkbenchAccessToken,
} from "../../../lib/workbench/access-token";
import {
  WorkbenchAuthError,
  type WorkbenchAgentIdentity,
} from "../../../lib/workbench/agent-identity-types";
import { sha256Hex } from "../../../lib/workbench/control-plane-signing";
import type { ControlPlaneAuthContext } from "./http";
import type { Env } from "./types";

export const authenticatePublicApi = async (
  request: Request,
  env: Env,
): Promise<{
  principal: WorkbenchAgentIdentity;
  context: ControlPlaneAuthContext;
}> => {
  if (env.WORKBENCH_PUBLIC_API_ENABLED !== "true")
    throw new WorkbenchAuthError("Public API is not enabled", 404);
  const token = parseAuthoritativeBearer(request.headers.get("authorization"));
  if (!token) throw new WorkbenchAuthError("Bearer authorization is required", 401);
  if (env.WORKBENCH_LOCAL_API_ENABLED === "true") {
    const hostname = new URL(request.url).hostname;
    if (
      env.WORKBENCH_ENVIRONMENT !== "local" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(hostname)
    ) {
      throw new WorkbenchAuthError(
        "Local API authentication requires a loopback local environment",
        503,
      );
    }
    const expected = env.CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN;
    if (!expected || (await sha256Hex(token)) !== (await sha256Hex(expected)))
      throw new WorkbenchAuthError("Invalid local access token", 401);
    const userId = env.WORKBENCH_LOCAL_API_USER_ID?.trim() || "operloom-local";
    const accountId = `local-api:${userId}`;
    return {
      context: { mode: "local_api" },
      principal: {
        scope: { userId, workspaceId: `workspace:${accountId}:default` },
        accountId,
        accountSource: "local-dev",
        workspaceSource: "local-dev",
        authMode: "local-dev",
        membershipRole: "owner",
        membershipRoles: ["owner"],
        verifiedAuthenticationTime: Date.now(),
      },
    };
  }
  const config = loadAccessTokenConfig({
    NODE_ENV: "production",
    WORKBENCH_PUBLIC_API_ENABLED: env.WORKBENCH_PUBLIC_API_ENABLED,
    WORKBENCH_WORKOS_ISSUER: env.WORKBENCH_WORKOS_ISSUER,
    WORKBENCH_WORKOS_JWKS_URL: env.WORKBENCH_WORKOS_JWKS_URL,
    WORKBENCH_WORKOS_ALLOWED_CLIENT_IDS: env.WORKBENCH_WORKOS_ALLOWED_CLIENT_IDS,
  });
  return {
    principal: await verifyWorkbenchAccessToken(token, config),
    context: { mode: "access_token" },
  };
};

/** No identity, signing, timing, cookie or internal capability header crosses this boundary. */
export const publicApiCommandRequest = (
  request: Request,
  input: {
    principal: WorkbenchAgentIdentity;
    path: string;
    target?: { workspaceId: string; agentId: string };
  },
) => {
  const headers = new Headers();
  for (const name of ["accept", "content-type", "idempotency-key", "last-event-id"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const { principal } = input;
  headers.set("x-assistant-mk1-user-id", principal.scope.userId);
  headers.set("x-assistant-mk1-account-id", principal.accountId);
  headers.set("x-assistant-mk1-account-source", principal.accountSource);
  if (input.target) {
    headers.set("x-assistant-mk1-workspace-id", input.target.workspaceId);
    headers.set("x-assistant-mk1-agent-id", input.target.agentId);
  }
  if (principal.membershipRole)
    headers.set("x-assistant-mk1-membership-role", principal.membershipRole);
  if (principal.membershipRoles)
    headers.set("x-assistant-mk1-membership-roles", JSON.stringify(principal.membershipRoles));
  if (principal.membershipPermissions)
    headers.set(
      "x-assistant-mk1-membership-permissions",
      JSON.stringify(principal.membershipPermissions),
    );
  const url = new URL(request.url);
  url.pathname = input.path;
  return new Request(url, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    signal: request.signal,
    // Node's Fetch implementation requires duplex for streamed request bodies.
    ...(!["GET", "HEAD"].includes(request.method) ? { duplex: "half" } : {}),
  });
};
