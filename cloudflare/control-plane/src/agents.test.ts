import { describe, expect, it } from "vitest";

import { createAgentBehaviorSnapshot } from "./agent-behavior-templates";
import { handleActivateAgent, handleCreateAgent, handleInstantiateAgentPack } from "./agents";
import type {
  AgentIdentity,
  AgentRow,
  D1PreparedStatement,
  D1Result,
  Env,
  MembershipRow,
} from "./types";

type RecordedStatement = {
  query: string;
  values: unknown[];
};

const timestamp = "2026-06-23T00:00:00.000Z";

const identity = {
  agentId: "agent-current",
  scope: {
    userId: "user-1",
    workspaceId: "workspace-1",
  },
  accountId: "account-1",
  accountSource: "test",
} satisfies AgentIdentity;

const membershipRow = (role: string): MembershipRow => ({
  id: `membership-${role}`,
  user_id: identity.scope.userId,
  workspace_id: identity.scope.workspaceId,
  role,
  status: "active",
  roles_json: JSON.stringify([role]),
  permissions_json: JSON.stringify([]),
  data_json: "{}",
  created_at: timestamp,
  updated_at: timestamp,
});

const agentRow = (input?: { status?: string; id?: string; behavior?: unknown }): AgentRow => ({
  id: input?.id ?? "agent-swordfish",
  workspace_id: identity.scope.workspaceId,
  name: "Baby Swordfish",
  description: "Public Swordfish runtime research.",
  status: input?.status ?? "active",
  is_default: 0,
  created_by_user_id: identity.scope.userId,
  data_json: JSON.stringify({ profile: "analyst", behavior: input?.behavior }),
  created_at: timestamp,
  updated_at: timestamp,
});

const createRecordingEnv = (input: {
  role: string;
  agent?: AgentRow | null;
  agents?: AgentRow[];
  e2eMode?: boolean;
}) => {
  const statements: RecordedStatement[] = [];
  const membership = membershipRow(input.role);

  const createStatement = (query: string): D1PreparedStatement & RecordedStatement => {
    const statement = {
      query,
      values: [] as unknown[],
      bind(...values: unknown[]) {
        statement.values = values;
        return statement;
      },
      async first<T = unknown>() {
        if (query.includes("FROM memberships")) return membership as T;
        if (query.includes("FROM agents")) return (input.agent ?? null) as T | null;
        return null as T | null;
      },
      async all<T = unknown>() {
        if (query.includes("FROM agents")) return { results: (input.agents ?? []) as T[] };
        return { results: [] as T[] };
      },
      async run() {
        statements.push({ query, values: statement.values });
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  };

  const env = {
    WORKBENCH_E2E_MODE: input.e2eMode ? "true" : undefined,
    DB: {
      prepare: createStatement,
      async batch(batchStatements: Array<D1PreparedStatement & Partial<RecordedStatement>>) {
        for (const statement of batchStatements) {
          statements.push({
            query: statement.query ?? "unknown",
            values: statement.values ?? [],
          });
        }
        return batchStatements.map(() => ({ success: true })) as D1Result[];
      },
    },
  } satisfies Partial<Env>;

  return { env: env as Env, statements };
};

describe("agents", () => {
  it("keeps agent creation admin-only", async () => {
    const { env, statements } = createRecordingEnv({ role: "member", agent: agentRow() });
    const request = new Request("https://worker.test/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Baby Swordfish",
        profile: "analyst",
        behaviorTemplateId: "pack-baby-swordfish",
        activate: true,
      }),
    });

    const response = await handleCreateAgent(request, env, identity);
    const body = (await response.json()) as { ok?: boolean; error?: string };

    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Workspace admin role is required");
    expect(statements.some((statement) => statement.query.includes("INSERT INTO agents"))).toBe(
      false,
    );
  });

  it("allows active workspace members to activate existing active agents", async () => {
    const { env, statements } = createRecordingEnv({ role: "member", agent: agentRow() });

    const response = await handleActivateAgent(env, identity, "agent-swordfish");
    const body = (await response.json()) as { ok?: boolean; activeAgentId?: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.activeAgentId).toBe("agent-swordfish");
    expect(
      statements.some(
        (statement) =>
          statement.query.includes("INSERT INTO active_agent_preferences") &&
          statement.values.includes("agent-swordfish") &&
          JSON.stringify(statement.values).includes("agent-activated"),
      ),
    ).toBe(true);
  });

  it("keeps pack instantiation admin-only", async () => {
    const { env, statements } = createRecordingEnv({ role: "member" });
    const response = await handleInstantiateAgentPack(env, identity, "repo-analyst");

    expect(response.status).toBe(403);
    expect(statements.some((statement) => statement.query.includes("INSERT INTO agents"))).toBe(
      false,
    );
  });

  it("reuses an active agent on the installed pack version", async () => {
    const behavior = createAgentBehaviorSnapshot("analyst", "pack-repo-analyst");
    const existing = agentRow({ id: "agent-repo-current", behavior });
    const { env, statements } = createRecordingEnv({ role: "admin", agents: [existing] });

    const response = await handleInstantiateAgentPack(env, identity, "repo-analyst");
    const body = (await response.json()) as { created?: boolean; agent?: { id?: string } };

    expect(response.status).toBe(200);
    expect(body.created).toBe(false);
    expect(body.agent?.id).toBe("agent-repo-current");
    expect(statements.some((statement) => statement.query.includes("INSERT OR IGNORE"))).toBe(
      false,
    );
  });

  it("creates a managed current-version agent without mutating an old snapshot", async () => {
    const currentBehavior = createAgentBehaviorSnapshot("analyst", "pack-repo-analyst");
    const oldBehavior = structuredClone(currentBehavior);
    if (oldBehavior.authoring?.kind === "local_agent_pack")
      oldBehavior.authoring.packVersion = "0.9.0";
    const oldAgent = agentRow({ id: "agent-repo-old", behavior: oldBehavior });
    const managedAgent = agentRow({ id: "agent-repo-managed", behavior: currentBehavior });
    const { env, statements } = createRecordingEnv({
      role: "owner",
      agents: [oldAgent],
      agent: managedAgent,
    });

    const response = await handleInstantiateAgentPack(env, identity, "repo-analyst");
    const body = (await response.json()) as { created?: boolean; packVersion?: string };

    expect(response.status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.packVersion).toBe("1.2.2");
    const insert = statements.find((statement) =>
      statement.query.includes("INSERT OR IGNORE INTO agents"),
    );
    expect(insert).toBeDefined();
    expect(
      insert?.values.some(
        (value) => typeof value === "string" && value.includes('"provisionedBy":"agent_pack"'),
      ),
    ).toBe(true);
    expect(oldAgent.data_json).toContain('"packVersion":"0.9.0"');
  });

  it("keeps conformance-only packages hidden except in explicit E2E mode", async () => {
    const normal = createRecordingEnv({ role: "owner", agent: agentRow() });
    const hidden = await handleInstantiateAgentPack(normal.env, identity, "complex-operator");
    expect(hidden.status).toBe(404);

    const conformanceAgent = agentRow({ id: "agent-complex" });
    const e2e = createRecordingEnv({ role: "owner", agent: conformanceAgent, e2eMode: true });
    const instantiated = await handleInstantiateAgentPack(e2e.env, identity, "complex-operator");
    expect(instantiated.status).toBe(201);
    const insert = e2e.statements.find((statement) =>
      statement.query.includes("INSERT OR IGNORE INTO agents"),
    );
    expect(
      insert?.values.some(
        (value) => typeof value === "string" && value.includes('"packId":"complex-operator"'),
      ),
    ).toBe(true);
  });
});
