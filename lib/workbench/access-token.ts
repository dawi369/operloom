import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";

import { WorkbenchAuthError, type WorkbenchAgentIdentity } from "./agent-identity-types";

type AccessTokenClaims = JWTPayload & {
  client_id?: unknown;
  org_id?: unknown;
  role?: unknown;
  roles?: unknown;
  permissions?: unknown;
  email?: unknown;
  name?: unknown;
};

export type AccessTokenConfig = {
  enabled: boolean;
  issuer: string;
  jwksUrl: string;
  allowedClientIds: ReadonlySet<string>;
  production: boolean;
};

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

const commaSeparatedSet = (value: string | undefined) =>
  new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

const requiredUrl = (value: string | undefined, name: string) => {
  const normalized = value?.trim();
  if (!normalized) throw new WorkbenchAuthError(`${name} is not configured`, 500);
  try {
    return new URL(normalized);
  } catch {
    throw new WorkbenchAuthError(`${name} is invalid`, 500);
  }
};

export const loadAccessTokenConfig = (
  source: Readonly<Record<string, string | undefined>>,
  enabled = true,
): AccessTokenConfig => {
  const production = source.NODE_ENV === "production" || source.VERCEL_ENV === "production";
  if (!enabled) {
    return {
      enabled: false,
      issuer: "https://disabled.invalid",
      jwksUrl: "https://disabled.invalid/jwks",
      allowedClientIds: new Set(),
      production,
    };
  }
  const issuer = requiredUrl(source.WORKBENCH_WORKOS_ISSUER, "WORKBENCH_WORKOS_ISSUER");
  const jwksUrl = requiredUrl(source.WORKBENCH_WORKOS_JWKS_URL, "WORKBENCH_WORKOS_JWKS_URL");
  if (production && (issuer.protocol !== "https:" || jwksUrl.protocol !== "https:")) {
    throw new WorkbenchAuthError("Production WorkOS token verification requires HTTPS", 500);
  }
  const allowedClientIds = commaSeparatedSet(source.WORKBENCH_WORKOS_ALLOWED_CLIENT_IDS);
  if (!allowedClientIds.size) {
    throw new WorkbenchAuthError("WORKBENCH_WORKOS_ALLOWED_CLIENT_IDS is not configured", 500);
  }
  return {
    enabled,
    issuer: source.WORKBENCH_WORKOS_ISSUER!.trim(),
    jwksUrl: jwksUrl.toString(),
    allowedClientIds,
    production,
  };
};

const claimStrings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const tokenAudiences = (claims: AccessTokenClaims) => {
  const values = new Set<string>();
  if (typeof claims.aud === "string") values.add(claims.aud);
  if (Array.isArray(claims.aud)) {
    for (const audience of claims.aud) values.add(audience);
  }
  return values;
};

export const verifyWorkbenchAccessToken = async (
  token: string,
  config: AccessTokenConfig,
  keyOverride?: KeyLike | Uint8Array | JWTVerifyGetKey,
): Promise<WorkbenchAgentIdentity> => {
  if (!config.enabled) throw new WorkbenchAuthError("Bearer clients are not enabled", 401);
  const remoteKey =
    remoteKeySets.get(config.jwksUrl) ?? createRemoteJWKSet(new URL(config.jwksUrl));
  if (!remoteKeySets.has(config.jwksUrl)) remoteKeySets.set(config.jwksUrl, remoteKey);

  try {
    const verificationOptions = {
      issuer: config.issuer,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "iss", "iat", "exp"] as string[],
      clockTolerance: 5,
    };
    const { payload } =
      keyOverride && typeof keyOverride !== "function"
        ? await jwtVerify(token, keyOverride, verificationOptions)
        : await jwtVerify(token, keyOverride ?? remoteKey, verificationOptions);
    const claims = payload as AccessTokenClaims;
    const allowedClient =
      typeof claims.client_id === "string"
        ? config.allowedClientIds.has(claims.client_id)
        : [...tokenAudiences(claims)].some((audience) => config.allowedClientIds.has(audience));
    if (!allowedClient) {
      throw new WorkbenchAuthError("Client is not allowed", 401);
    }
    if (typeof claims.sub !== "string" || !claims.sub.trim()) {
      throw new WorkbenchAuthError("Token subject is invalid", 401);
    }
    const organizationId =
      typeof claims.org_id === "string" && claims.org_id ? claims.org_id : undefined;
    const accountId = organizationId
      ? `workos-org:${organizationId}`
      : `workos-personal:${claims.sub}`;
    const accountSource = organizationId ? "workos-organization" : "workos-personal";
    const role = typeof claims.role === "string" ? claims.role : undefined;
    const roles = claimStrings(claims.roles);
    const permissions = claimStrings(claims.permissions);
    return {
      scope: {
        userId: claims.sub,
        workspaceId: `workspace:${accountId}:default`,
      },
      authMode: "workos",
      accountId,
      accountSource,
      workspaceSource: accountSource,
      organizationId,
      sessionId: typeof claims.sid === "string" ? claims.sid : undefined,
      ...(typeof claims.auth_time === "number" &&
      Number.isFinite(claims.auth_time) &&
      claims.auth_time > 0 &&
      claims.auth_time <= Date.now() / 1000 + 5
        ? { verifiedAuthenticationTime: claims.auth_time * 1000 }
        : {}),
      userEmail: typeof claims.email === "string" ? claims.email : undefined,
      userName: typeof claims.name === "string" ? claims.name : undefined,
      membershipRole: role ?? (organizationId ? undefined : "owner"),
      membershipRoles: roles.length ? roles : organizationId ? undefined : ["owner"],
      membershipPermissions: permissions.length ? permissions : undefined,
    };
  } catch (error) {
    if (error instanceof WorkbenchAuthError) throw error;
    throw new WorkbenchAuthError("Invalid or expired access token", 401);
  }
};

export const parseAuthoritativeBearer = (authorization: string | null) => {
  if (authorization === null) return null;
  const match = /^Bearer[ \t]+([^ \t]+)$/i.exec(authorization);
  if (!match) throw new WorkbenchAuthError("Invalid bearer authorization", 401);
  return match[1]!;
};
