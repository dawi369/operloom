import { describe, expect, it, vi } from "vitest";

import { abortThreadChatResponse, persistThreadMutation } from "./session-agent-transitions";
import type { AgentIdentity, ChatThreadRow, D1PreparedStatement, D1Result, Env } from "./types";

const identity = {
  scope: { userId: "user-1", workspaceId: "workspace-1" },
  agentId: "agent-1",
} satisfies AgentIdentity;

const thread = {
  thread_id: "thread-1",
  session_id: "session-1",
  user_id: identity.scope.userId,
  workspace_id: identity.scope.workspaceId,
  agent_id: identity.agentId,
  status: "active",
  upstream_json: JSON.stringify({ instanceName: "thread-agent-1", title: "Original" }),
  created_at: "2026-08-04T00:00:00.000Z",
  updated_at: "2026-08-04T00:00:00.000Z",
  last_seen_at: "2026-08-04T00:00:00.000Z",
} satisfies ChatThreadRow;

const makeEnv = () => {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const prepare = (query: string): D1PreparedStatement => {
    const statement = { query, values: [] as unknown[] };
    return {
      bind(...values: unknown[]) {
        statement.values = values;
        return this;
      },
      async first<T>() {
        return null as T | null;
      },
      async all<T>() {
        return { results: [] as T[] };
      },
      async run() {
        statements.push(statement);
        return { success: true, meta: { changes: 1 } } satisfies D1Result;
      },
    };
  };
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const env = {
    DB: {
      prepare,
      async batch(batchStatements: D1PreparedStatement[]) {
        return Promise.all(batchStatements.map((statement) => statement.run())) as Promise<
          D1Result[]
        >;
      },
    },
    OPERLOOM_AGENT_CONNECTION_SECRET: "test-agent-secret-that-is-long-enough",
    ThreadChatAgent: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch })),
    },
  } satisfies Partial<Env>;
  return { env: env as Env, fetch, statements };
};

describe("session thread lifecycle transitions", () => {
  it.each(["archived", "deleted"] as const)(
    "atomically cancels an active response when the thread becomes %s",
    async (status) => {
      const { env, statements } = makeEnv();
      const result = await persistThreadMutation(env, identity, thread, { status });

      expect(result.cancelledRunningRuns).toBe(1);
      expect(statements).toHaveLength(3);
      expect(statements[0]?.query).toContain("UPDATE chat_intents");
      expect(statements[1]?.query).toContain("UPDATE chat_runs");
      expect(statements[1]?.query).toContain("status = 'cancelled'");
      expect(statements[1]?.query).toContain("status = 'running'");
      expect(statements[1]?.values).toContain(`thread_${status}`);
      expect(statements[2]?.query).toContain("UPDATE chat_threads");
      expect(statements[2]?.values[0]).toBe(status);
    },
  );

  it("best-effort aborts the active Durable Object turn without exposing a user token", async () => {
    const { env, fetch } = makeEnv();

    await expect(abortThreadChatResponse(env, thread)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://thread-agent.internal/internal/thread-cancel",
      expect.objectContaining({
        method: "POST",
        headers: { "x-operloom-agent-secret": "test-agent-secret-that-is-long-enough" },
      }),
    );
  });
});
