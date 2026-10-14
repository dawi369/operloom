import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { RuntimeRecord, RuntimeStatePort, RuntimeTriggerPort } from "@operloom/agent-sdk";

import {
  createAgentBehaviorSnapshotFromTemplate,
  toPackTemplate,
} from "./agent-behavior-templates";
import { handleUpdateAgentSettings } from "./agent-settings";
import { handleRunRuntimeQuery } from "./runtime-queries";
import { createRuntimeStatePort } from "./runtime-state";
import { executeRuntimeWorkflowRequest } from "./runtime-workflows";
import { ensureDeclaredTrigger } from "./triggers";
import { resolvePackRuntime } from "../../../lib/agent-runtime/registry";
import { agentManifestRegistry } from "../../../generated/agent-runtime/manifests";
import type { LocalAgentPackManifest } from "../../../agent-packs";
import type { WorkflowInvocationContext } from "./pack-workflow-runtime";
import {
  handleListNotificationDeliveries,
  sweepNotificationDeliveries,
} from "./notification-delivery";
import { handleChannelPreferences } from "./notification-channels";
import { createNotificationPort } from "./notification-port";
import { runTriggerSchedulerTick } from "./trigger-scheduler";
import { getControlRunSnapshot } from "./control-run-store";
import { handleCancelExecutionRun } from "./run-control";
import { createTaskPort } from "./delegation-tasks";
import {
  createId,
  type AgentIdentity,
  type D1PreparedStatement,
  type EffectTarget,
  type Env,
} from "./types";

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
      "INSERT INTO users (id,email,status,created_at,updated_at) VALUES (?,?,'active','now','now')",
    ).run(user, `${user}@example.test`);
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
    triggers: (user?: string): RuntimeTriggerPort => ({
      ensure: (packTriggerId) =>
        ensureDeclaredTrigger(env, identity(user), manifest.id, packTriggerId),
    }),
    notifications: (user?: string) =>
      createNotificationPort(env, identity(user), { id: manifest.id }, "pack-test"),
    /** One scheduler tick: due triggers, pending dispatches and queued delegation tasks. */
    tickScheduler: (now = new Date()) =>
      runTriggerSchedulerTick(env, { now, leaseOwner: `pack-test:${now.toISOString()}` }),
    /** Adds a second agent of the same pack to a user's workspace. */
    addAgent: (user: string, agentId: string) => {
      db.prepare(
        `INSERT INTO agents (id,workspace_id,name,status,effect_target,created_by_user_id,data_json,created_at,updated_at)
         VALUES (?,?,?,'active',?,?,?,'now','now')`,
      ).run(agentId, `ws-${user}`, agentId, target, user, JSON.stringify({ behavior }));
      return agentId;
    },
    /** A live run with a task port, for exercising delegation outside a workflow. */
    openRun: (user?: string) => {
      const id = identity(user);
      const runId = `run-${createId("test")}`;
      const intentId = `intent-${runId}`;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO control_workflow_intents (id,user_id,workspace_id,agent_id,stage,type,execution_json,payload_json,status,created_at,updated_at)
         VALUES (?,?,?,?,'analyze','test','{}','{}','running',?,?)`,
      ).run(intentId, id.scope.userId, id.scope.workspaceId, id.agentId, now, now);
      db.prepare(
        `INSERT INTO control_runs (id,user_id,workspace_id,agent_id,workflow_intent_id,status,execution_json,stage,engine,heartbeat_at,last_event_at,data_json,created_at,updated_at)
         VALUES (?,?,?,?,?,'running','{}','analyze','cloudflare',?,?,?,?,?)`,
      ).run(
        runId,
        id.scope.userId,
        id.scope.workspaceId,
        id.agentId,
        intentId,
        now,
        now,
        JSON.stringify({ displayName: "test", packId: manifest.id }),
        now,
        now,
      );
      return {
        runId,
        tasks: createTaskPort(env, id, { packId: manifest.id, runId, runData: {} }),
      };
    },
    runSnapshot: (runId: string, user?: string) =>
      getControlRunSnapshot(env, identity(user).scope, runId),
    cancelRun: async (runId: string, user?: string) =>
      json(await handleCancelExecutionRun(env, identity(user), runId)),
    setNotificationPreference: async (body: Record<string, unknown>, user?: string) =>
      json(
        await handleChannelPreferences(
          new Request("https://runtime.test/workbench/notifications/preferences", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
          env,
          identity(user),
        ),
      ),
    listNotificationDeliveries: async (user?: string) =>
      json(
        await handleListNotificationDeliveries(
          env,
          identity(user),
          new URL("https://runtime.test/workbench/notifications/deliveries"),
        ),
      ),
    /** Runs the scheduled notification sweep (digest fold and local drain) against the recorded transport. */
    sweepNotifications: (now = new Date()) => sweepNotificationDeliveries(env, now),
    deliveries: (user?: string) =>
      db
        .prepare(
          `SELECT id, channel, event_type, target_id, severity, title, body, status, not_before
           FROM control_notification_deliveries WHERE user_id = ? AND workspace_id = ? ORDER BY created_at, id`,
        )
        .all(...Object.values(identity(user).scope)) as {
        id: string;
        channel: string;
        event_type: string;
        target_id: string;
        severity: string;
        title: string | null;
        body: string | null;
        status: string;
        not_before: string | null;
      }[],
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
