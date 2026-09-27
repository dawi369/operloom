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

/** Local-only test affordance: selects one of several loopback users sharing the local token. */
const localUserHeader = "x-operloom-local-user";
const localUserIdPattern = /^[a-zA-Z0-9._:-]{1,128}$/;

export const authenticatePublicApi = async (
  request: Request,
  env: Env,
): Promise<{
  principal: WorkbenchAgentIdentity;
  context: ControlPlaneAuthContext;
}> => {
  const token = parseAuthoritativeBearer(request.headers.get("authorization"));
  if (!token) throw new WorkbenchAuthError("Bearer authorization is required", 401);
  if (env.OPERLOOM_LOCAL_API_ENABLED === "true") {
    const hostname = new URL(request.url).hostname;
    if (
      env.OPERLOOM_ENVIRONMENT !== "local" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(hostname)
    ) {
      throw new WorkbenchAuthError(
        "Local API authentication requires a loopback local environment",
        503,
      );
    }
    const expected = env.OPERLOOM_LOCAL_API_TOKEN;
    if (!expected || (await sha256Hex(token)) !== (await sha256Hex(expected)))
      throw new WorkbenchAuthError("Invalid local access token", 401);
    const requestedUserId = request.headers.get(localUserHeader);
    if (requestedUserId !== null && !localUserIdPattern.test(requestedUserId))
      throw new WorkbenchAuthError("Invalid local user", 400);
    const userId = requestedUserId ?? (env.OPERLOOM_LOCAL_API_USER_ID?.trim() || "operloom-local");
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
    OPERLOOM_WORKOS_ISSUER: env.OPERLOOM_WORKOS_ISSUER,
    OPERLOOM_WORKOS_JWKS_URL: env.OPERLOOM_WORKOS_JWKS_URL,
    OPERLOOM_WORKOS_ALLOWED_CLIENT_IDS: env.OPERLOOM_WORKOS_ALLOWED_CLIENT_IDS,
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
  headers.set("x-operloom-user-id", principal.scope.userId);
  headers.set("x-operloom-account-id", principal.accountId);
  headers.set("x-operloom-account-source", principal.accountSource);
  if (input.target) {
    headers.set("x-operloom-workspace-id", input.target.workspaceId);
    headers.set("x-operloom-agent-id", input.target.agentId);
  }
  // Profile fields come only from verified token claims and seed the user bootstrap.
  if (principal.userEmail) headers.set("x-operloom-user-email", principal.userEmail);
  if (principal.userName) headers.set("x-operloom-user-name", principal.userName);
  if (principal.membershipRole) headers.set("x-operloom-membership-role", principal.membershipRole);
  if (principal.membershipRoles)
    headers.set("x-operloom-membership-roles", JSON.stringify(principal.membershipRoles));
  if (principal.membershipPermissions)
    headers.set(
      "x-operloom-membership-permissions",
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
