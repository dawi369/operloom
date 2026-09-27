import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import product from "../../../config/product.json";
import { defaultAgentBehaviorTemplateId, maxWorkspaceAgents } from "./agent-behavior-templates";
import { handleCreateAgent, handleInstantiateAgentPack } from "./agents";
import { createDefaultAgentIfMissing, defaultAgentId } from "./authz";
import type { AgentIdentity, D1PreparedStatement, Env } from "./types";

const identity: AgentIdentity = { scope: { userId: "u", workspaceId: "w" }, agentId: "agent-w" };
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const fixture = () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO users (id,status,created_at,updated_at) VALUES ('u','active','now','now');
    INSERT INTO workspaces (id,account_id,account_source,name,status,created_by_user_id,created_at,updated_at)
      VALUES ('w','acct','local','Workspace','active','u','now','now');
    INSERT INTO memberships (id,user_id,workspace_id,role,status,created_at,updated_at)
      VALUES ('m','u','w','owner','active','now','now');`);
  const env = {
    DB: {
      prepare(query: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...parameters: unknown[]) {
            values = parameters;
            return statement;
          },
          async first<T>() {
            return (db.prepare(query).get(...(values as never[])) ?? null) as T | null;
          },
          async all<T>() {
            return { results: db.prepare(query).all(...(values as never[])) as T[] };
          },
          async run() {
            const { changes } = db.prepare(query).run(...(values as never[]));
            return { success: true, meta: { changes: Number(changes) } };
          },
        };
        return statement as unknown as D1PreparedStatement;
      },
    },
  } as unknown as Env;
  return { db, env };
};

const createAgent = (env: Env, name: string) =>
  handleCreateAgent(
    new Request("http://worker/agents", {
      method: "POST",
      body: JSON.stringify({ name, profile: "analyst" }),
    }),
    env,
    identity,
  );

describe("workspace defaults", () => {
  it("creates the default agent from the configured product pack", async () => {
    const { db, env } = fixture();
    await createDefaultAgentIfMissing(env, { workspaceId: "w", userId: "u" });
    const row = db
      .prepare("SELECT name, is_default, data_json FROM agents WHERE id = ?")
      .get(defaultAgentId("w")) as { name: string; is_default: number; data_json: string };
    expect(defaultAgentBehaviorTemplateId).toBe(`pack-${product.workspace.defaultAgentPack}`);
    expect(row.is_default).toBe(1);
    expect(JSON.parse(row.data_json).behavior).toMatchObject({
      templateId: defaultAgentBehaviorTemplateId,
      pack: { id: product.workspace.defaultAgentPack },
    });
  });

  it("caps active agents per workspace, including pack instances", async () => {
    const { db, env } = fixture();
    await createDefaultAgentIfMissing(env, { workspaceId: "w", userId: "u" });
    for (let index = 1; index < maxWorkspaceAgents; index += 1)
      expect((await createAgent(env, `Agent ${index}`)).status).toBe(201);

    const blocked = await createAgent(env, "One too many");
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "agent_limit_reached" });
    const instantiated = await handleInstantiateAgentPack(env, identity, "repo-analyst");
    expect(instantiated.status).toBe(409);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM agents").get() as { count: number }).count,
    ).toBe(maxWorkspaceAgents);

    db.exec("UPDATE agents SET status = 'archived' WHERE name = 'Agent 1'");
    expect((await createAgent(env, "Replacement")).status).toBe(201);

    // Conformance fixtures exist only in E2E/conformance modes and never count against the cap.
    env.OPERLOOM_E2E_MODE = "true";
    expect((await handleInstantiateAgentPack(env, identity, "document-review")).status).toBe(201);
  });
});
