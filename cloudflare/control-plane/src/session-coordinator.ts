import type { AgentIdentity, Env } from "./types";
import type { WorkbenchSessionEvent } from "./session-event-types";

const encoder = new TextEncoder();
export const sessionCoordinatorProtocolVersion = 2;

const sha256Hex = async (value: string) => {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const sessionCoordinatorName = async (identity: AgentIdentity) =>
  `session-v${sessionCoordinatorProtocolVersion}-${(
    await sha256Hex(`${identity.scope.userId}:${identity.scope.workspaceId}`)
  ).slice(0, 48)}`;

export const sessionCoordinatorStub = async (env: Env, identity: AgentIdentity) => {
  if (!env.SessionAgent) return null;
  const name = await sessionCoordinatorName(identity);
  return env.SessionAgent.get(env.SessionAgent.idFromName(name));
};

export const dispatchWorkbenchSessionEvent = async (
  env: Env,
  identity: AgentIdentity,
  event: Omit<WorkbenchSessionEvent, "id" | "createdAt"> & {
    id?: string;
    createdAt?: string;
  },
) => {
  const stub = await sessionCoordinatorStub(env, identity);
  if (!stub) return;
  await stub.fetch("https://session-agent.internal/session", {
    method: "POST",
    body: JSON.stringify({
      action: "broadcast",
      identity,
      event,
    }),
  });
};
