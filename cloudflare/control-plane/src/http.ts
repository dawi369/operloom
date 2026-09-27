import type { Env } from "./types";
import {
  canonicalFacadeRequest,
  facadeContentSha256Header,
  facadeSignatureHeader,
  facadeSignatureNonceHeader,
  facadeSignatureTimestampHeader,
  hmacSha256Base64Url,
  sha256Base64Url,
  sha256Hex,
} from "../../../lib/workbench/control-plane-signing";

export const userIdHeader = "x-assistant-mk1-user-id";
export const accountIdHeader = "x-assistant-mk1-account-id";
export const accountSourceHeader = "x-assistant-mk1-account-source";
export const workspaceIdHeader = "x-assistant-mk1-workspace-id";
export const agentIdHeader = "x-assistant-mk1-agent-id";

export const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textEncoder = new TextEncoder();

const sha256 = (value: string) => crypto.subtle.digest("SHA-256", textEncoder.encode(value));

const constantTimeEqual = async (a: string, b: string) => {
  const [leftBuffer, rightBuffer] = await Promise.all([sha256(a), sha256(b)]);
  const left = new Uint8Array(leftBuffer);
  const right = new Uint8Array(rightBuffer);
  let diff = left.length ^ right.length;

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return diff === 0;
};

export type ControlPlaneAuthContext = {
  mode: "facade_signature" | "dev_token" | "access_token" | "local_api";
  nonce?: string;
  signatureHash?: string;
};

export const internalErrorResponse = (label: string, error: unknown) => {
  const errorId = crypto.randomUUID();
  const message = error instanceof Error ? error.message : String(error);
  console.error(label, {
    errorId,
    error: message,
    name: error instanceof Error ? error.name : "UnknownError",
  });
  return json({ ok: false, error: "Internal control-plane error", errorId }, { status: 500 });
};

const requireDevTokenAuth = async (request: Request, env: Env) => {
  const token = env.CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN;
  if (!token) {
    return internalErrorResponse(
      "Control-plane authentication is not configured",
      new Error("CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN is not configured"),
    );
  }

  const authorization = request.headers.get("authorization");
  const apiKey = request.headers.get("x-api-key");
  const [bearerMatch, apiKeyMatch] = await Promise.all([
    authorization?.startsWith("Bearer ")
      ? constantTimeEqual(authorization.slice(7), token)
      : Promise.resolve(false),
    apiKey ? constantTimeEqual(apiKey, token) : Promise.resolve(false),
  ]);

  if (!bearerMatch && !apiKeyMatch) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  return null;
};

const signatureWindowMs = 5 * 60 * 1000;

const readAuthHeader = (request: Request, name: string) => request.headers.get(name)?.trim() ?? "";

const isFacadeSignatureRequired = (env: Env) =>
  Boolean(env.CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET?.trim()) &&
  env.CLOUDFLARE_CONTROL_PLANE_REQUIRE_FACADE_SIGNATURE !== "false";

const authError = (code: string, message: string, status = 401) =>
  json(
    {
      ok: false,
      error: message,
      details: { code, message, retryable: false, redacted: true },
    },
    { status },
  );

const verifyFacadeSignature = async (
  request: Request,
  env: Env,
): Promise<{ ok: true; context: ControlPlaneAuthContext } | { ok: false; response: Response }> => {
  const secret = env.CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET?.trim();
  if (!secret) {
    return {
      ok: false,
      response: authError("signature_not_configured", "Facade signing is not configured.", 500),
    };
  }

  const signature = readAuthHeader(request, facadeSignatureHeader);
  const timestamp = readAuthHeader(request, facadeSignatureTimestampHeader);
  const nonce = readAuthHeader(request, facadeSignatureNonceHeader);
  const declaredBodyHash = readAuthHeader(request, facadeContentSha256Header);
  if (!signature || !timestamp || !nonce || !declaredBodyHash) {
    return {
      ok: false,
      response: authError("signature_required", "Signed facade request is required."),
    };
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > signatureWindowMs) {
    return { ok: false, response: authError("signature_stale", "Signed facade request is stale.") };
  }

  const bodyText = await request.clone().text();
  const actualBodyHash = await sha256Base64Url(bodyText);
  if (!(await constantTimeEqual(actualBodyHash, declaredBodyHash))) {
    return {
      ok: false,
      response: authError("body_hash_mismatch", "Signed facade body hash is invalid."),
    };
  }

  const url = new URL(request.url);
  const canonical = canonicalFacadeRequest({
    method: request.method,
    pathWithQuery: `${url.pathname}${url.search}`,
    timestamp,
    nonce,
    bodyHash: declaredBodyHash,
    headers: request.headers,
  });
  const expectedSignature = await hmacSha256Base64Url(secret, canonical);
  if (!(await constantTimeEqual(expectedSignature, signature))) {
    return {
      ok: false,
      response: authError("signature_invalid", "Signed facade request is invalid."),
    };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + signatureWindowMs).toISOString();
  const signatureHash = await sha256Hex(signature);
  await env.DB.prepare(`DELETE FROM control_request_nonces WHERE expires_at <= ?`)
    .bind(now.toISOString())
    .run();
  try {
    await env.DB.prepare(
      `INSERT INTO control_request_nonces (nonce, signature_hash, source, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(nonce, signatureHash, "vercel_facade", now.toISOString(), expiresAt)
      .run();
  } catch {
    return {
      ok: false,
      response: authError("signature_replay", "Signed facade nonce was already used."),
    };
  }

  return { ok: true, context: { mode: "facade_signature", nonce, signatureHash } };
};

export const requireDevToken = async (request: Request, env: Env) =>
  requireDevTokenAuth(request, env);

export const requireControlPlaneAuth = async (
  request: Request,
  env: Env,
): Promise<{ ok: true; context: ControlPlaneAuthContext } | { ok: false; response: Response }> => {
  const hasFacadeSignature = Boolean(readAuthHeader(request, facadeSignatureHeader));
  if (hasFacadeSignature || isFacadeSignatureRequired(env)) {
    return verifyFacadeSignature(request, env);
  }

  const devTokenResponse = await requireDevTokenAuth(request, env);
  if (devTokenResponse) return { ok: false, response: devTokenResponse };
  return { ok: true, context: { mode: "dev_token" } };
};

export const readRequiredHeader = (request: Request, name: string) => {
  const value = request.headers.get(name)?.trim();
  return value ? value : null;
};

export const parseDataJson = (raw: string) => {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const parseJson = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
