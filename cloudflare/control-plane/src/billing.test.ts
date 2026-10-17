import { afterEach, describe, expect, it } from "vitest";

import {
  applyBillingEvent,
  handleBilling,
  handleBillingWebhookIngress,
  reportDailyBillingUsage,
} from "./billing";
import {
  clampLimitsToPlan,
  entitlementsFor,
  limitsExceedPlan,
  loadBillingCatalog,
  requireEntitlement,
  resolveEntitlements,
} from "./billing-plans";
import { hmacSha256Hex, mapStripeEvent, verifyStripeSignature } from "./billing-provider";
import { createPackTestRuntime } from "./pack-test-runtime";
import { handleRuntimeBudgets } from "./runtime-usage";

const limits = {
  dailyModelCalls: 10,
  dailyToolCalls: 10,
  dailyTokens: 10,
  runModelCalls: 10,
  runToolCalls: 10,
  runTokens: 10,
  concurrentOperations: 10,
};
const plan = (id: string, cap: number, features: string[] = []) => ({
  id,
  label: id,
  seats: 1,
  limits: Object.fromEntries(Object.keys(limits).map((key) => [key, cap])),
  features,
});

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

describe("billing plans", () => {
  it("validates the catalog and refuses malformed plans", () => {
    const catalog = loadBillingCatalog();
    expect(catalog.plans.map((item) => item.id)).toEqual(["free", "team"]);
    expect(() => loadBillingCatalog({ plans: [] })).toThrow("billing_catalog_empty");
    expect(() => loadBillingCatalog({ plans: [plan("a", 1), plan("a", 1)] })).toThrow("duplicate");
    expect(() => loadBillingCatalog({ plans: [plan("Bad Id", 1)] })).toThrow("id_invalid");
    expect(() => loadBillingCatalog({ plans: [plan("a", 1, ["teleport"])] })).toThrow(
      "feature_invalid",
    );
    expect(() => loadBillingCatalog({ defaultPlanId: "zz", plans: [plan("a", 1)] })).toThrow(
      "default_plan_missing",
    );
    expect(
      loadBillingCatalog({ plans: [{ ...plan("a", 1), providerPrices: { stripe: "" } }] }).plans[0],
    ).not.toHaveProperty("providerPrices");
  });

  it("treats the plan as a ceiling", () => {
    const low = loadBillingCatalog({ plans: [plan("low", 5)] }).plans[0]!;
    expect(clampLimitsToPlan(limits, low)).toEqual(
      Object.fromEntries(Object.keys(limits).map((key) => [key, 5])),
    );
    expect(limitsExceedPlan(limits, low)).toHaveLength(7);
    expect(
      limitsExceedPlan(limits, loadBillingCatalog({ plans: [plan("high", 50)] }).plans[0]!),
    ).toEqual([]);
  });

  it("falls back to the default plan for cancelled or unknown subscriptions", () => {
    const plans = loadBillingCatalog({
      defaultPlanId: "free",
      plans: [plan("free", 1), plan("pro", 9, ["delegation"])],
    }).plans;
    const base = {
      workspaceId: "ws",
      provider: "stripe" as const,
      providerCustomerId: "cus_1",
      providerSubscriptionId: "sub_1",
      currentPeriodEnd: null,
      seats: 3,
      updatedAt: "now",
    };
    expect(
      entitlementsFor({ ...base, planId: "pro", status: "active" }, plans, plans[0]),
    ).toMatchObject({
      planId: "pro",
      features: ["delegation"],
      seats: 3,
      subscribed: true,
    });
    expect(
      entitlementsFor({ ...base, planId: "pro", status: "cancelled" }, plans, plans[0]),
    ).toMatchObject({
      planId: "free",
      subscribed: false,
    });
    expect(
      entitlementsFor({ ...base, planId: "gone", status: "active" }, plans, plans[0]).planId,
    ).toBe("free");
    expect(entitlementsFor(null, plans, plans[0])).toMatchObject({
      planId: "free",
      provider: "manual",
    });
  });
});

