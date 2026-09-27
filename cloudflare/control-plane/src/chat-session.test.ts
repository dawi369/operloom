import { describe, expect, it } from "vitest";

import {
  handleChatSessionStream,
  handleMaterializeChatSessionTurn,
  handleSwitchChatSessionAgent,
} from "./chat-session";
import type { AgentIdentity, Env } from "./types";

const identity = {
  agentId: "agent-a",
  scope: {
    userId: "user-a",
    workspaceId: "workspace-a",
  },
  accountId: "account-a",
  accountSource: "test",
} satisfies AgentIdentity;

const createEnv = () => {
  const requests: unknown[] = [];
  const env = {
    SessionAgent: {
      idFromName(name: string) {
        return name;
      },
      get() {
        return {
          async fetch(_input: RequestInfo | URL, init?: RequestInit) {
            requests.push(JSON.parse(String(init?.body ?? "{}")) as unknown);
            return Response.json({
              ok: true,
              transition: { type: "agent_handoff" },
              activeAgent: { id: "agent-b" },
            });
          },
        };
      },
    },
  } as unknown as Env;

  return { env, requests };
};

describe("chat session switch agent handler", () => {
  it("rejects missing agent ids before contacting the session coordinator", async () => {
    const { env, requests } = createEnv();
    const response = await handleSwitchChatSessionAgent(
      new Request("https://control.test/chat/session/agent-switch", {
        method: "POST",
        body: JSON.stringify({ target: "current_thread" }),
      }),
      env,
      identity,
    );

    await expect(response.json()).resolves.toEqual({ ok: false, error: "agentId is required" });
    expect(response.status).toBe(400);
    expect(requests).toEqual([]);
  });

  it("forwards current-thread agent switches to the session coordinator", async () => {
    const { env, requests } = createEnv();
    const response = await handleSwitchChatSessionAgent(
      new Request("https://control.test/chat/session/agent-switch", {
        method: "POST",
        body: JSON.stringify({
          agentId: "agent-b",
          target: "current_thread",
          threadId: "thread-a",
        }),
      }),
      env,
      identity,
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      transition: { type: "agent_handoff" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      action: "switchAgent",
      threadId: "thread-a",
      agentSwitch: { agentId: "agent-b", target: "current_thread" },
      agentHost: "https://control.test",
    });
  });

  it("forwards new-thread agent switches to the session coordinator", async () => {
    const { env, requests } = createEnv();

    await handleSwitchChatSessionAgent(
      new Request("https://control.test/chat/session/agent-switch", {
        method: "POST",
        body: JSON.stringify({
          agentId: "agent-b",
          target: "new_thread",
        }),
      }),
      env,
      identity,
    );

    expect(requests[0]).toMatchObject({
      action: "switchAgent",
      agentSwitch: { agentId: "agent-b", target: "new_thread" },
    });
  });

  it("normalizes unknown switch targets to current-thread handoffs", async () => {
    const { env, requests } = createEnv();

    await handleSwitchChatSessionAgent(
      new Request("https://control.test/chat/session/agent-switch", {
        method: "POST",
        body: JSON.stringify({ agentId: "agent-b", target: "bad-target" }),
      }),
      env,
      identity,
    );

    expect(requests[0]).toMatchObject({
      action: "switchAgent",
      agentSwitch: { agentId: "agent-b", target: "current_thread" },
    });
  });
});

describe("mobile chat session protocol", () => {
  it("requires and forwards a stable client turn id", async () => {
    const { env, requests } = createEnv();
    const response = await handleMaterializeChatSessionTurn(
      new Request("https://control.test/chat/session/materialize-turn", {
        method: "POST",
        body: JSON.stringify({ clientTurnId: "turn-mobile-1", message: "hello" }),
      }),
      env,
      identity,
    );
    expect(response.status).toBe(200);
    expect(requests[0]).toMatchObject({
      action: "materializeTurn",
      clientTurnId: "turn-mobile-1",
      message: "hello",
    });
  });

  it("forwards query cursors before Last-Event-ID", async () => {
    const { env, requests } = createEnv();
    await handleChatSessionStream(
      new Request("https://control.test/chat/session/stream?after=query-cursor", {
        headers: { "Last-Event-ID": "header-cursor" },
      }),
      env,
      identity,
    );
    expect(requests[0]).toMatchObject({ action: "stream", after: "query-cursor" });
  });
});
