import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { RuntimeRecord, RuntimeStatePort } from "@operloom/agent-sdk";

import {
  createAgentBehaviorSnapshotFromTemplate,
  toPackTemplate,
} from "./agent-behavior-templates";
import { handleUpdateAgentSettings } from "./agent-settings";
import { handleRunRuntimeQuery } from "./runtime-queries";
import { createRuntimeStatePort } from "./runtime-state";
import { executeRuntimeWorkflowRequest } from "./runtime-workflows";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";
import type { LocalAgentPackManifest } from "../../../agent-packs";
import type { WorkflowInvocationContext } from "./pack-workflow-runtime";
import type { AgentIdentity, D1PreparedStatement, EffectTarget, Env } from "./types";

type Statement = D1PreparedStatement & { execute(): { success: true; meta: { changes: number } } };

const sqliteD1 = (db: DatabaseSync) => ({
  prepare(query: string): Statement {
    let values: unknown[] = [];
    const statement: Statement = {
      bind(...parameters) {
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
        return statement.execute();
      },
      execute() {
        return {
          success: true,
          meta: { changes: Number(db.prepare(query).run(...(values as never[])).changes) },
        };
      },
    };
    return statement;
  },
  async batch(statements: Statement[]) {
    db.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      db.exec("COMMIT");
      return results;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
});

/**
 * An in-memory control plane for package acceptance tests: the real Worker workflow, state,
 * settings and query paths on SQLite, with one isolated workspace and agent per user and the
 * deterministic local model fixture. Not for production use.
 */
export const createPackTestRuntime = (input: {
  packId: keyof typeof agentManifestRegistry;
  users?: readonly string[];
  effectTarget?: EffectTarget;
}) => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = {
    DB: sqliteD1(db),
    OPERLOOM_E2E_MODE: "true",
    OPERLOOM_ENVIRONMENT: "local",
    OPERLOOM_CONFORMANCE_MODE: "true",
  } as unknown as Env;
  const manifest = agentManifestRegistry[input.packId].module as LocalAgentPackManifest;
  const behavior = createAgentBehaviorSnapshotFromTemplate(toPackTemplate(manifest));
  const users = input.users ?? ["user"];
  const target = input.effectTarget ?? "simulation";
  for (const user of users) {
    db.prepare(
      "INSERT INTO users (id,status,created_at,updated_at) VALUES (?,'active','now','now')",
    ).run(user);
    db.prepare(
      `INSERT INTO workspaces (id,account_id,account_source,name,status,created_by_user_id,created_at,updated_at)
       VALUES (?,?,'local','Workspace','active',?,'now','now')`,
    ).run(`ws-${user}`, `acct-${user}`, user);
    db.prepare(
      `INSERT INTO memberships (id,user_id,workspace_id,role,status,created_at,updated_at)
       VALUES (?,?,?,'owner','active','now','now')`,
    ).run(`m-${user}`, user, `ws-${user}`);
    db.prepare(
      `INSERT INTO agents (id,workspace_id,name,status,effect_target,created_by_user_id,data_json,created_at,updated_at)
       VALUES (?,?,?,'active',?,?,?,'now','now')`,
    ).run(
      `agent-${user}`,
      `ws-${user}`,
      manifest.name,
      target,
      user,
      JSON.stringify({ profile: manifest.profile, behavior }),
    );
  }
  const identity = (user = users[0]!): AgentIdentity => ({
    scope: { userId: user, workspaceId: `ws-${user}` },
    agentId: `agent-${user}`,
    agentRevision: 0,
    effectTarget: target,
  });
  const json = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & { report?: RuntimeRecord },
  });
  const runtime = resolvePackRuntime(manifest.id, manifest.version);
  return {
    db,
    env,
    identity,
    runWorkflow: async (
      workflowType: string,
      workflowInput: RuntimeRecord = {},
      options: { user?: string; invocation?: WorkflowInvocationContext } = {},
    ) =>
      json(
        await executeRuntimeWorkflowRequest(
          workflowType,
          new Request(`https://runtime.test/workbench/workflows/${workflowType}`, {
            method: "POST",
            body: JSON.stringify({ input: workflowInput, executionMode: "dry_run" }),
          }),
          env,
          identity(options.user),
          options.invocation ?? { source: "user" },
        ),
      ),
    runQuery: async (queryId: string, queryInput: RuntimeRecord = {}, user?: string) =>
      json(
        await handleRunRuntimeQuery(
          new Request(`https://runtime.test/queries/${queryId}`, {
            method: "POST",
            body: JSON.stringify({ input: queryInput }),
          }),
          env,
          identity(user),
          queryId,
        ),
      ),
    updateSettings: async (values: RuntimeRecord, user?: string) => {
      const id = identity(user);
      const current = db
        .prepare("SELECT settings_version FROM agents WHERE id = ?")
        .get(id.agentId) as { settings_version: number };
      return json(
        await handleUpdateAgentSettings(
          new Request("https://runtime.test/settings", {
            method: "PUT",
            body: JSON.stringify({ values, expectedVersion: current.settings_version }),
          }),
          env,
          id,
          id.agentId,
        ),
      );
    },
    state: (user?: string): Promise<RuntimeStatePort> =>
      createRuntimeStatePort(env, identity(user), {
        packId: manifest.id,
        target,
        definitions: runtime.runnable ? (runtime.controlPlane.state ?? []) : [],
      }),
    entries: (type: "decision" | "effect", user?: string) =>
      (
        db
          .prepare(
            `SELECT e.data_json FROM control_state_entries e
             WHERE e.user_id = ? AND e.workspace_id = ? AND e.agent_id = ? AND e.type = ?
             ORDER BY e.created_at, e.id`,
          )
          .all(...Object.values(identity(user).scope), identity(user).agentId, type) as {
          data_json: string;
        }[]
      ).map((row) => JSON.parse(row.data_json) as RuntimeRecord),
    close: () => db.close(),
  };
};