describe("stripe provider", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({
    id: "evt_1",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_1", customer: "cus_1", metadata: { workspaceId: "ws-user" } } },
  });

  it("verifies Stripe-Signature within tolerance and rejects tampering", async () => {
    const now = 1_700_000_000_000;
    const timestamp = Math.floor(now / 1000);
    const signature = await hmacSha256Hex(secret, `${timestamp}.${body}`);
    const header = `t=${timestamp},v1=${signature}`;
    expect(await verifyStripeSignature(header, body, secret, now)).toBe(true);
    expect(
      await verifyStripeSignature(`t=${timestamp},v1=deadbeef,v1=${signature}`, body, secret, now),
    ).toBe(true);
    expect(await verifyStripeSignature(header, body + " ", secret, now)).toBe(false);
    expect(await verifyStripeSignature(header, body, "other", now)).toBe(false);
    expect(await verifyStripeSignature(header, body, secret, now + 6 * 60_000)).toBe(false);
    expect(await verifyStripeSignature(null, body, secret, now)).toBe(false);
    expect(await verifyStripeSignature("v1=abc", body, secret, now)).toBe(false);
  });

  it("maps events onto the subscription row", () => {
    const plans = loadBillingCatalog({
      plans: [{ ...plan("team", 9), providerPrices: { stripe: "price_team" } }],
    }).plans;
    expect(
      mapStripeEvent(
        {
          id: "evt_2",
          type: "checkout.session.completed",
          data: {
            object: {
              mode: "subscription",
              client_reference_id: "ws-1",
              customer: "cus_1",
              subscription: "sub_1",
              metadata: { planId: "team" },
            },
          },
        },
        plans,
      ),
    ).toMatchObject({
      type: "subscription.changed",
      workspaceId: "ws-1",
      planId: "team",
      status: "active",
      providerCustomerId: "cus_1",
    });
    expect(
      mapStripeEvent(
        {
          id: "evt_3",
          type: "customer.subscription.updated",
          data: {
            object: {
              id: "sub_1",
              customer: "cus_1",
              status: "past_due",
              current_period_end: 1_800_000_000,
              metadata: { workspaceId: "ws-1" },
              items: { data: [{ quantity: 4, price: { id: "price_team" } }] },
            },
          },
        },
        plans,
      ),
    ).toMatchObject({
      planId: "team",
      status: "past_due",
      seats: 4,
      currentPeriodEnd: "2027-01-15T08:00:00.000Z",
    });
    expect(mapStripeEvent(JSON.parse(body), plans)).toMatchObject({
      status: "cancelled",
      workspaceId: "ws-user",
    });
    expect(mapStripeEvent({ id: "evt_4", type: "invoice.paid" }, plans)).toMatchObject({
      type: "ignored",
    });
    expect(
      mapStripeEvent(
        { id: "evt_5", type: "checkout.session.completed", data: { object: { mode: "payment" } } },
        plans,
      ),
    ).toMatchObject({ type: "ignored" });
  });
});

