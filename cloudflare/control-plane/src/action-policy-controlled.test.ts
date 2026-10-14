import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionProposal, RuntimeToolBinding } from "@operloom/agent-sdk";
import { capacityOperations } from "../../../tests/fixtures/provider-operation-package/control-plane";
import { createDurableActionPort } from "./action-authority-execution";
import {
  handleListActionProposals,
  handleRequestActionExecution,
  handleReviewAction,
} from "./action-authority-handlers";
import { evaluateApprovalLimits } from "./action-policy-limits";
import { updateToolPermissionStatus } from "./tool-policy";
import {
  createAgentBehaviorSnapshotFromTemplate,
  toPackTemplate,
} from "./agent-behavior-templates";
import * as registry from "../../../lib/agent-runtime/registry";
import { manifest } from "../../../examples/complex-operator/manifest";
import { controlPlane } from "../../../examples/complex-operator/control-plane";
import type { AgentIdentity, D1PreparedStatement, Env } from "./types";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

const toolId = "operator.action.execute";
const runtimeIdentity = {
  packId: "complex-operator",
  packVersion: manifest.version,
  runtimeVersion: controlPlane.runtimeVersion,
  bindingVersion: 1,
  runId: "origin",
  workflowIntentId: "origin-intent",
};
const allocation = (idempotencyKey: string, preview: Record<string, unknown> = {}) =>
  ({
    toolId,
    type: "allocate",
    summary: "Allocate capacity",
    idempotencyKey,
    preview: { resource: "compute-pool", units: 3, ...preview },
  }) satisfies ActionProposal;

const policyBinding = (
  limits: NonNullable<NonNullable<RuntimeToolBinding["action"]>["policy"]>["limits"],
): RuntimeToolBinding => {
  const original = controlPlane.tools.find((tool) => tool.id === toolId)!;
  return {
    ...original,
    transport: "cloudflare_inline",
    sandbox: undefined,
    action: {
      connectionId: "operator.external-account",
      proposalSchema: { type: "object" },
      resultSchema: { type: "object", required: ["requestId", "resourceId", "lifecycle"] },
      idempotency: "required",
      approval: "policy_controlled",
      policy: { limits },
      timeoutMs: 5000,
      providerOperation: { id: "capacity.allocate", version: "1" },
      simulate: (proposal: ActionProposal) => ({
        requestId: `simulation:${proposal.idempotencyKey}`,
        resourceId: `sim-${proposal.idempotencyKey}`,
        lifecycle: "active",
      }),
    },
  };
};

