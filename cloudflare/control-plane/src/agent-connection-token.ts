import type { AgentIdentity, AgentRow, ChatThreadRow, EffectTarget } from "./types";

export type AgentConnectionClaims = {
  v: 1;
  exp: number;
  nonce: string;
  userId: string;
  accountId?: string;
  accountSource?: string;
  workspaceId: string;
  agentId: string;
  agentUpdatedAt?: string;
  agentRevision?: number;
  effectTarget?: EffectTarget;
  threadId: string;
  sessionId: string;
  instanceName: string;
  runtime: "cloudflare-agent-chat";
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base64UrlToBytes = (value: string) => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const base64UrlEncode = (input: Uint8Array | string) => {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const importSigningKey = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);

const timingSafeEqual = (left: Uint8Array, right: Uint8Array) => {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left[index] ^ right[index];
  return result === 0;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeClaims = (value: unknown): AgentConnectionClaims | null => {
  if (!isRecord(value)) return null;
  if (value.v !== 1 || value.runtime !== "cloudflare-agent-chat") return null;
  const required = [
    "exp",
    "nonce",
    "userId",
    "workspaceId",
    "agentId",
    "threadId",
    "sessionId",
    "instanceName",
  ] as const;
  for (const key of required) {
    const field = value[key];
    if (key === "exp") {
      if (typeof field !== "number") return null;
    } else if (typeof field !== "string" || !field.trim()) {
      return null;
    }
  }
  if (
    value.agentRevision !== undefined &&
    (!Number.isSafeInteger(value.agentRevision) || (value.agentRevision as number) < 0)
  )
    return null;
  if (
    value.effectTarget !== undefined &&
    value.effectTarget !== "simulation" &&
    value.effectTarget !== "external"
  )
    return null;
  return value as AgentConnectionClaims;
};

export const verifyAgentConnectionToken = async (secret: string, token: string) => {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("Invalid agent token");

  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", await importSigningKey(secret), encoder.encode(payload)),
  );
  const actual = base64UrlToBytes(signature);
  if (!timingSafeEqual(expected, actual)) throw new Error("Invalid agent token signature");

  const claims = normalizeClaims(JSON.parse(decoder.decode(base64UrlToBytes(payload))));
  if (!claims) throw new Error("Invalid agent token claims");
  if (claims.exp <= Math.floor(Date.now() / 1000)) throw new Error("Agent token expired");
  return claims;
};

export const signAgentConnectionClaims = async (secret: string, claims: AgentConnectionClaims) => {
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await importSigningKey(secret), encoder.encode(payload)),
  );
  return `${payload}.${base64UrlEncode(signature)}`;
};

export const claimsToIdentity = (claims: AgentConnectionClaims): AgentIdentity => ({
  scope: {
    userId: claims.userId,
    workspaceId: claims.workspaceId,
  },
  agentId: claims.agentId,
  agentRevision: claims.agentRevision ?? 0,
  effectTarget: claims.effectTarget ?? "simulation",
  accountId: claims.accountId,
  accountSource: claims.accountSource,
});

export const assertCurrentAgentConnectionScope = (
  claims: AgentConnectionClaims,
  thread: ChatThreadRow,
  agent: AgentRow | null,
  options: { allowedThreadStatuses?: readonly string[] } = {},
) => {
  const allowedThreadStatuses = options.allowedThreadStatuses ?? ["active"];
  if (
    thread.thread_id !== claims.threadId ||
    thread.session_id !== claims.sessionId ||
    thread.agent_id !== claims.agentId ||
    !allowedThreadStatuses.includes(thread.status)
  ) {
    throw new Error("Agent token thread scope is stale");
  }
  if (!agent || agent.status !== "active" || agent.id !== claims.agentId) {
    throw new Error("Agent token agent is inactive");
  }
  if ((claims.agentRevision ?? 0) !== (agent.runtime_revision ?? 0)) {
    throw new Error("Agent token runtime revision is stale");
  }
  if ((claims.effectTarget ?? "simulation") !== (agent.effect_target ?? "simulation")) {
    throw new Error("Agent token effect target is stale");
  }
  if (claims.agentUpdatedAt && claims.agentUpdatedAt !== agent.updated_at) {
    throw new Error("Agent token agent version is stale");
  }
};