describe("billing routes", () => {
  const request = (path: string, init: RequestInit = {}) =>
    new Request(`https://runtime.test${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
  const read = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  });

  it("reports the plan, assigns one manually and clamps the budget to it", async () => {
    const runtime = createPackTestRuntime({ packId: "operloom", users: ["user", "member"] });
    runtime.db.prepare("UPDATE memberships SET role = 'member' WHERE user_id = 'member'").run();
    const identity = runtime.identity();

    const initial = await read(
      await handleBilling(request("/workbench/billing"), runtime.env, identity),
    );
    expect(initial.body).toMatchObject({
      ok: true,
      provider: "manual",
      subscription: null,
      entitlements: { planId: "free", subscribed: false },
    });
    const plans = await read(
      await handleBilling(request("/workbench/billing/plans"), runtime.env, identity),
    );
    expect(plans.body.plans.map((item: { id: string }) => item.id)).toEqual(["free", "team"]);

    // Budgets bootstrap at min(default, plan) and refuse to exceed the ceiling.
    const budgets = await read(
      await handleRuntimeBudgets(request("/workbench/budgets"), runtime.env, identity),
    );
    expect(budgets.body.plan.id).toBe("free");
    const freeLimits = budgets.body.plan.limits;
    const tooHigh = await read(
      await handleRuntimeBudgets(
        request("/workbench/budgets", {
          method: "PUT",
          body: JSON.stringify({
            expectedVersion: 0,
            idempotencyKey: "k1",
            limits: { ...freeLimits, dailyModelCalls: freeLimits.dailyModelCalls + 1 },
          }),
        }),
        runtime.env,
        identity,
      ),
    );
    expect(tooHigh).toMatchObject({ status: 409, body: { code: "budget_exceeds_plan" } });
    const atCeiling = await read(
      await handleRuntimeBudgets(
        request("/workbench/budgets", {
          method: "PUT",
          body: JSON.stringify({ expectedVersion: 0, idempotencyKey: "k2", limits: freeLimits }),
        }),
        runtime.env,
        identity,
      ),
    );
    expect(atCeiling.body).toMatchObject({ ok: true, policy: { version: 1 } });

    const denied = await read(
      await handleBilling(
        request("/workbench/billing/plan", {
          method: "PUT",
          body: JSON.stringify({ planId: "team" }),
        }),
        runtime.env,
        runtime.identity("member"),
      ),
    );
    expect(denied).toMatchObject({ status: 403, body: { code: "billing_scope_denied" } });
    const assigned = await read(
      await handleBilling(
        request("/workbench/billing/plan", {
          method: "PUT",
          body: JSON.stringify({ planId: "team", seats: 5 }),
        }),
        runtime.env,
        identity,
      ),
    );
    expect(assigned.body).toMatchObject({
      ok: true,
      entitlements: { planId: "team", seats: 10, subscribed: true },
      subscription: { provider: "manual", seats: 5 },
    });
    expect(
      await read(
        await handleBilling(
          request("/workbench/billing/plan", {
            method: "PUT",
            body: JSON.stringify({ planId: "nope" }),
          }),
          runtime.env,
          identity,
        ),
      ),
    ).toMatchObject({ status: 404 });

    // A plan change bumps the policy version; raising the plan raises the ceiling and a
    // webhook-driven downgrade clamps the stored policy.
    const afterPlan = await read(
      await handleRuntimeBudgets(request("/workbench/budgets"), runtime.env, identity),
    );
    expect(afterPlan.body.policy.version).toBe(2);
    const raised = await read(
      await handleRuntimeBudgets(
        request("/workbench/budgets", {
          method: "PUT",
          body: JSON.stringify({
            expectedVersion: 2,
            idempotencyKey: "k3",
            limits: { ...freeLimits, dailyModelCalls: 4000 },
          }),
        }),
        runtime.env,
        identity,
      ),
    );
    expect(raised.body).toMatchObject({
      ok: true,
      policy: { version: 3, limits: { dailyModelCalls: 4000 } },
    });
    await applyBillingEvent(runtime.env, {
      type: "subscription.changed",
      workspaceId: identity.scope.workspaceId,
      planId: "free",
      status: "active",
      providerCustomerId: "cus_1",
      providerSubscriptionId: "sub_1",
      currentPeriodEnd: null,
      seats: null,
      eventId: "evt_x",
    });
    const clamped = await read(
      await handleRuntimeBudgets(request("/workbench/budgets"), runtime.env, identity),
    );
    expect(clamped.body.policy).toMatchObject({
      version: 4,
      limits: { dailyModelCalls: freeLimits.dailyModelCalls },
    });
    expect(await resolveEntitlements(runtime.env, identity.scope.workspaceId)).toMatchObject({
      planId: "free",
      provider: "stripe",
      subscribed: true,
    });

    // Checkout and portal are unavailable on the manual provider.
    expect(
      await read(
        await handleBilling(
          request("/workbench/billing/checkout", {
            method: "POST",
            body: JSON.stringify({
              planId: "team",
              successUrl: "https://a.example/ok",
              cancelUrl: "https://a.example/no",
            }),
          }),
          runtime.env,
          identity,
        ),
      ),
    ).toMatchObject({ status: 409, body: { code: "billing_checkout_unavailable" } });
    expect(
      await read(
        await handleBilling(
          request("/workbench/billing/checkout", {
            method: "POST",
            body: JSON.stringify({ planId: "team", successUrl: "http://a", cancelUrl: "http://b" }),
          }),
          runtime.env,
          identity,
        ),
      ),
    ).toMatchObject({ status: 400 });
    // The manual provider has no webhook, so ingress is a 404 and signatures never reach the DB.
    expect(
      (
        await handleBillingWebhookIngress(
          request("/billing-ingress/stripe", { method: "POST", body: "{}" }),
          runtime.env,
          "stripe",
        )
      ).status,
    ).toBe(404);
  });

  it("aggregates daily usage and records an idempotent usage report", async () => {
    const runtime = createPackTestRuntime({ packId: "operloom" });
    const identity = runtime.identity();
    const insert = runtime.db.prepare(
      `INSERT INTO control_resource_reservations (id,user_id,workspace_id,agent_id,run_id,run_kind,budget_run_id,budget_run_kind,request_hash,kind,
         estimated_input_tokens,reserved_tokens,input_tokens,output_tokens,status,usage_source,day,created_at,expires_at,
         agent_revision,pack_id,operation_key,policy_version,preconditions_met)
       VALUES (?,?,?,?,?,'workflow',?,'workflow',?,?,?,?,?,?,'settled','provider',?,?,?,0,'operloom',?,1,1)`,
    );
    for (const [id, kind, inTok, outTok, day] of [
      ["r1", "model", 100, 50, "2026-01-01"],
      ["r2", "tool", 0, 0, "2026-01-01"],
      ["r3", "model", 10, 10, "2026-01-02"],
    ] as const) {
      insert.run(
        id,
        identity.scope.userId,
        identity.scope.workspaceId,
        identity.agentId,
        "run",
        "run",
        `h-${id}`,
        kind,
        inTok,
        inTok + outTok,
        inTok,
        outTok,
        day,
        "now",
        "later",
        `op-${id}`,
      );
    }
    const usage = await read(
      await handleBilling(
        request("/workbench/billing/usage?from=2026-01-01&to=2026-01-02"),
        runtime.env,
        identity,
      ),
    );
    expect(usage.body).toMatchObject({
      ok: true,
      days: [
        { day: "2026-01-01", modelCalls: 1, toolCalls: 1, tokens: 150 },
        { day: "2026-01-02", modelCalls: 1, toolCalls: 0, tokens: 20 },
      ],
      reports: [],
    });
    expect(
      await read(
        await handleBilling(
          request("/workbench/billing/usage?from=2026-01-03&to=2026-01-02"),
          runtime.env,
          identity,
        ),
      ),
    ).toMatchObject({ status: 400 });
    const report = await read(
      await handleBilling(
        request("/workbench/billing/usage/report", {
          method: "POST",
          body: JSON.stringify({ day: "2026-01-01" }),
        }),
        runtime.env,
        identity,
      ),
    );
    expect(report.body).toMatchObject({
      ok: true,
      report: { day: "2026-01-01", status: "skipped", provider: "manual", tokens: 150 },
    });
    const replay = await read(
      await handleBilling(
        request("/workbench/billing/usage/report", {
          method: "POST",
          body: JSON.stringify({ day: "2026-01-01" }),
        }),
        runtime.env,
        identity,
      ),
    );
    expect(replay.body).toMatchObject({ ok: true, replayed: true });
    const today = new Date().toISOString().slice(0, 10);
    expect(
      await read(
        await handleBilling(
          request("/workbench/billing/usage/report", {
            method: "POST",
            body: JSON.stringify({ day: today }),
          }),
          runtime.env,
          identity,
        ),
      ),
    ).toMatchObject({
      status: 409,
      body: { code: "billing_day_open" },
    });
  });

  it("reports yesterday for every workspace with usage on the scheduler tick", async () => {
    const runtime = createPackTestRuntime({ packId: "operloom", users: ["user", "other"] });
    const identity = runtime.identity();
    const insert = runtime.db.prepare(
      `INSERT INTO control_resource_reservations (id,user_id,workspace_id,agent_id,run_id,run_kind,budget_run_id,budget_run_kind,request_hash,kind,
         estimated_input_tokens,reserved_tokens,input_tokens,output_tokens,status,usage_source,day,created_at,expires_at,
         agent_revision,pack_id,operation_key,policy_version,preconditions_met)
       VALUES (?,?,?,?,?,'workflow',?,'workflow',?,'model',5,10,5,5,'settled','provider',?,'now','later',0,'operloom',?,1,1)`,
    );
    const now = new Date("2026-03-02T04:00:00.000Z");
    insert.run(
      "r1",
      "user",
      identity.scope.workspaceId,
      identity.agentId,
      "run",
      "run",
      "h1",
      "2026-03-01",
      "op-1",
    );
    insert.run("r2", "other", "ws-other", "agent-other", "run", "run", "h2", "2026-03-01", "op-2");
    insert.run(
      "r3",
      "user",
      identity.scope.workspaceId,
      identity.agentId,
      "run",
      "run",
      "h3",
      "2026-03-02",
      "op-3",
    );
    expect(await reportDailyBillingUsage(runtime.env, now)).toEqual({
      day: "2026-03-01",
      selected: 2,
      reported: 2,
    });
    expect(await reportDailyBillingUsage(runtime.env, now)).toEqual({
      day: "2026-03-01",
      selected: 0,
      reported: 0,
    });
    const rows = runtime.db
      .prepare(
        "SELECT workspace_id, day, status, tokens FROM control_billing_usage_reports ORDER BY workspace_id",
      )
      .all();
    expect(rows).toEqual([
      { workspace_id: "ws-other", day: "2026-03-01", status: "skipped", tokens: 10 },
      {
        workspace_id: identity.scope.workspaceId,
        day: "2026-03-01",
        status: "skipped",
        tokens: 10,
      },
    ]);
  });

  it("gates features by plan", async () => {
    const runtime = createPackTestRuntime({ packId: "operloom" });
    const identity = runtime.identity();
    await expect(
      requireEntitlement(runtime.env, identity.scope.workspaceId, "delegation"),
    ).resolves.toMatchObject({ planId: "free" });
    runtime.db
      .prepare(
        "INSERT INTO control_workspace_subscriptions (workspace_id,plan_id,status,provider,seats,updated_at) VALUES (?,?,?,?,1,'now')",
      )
      .run(identity.scope.workspaceId, "ghost", "active", "manual");
    // An unknown plan resolves to the default plan, which still grants the feature.
    await expect(
      requireEntitlement(runtime.env, identity.scope.workspaceId, "delegation"),
    ).resolves.toMatchObject({ planId: "free" });
  });
});
