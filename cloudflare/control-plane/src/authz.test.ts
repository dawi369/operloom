import { describe, expect, it } from "vitest";

import {
  createDefaultAgentIfMissing,
  defaultAgentId,
  defaultWorkspaceId,
  resolveAgentIdentity,
} from "./authz";
import type { D1PreparedStatement, Env } from "./types";

const timestamp = "2026-08-02T00:00:00.000Z";
const userId = "user-1";
const accountId = "org-1";
const workspaceId = defaultWorkspaceId(accountId);
const agentId = defaultAgentId(workspaceId);

const makeRequest = () =>
  new Request("https://control.test/workbench/data-exports/export-1", {
    headers: {
      "x-assistant-mk1-user-id": userId,
      "x-assistant-mk1-account-id": accountId,
      "x-assistant-mk1-account-source": "workos_organization",
    },
  });

const makeEnv = (
  input: { omitWorkspacePreference?: boolean; omitAgentPreference?: boolean } = {},
) => {
  const queries: string[] = [];
  let writeCount = 0;
  const env = {
    DB: {
      prepare(query: string): D1PreparedStatement {
        queries.push(query);
        const statement: D1PreparedStatement = {
          bind() {
            return statement;
          },
          async first<T>() {
            if (query.includes("FROM active_workspace_preferences")) {
              return (
                input.omitWorkspacePreference
                  ? null
                  : {
                      user_id: userId,
                      account_id: accountId,
                      workspace_id: workspaceId,
                      data_json: "{}",
                      created_at: timestamp,
                      updated_at: timestamp,
                    }
              ) as T | null;
            }
            if (query.includes("FROM active_agent_preferences")) {
              return (
                input.omitAgentPreference
                  ? null
                  : {
                      user_id: userId,
                      workspace_id: workspaceId,
                      agent_id: agentId,
                      data_json: "{}",
                      created_at: timestamp,
                      updated_at: timestamp,
                    }
              ) as T | null;
            }
            if (query.includes("FROM users")) {
              return { id: userId, status: "active" } as T;
            }
            if (query.includes("FROM memberships")) {
              return { id: "membership-1", status: "active", role: "owner" } as T;
            }
            if (query.includes("FROM agents")) {
              return { id: agentId, workspace_id: workspaceId, status: "active" } as T;
            }
            if (query.includes("FROM workspaces")) {
              return {
                id: workspaceId,
                account_id: accountId,
                account_source: "workos_organization",
                status: "active",
                is_default: 1,
              } as T;
            }
            return null;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async run() {
            writeCount += 1;
            return { success: true };
          },
        };
        return statement;
      },
      async batch() {
        writeCount += 1;
        return [];
      },
    },
  } as unknown as Env;
  return { env, queries, getWriteCount: () => writeCount };
};

describe("hosted identity resolution", () => {
  it("resolves an existing identity without writes for export observation", async () => {
    const { env, getWriteCount } = makeEnv();

    const result = await resolveAgentIdentity(
      makeRequest(),
      env,
      { mode: "facade_signature" },
      { skipBootstrapWrites: true },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toMatchObject({
        scope: { userId, workspaceId },
        agentId,
        accountId,
      });
    }
    expect(getWriteCount()).toBe(0);
  });

  it("fails closed instead of creating a missing preference in read-only mode", async () => {
    const { env, getWriteCount } = makeEnv({ omitAgentPreference: true });

    const result = await resolveAgentIdentity(
      makeRequest(),
      env,
      { mode: "facade_signature" },
      { skipBootstrapWrites: true },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(getWriteCount()).toBe(0);
  });
});

describe("default agent bootstrap", () => {
  it("uses an idempotent insert when concurrent requests observe no default agent", async () => {
    const queries: string[] = [];
    const env = {
      DB: {
        prepare(query: string): D1PreparedStatement {
          queries.push(query);
          const statement: D1PreparedStatement = {
            bind() {
              return statement;
            },
            async first<T>() {
              return null as T | null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              if (query.includes("INSERT INTO agents")) {
                throw new Error("non-idempotent default-agent insert");
              }
              return { success: true };
            },
          };
          return statement;
        },
      },
    } as unknown as Env;

    await Promise.all([
      createDefaultAgentIfMissing(env, { workspaceId, userId }),
      createDefaultAgentIfMissing(env, { workspaceId, userId }),
    ]);

    expect(queries.filter((query) => query.includes("INSERT OR IGNORE INTO agents"))).toHaveLength(
      2,
    );
  });
});

describe("Operloom bootstrap compatibility", () => {
  const legacyData = { bootstrap: "workos", profile: "default", runtime: { model: "custom" } };
  const runBootstrap = async (name: string, data: Record<string, unknown> | null) => {
    const writes: { query: string; values: unknown[] }[] = [];
    const existing = data === null ? null : { id: agentId, name, data_json: JSON.stringify(data) };
    const env = {
      DB: {
        prepare(query: string) {
          let values: unknown[] = [];
          const statement = {
            bind(...args: unknown[]) {
              values = args;
              return statement;
            },
            async first() {
              return existing;
            },
            async run() {
              writes.push({ query, values });
              return { success: true };
            },
          };
          return statement;
        },
      },
    } as unknown as Env;
    await createDefaultAgentIfMissing(env, { workspaceId, userId });
    return writes;
  };

  it("creates Operloom with a versioned behavior snapshot", async () => {
    const [write] = await runBootstrap("", null);
    expect(write.values[2]).toBe("Operloom");
    expect(JSON.parse(write.values[5] as string).behavior.templateId).toBe("pack-operloom");
  });

  it("upgrades an untouched legacy default with a compare-and-swap and preserves runtime", async () => {
    const [write] = await runBootstrap("Default Agent", legacyData);
    expect(write.query).toContain("AND name = ? AND data_json = ?");
    expect(write.values[0]).toBe("Operloom");
    expect(JSON.parse(write.values[2] as string)).toMatchObject({
      runtime: { model: "custom" },
      behavior: { templateId: "pack-operloom" },
    });
  });

  it("preserves renamed, manually created, and snapshotted agents", async () => {
    expect(await runBootstrap("My assistant", legacyData)).toEqual([]);
    expect(await runBootstrap("Default Agent", { profile: "default" })).toEqual([]);
    expect(
      await runBootstrap("Default Agent", {
        ...legacyData,
        behavior: { prompt: "Custom instructions" },
      }),
    ).toEqual([]);
  });
});