const fixture = async (binding: RuntimeToolBinding) => {
  const original = registry.resolvePackRuntime(runtimeIdentity.packId, runtimeIdentity.packVersion);
  if (!original.runnable) throw new Error("Fixture runtime unavailable");
  vi.spyOn(registry, "resolvePackRuntime").mockReturnValue({
    ...original,
    controlPlane: {
      ...original.controlPlane,
      providerOperations: capacityOperations,
      settings: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { pools: { type: "array", items: { type: "string" } } },
        },
        defaults: { pools: ["compute-pool"] },
        editable: ["pools"],
      },
      tools: original.controlPlane.tools.map((tool) => (tool.id === toolId ? binding : tool)),
    },
  });
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO users(id,status,created_at,updated_at) VALUES ('u','active','now','now');
    INSERT INTO workspaces(id,account_id,account_source,name,status,created_by_user_id,created_at,updated_at) VALUES ('w','acct','local','Workspace','active','u','now','now');
    INSERT INTO memberships(id,user_id,workspace_id,role,status,created_at,updated_at) VALUES ('m','u','w','owner','active','now','now');
    INSERT INTO control_retention_policies(user_id,workspace_id,created_at,updated_at,confirmed_at) VALUES ('u','w','now','now','now');`);
  db.prepare(
    "INSERT INTO agents(id,workspace_id,name,status,effect_target,created_by_user_id,created_at,updated_at,data_json) VALUES ('a','w','Operator','active','simulation','u','now','now',?)",
  ).run(
    JSON.stringify({ behavior: createAgentBehaviorSnapshotFromTemplate(toPackTemplate(manifest)) }),
  );
  type Statement = D1PreparedStatement & {
    execute(): { success: true; meta: { changes: number } };
  };
  const env = {
    OPERLOOM_MUTATIONS_ENABLED: "true",
    DB: {
      prepare(sql: string): Statement {
        let values: unknown[] = [];
        const statement: Statement = {
          bind(...args) {
            if (args.length !== (sql.match(/\?/g)?.length ?? 0)) throw new Error("Bind mismatch");
            values = args;
            return statement;
          },
          async first<T>() {
            return (db.prepare(sql).get(...(values as never[])) ?? null) as T | null;
          },
          async all<T>() {
            return { results: db.prepare(sql).all(...(values as never[])) as T[] };
          },
          async run() {
            return statement.execute();
          },
          execute() {
            const before = Number(db.prepare("SELECT total_changes() n").get()!.n);
            db.prepare(sql).run(...(values as never[]));
            return {
              success: true,
              meta: { changes: Number(db.prepare("SELECT total_changes() n").get()!.n) - before },
            };
          },
        };
        return statement;
      },
      async batch(statements: Statement[]) {
        db.exec("BEGIN");
        try {
          const result = statements.map((item) => item.execute());
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  } as unknown as Env;
  const identity: AgentIdentity = {
    scope: { userId: "u", workspaceId: "w" },
    agentId: "a",
    effectTarget: "simulation",
  };
  await updateToolPermissionStatus(env, identity, { toolName: toolId, mutationEnabled: true });
  const port = createDurableActionPort(env, identity, runtimeIdentity);
  const proposals = () =>
    db
      .prepare(
        "SELECT id,status,approval_decision,approval_evidence,reviewed_at FROM control_action_proposals ORDER BY created_at",
      )
      .all() as {
      id: string;
      status: string;
      approval_decision: string | null;
      approval_evidence: string;
      reviewed_at: string | null;
    }[];
  const pending = async () => {
    const response = await handleListActionProposals(
      env,
      identity,
      new URL("https://x/workbench/actions?review=pending"),
    );
    return (await response.json()) as {
      proposals: { id: string; status: string; approval: unknown }[];
    };
  };
  return { db, env, identity, port, binding, proposals, pending };
};

describe("policy-controlled approvals", () => {
  it("dispatches inside the count limit, then holds the next proposal for review", async () => {
    const f = await fixture(policyBinding([{ kind: "count", per: "day", max: 1 }]));
    const first = await f.port.propose(allocation("one"));
    expect(first).toMatchObject({ status: "executed", approval: "auto" });
    const second = await f.port.propose(allocation("two"));
    expect(second).toMatchObject({ status: "proposed", approval: "review" });
    const rows = f.proposals();
    expect(rows.map((row) => [row.status, row.approval_decision])).toEqual([
      ["executed", "auto"],
      ["proposed", "review"],
    ]);
    expect(JSON.parse(rows[1]!.approval_evidence)).toMatchObject({
      decision: "review",
      limits: [{ kind: "count", observed: 2, allowed: false }],
    });
    const ledger = f.db
      .prepare("SELECT status FROM control_action_ledger WHERE proposal_id=? ORDER BY sequence")
      .all(first.proposalId)
      .map((row) => (row as { status: string }).status);
    expect(ledger.filter((status) => status !== "executing")).toEqual([
      "proposed",
      "approved",
      "executed",
    ]);
    expect(f.db.prepare("SELECT status,reason FROM control_approval_requests").get()).toMatchObject(
      { status: "approved", reason: expect.stringContaining("policy") },
    );
    expect(f.db.prepare("SELECT status FROM control_runs WHERE id<>'origin'").all()).toEqual([
      { status: "completed" },
    ]);
    // Replaying the key returns the recorded decision without dispatching again.
    expect(await f.port.propose(allocation("one"))).toMatchObject({
      proposalId: first.proposalId,
      status: "proposed",
      approval: "auto",
    });
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_provider_operations").get()!.n).toBe(1);
  });

  it("lists auto dispatches as pending review until an operator acknowledges them", async () => {
    const f = await fixture(policyBinding([{ kind: "count", per: "hour", max: 5 }]));
    const auto = await f.port.propose(allocation("auto"));
    const queue = await f.pending();
    expect(queue.proposals.map((item) => item.id)).toEqual([auto.proposalId]);
    expect(queue.proposals[0]!.approval).toMatchObject({ decision: "auto", reviewedAt: null });
    const reviewed = await handleReviewAction(f.env, f.identity, auto.proposalId);
    expect(reviewed.status).toBe(200);
    expect((await f.pending()).proposals).toEqual([]);
    expect(
      f.db
        .prepare(
          "SELECT status FROM control_action_ledger WHERE proposal_id=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(auto.proposalId),
    ).toEqual({ status: "reviewed" });
    expect((await handleReviewAction(f.env, f.identity, auto.proposalId)).status).toBe(200);
    // A held proposal is only reviewable through the approval path.
    f.db
      .prepare("UPDATE control_action_proposals SET approval_decision='review' WHERE id=?")
      .run(auto.proposalId);
    expect((await handleReviewAction(f.env, f.identity, auto.proposalId)).status).toBe(409);
  });

  it("holds a proposal when a kill switch or a changed setting withdraws authority at dispatch", async () => {
    const f = await fixture(
      policyBinding([{ kind: "allowlist", field: "resource", settingsKey: "pools" }]),
    );
    f.db
      .prepare(
        `INSERT INTO control_kill_switches (id,user_id,workspace_id,scope_kind,scope_id,enabled,reason,created_by_user_id,version,created_at,updated_at)
         VALUES ('ks','u','w','pack','complex-operator',1,'paused','u',1,'now','now')`,
      )
      .run();
    const blocked = await f.port.propose(allocation("blocked"));
    expect(blocked).toMatchObject({ status: "proposed", approval: "review" });
    expect(JSON.parse(f.proposals()[0]!.approval_evidence)).toMatchObject({
      decision: "review",
      downgradedBy: "kill_switch_active",
      limits: [{ kind: "allowlist", observed: "compute-pool", allowed: true }],
    });
    f.db.prepare("UPDATE control_kill_switches SET enabled=0").run();
    // The operator removes the pool from the allowlist between evaluation and dispatch.
    const settings = f.db.prepare("SELECT settings_json FROM agents WHERE id='a'");
    f.db
      .prepare("UPDATE agents SET settings_json=?,settings_version=1 WHERE id='a'")
      .run(JSON.stringify({ pools: [] }));
    expect(await f.port.propose(allocation("changed"))).toMatchObject({
      status: "proposed",
      approval: "review",
    });
    expect(settings.get()).toEqual({ settings_json: '{"pools":[]}' });
    expect(f.db.prepare("SELECT COUNT(*) n FROM control_provider_operations").get()!.n).toBe(0);
    // The held proposals still take the human path.
    const requested = await handleRequestActionExecution(f.env, f.identity, blocked.proposalId);
    expect(requested.status).toBe(202);
  });

  it("evaluates amount and allowlist limits against prior auto dispatches and settings", async () => {
    const f = await fixture(
      policyBinding([
        { kind: "amount", field: "units", max: 5 },
        { kind: "allowlist", field: "resource", settingsKey: "pools" },
      ]),
    );
    expect(await f.port.propose(allocation("a", { units: 3 }))).toMatchObject({ approval: "auto" });
    const settings = { version: 0, values: { pools: ["compute-pool"] } };
    const over = await evaluateApprovalLimits(
      f.env,
      f.identity,
      f.binding,
      allocation("b", { units: 3 }),
      settings,
    );
    expect(over).toMatchObject({
      decision: "review",
      limits: [
        { kind: "amount", observed: 6, allowed: false },
        { kind: "allowlist", observed: "compute-pool", allowed: true },
      ],
    });
    const within = await evaluateApprovalLimits(
      f.env,
      f.identity,
      f.binding,
      allocation("c", { units: 2 }),
      settings,
    );
    expect(within.decision).toBe("auto");
    const unlisted = await evaluateApprovalLimits(
      f.env,
      f.identity,
      f.binding,
      allocation("d", { units: 1, resource: "other-pool" }),
      settings,
    );
    expect(unlisted.limits[1]).toMatchObject({ allowed: false });
    const malformed = await evaluateApprovalLimits(
      f.env,
      f.identity,
      f.binding,
      allocation("e", { units: "many" }),
      settings,
    );
    expect(malformed.limits[0]).toMatchObject({ observed: null, allowed: false });
    expect(
      await evaluateApprovalLimits(f.env, f.identity, f.binding, allocation("f", { units: 1 }), {
        version: 1,
        values: {},
      }),
    ).toMatchObject({ decision: "review" });
  });
});
