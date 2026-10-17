import { publicBillingContracts } from "../../../packages/client/src/public-billing-contracts";
import { selectMembership, selectUser } from "./authz-store";
import {
  applySubscriptionStatements,
  billingCatalog,
  EntitlementError,
  findPlan,
  resolveEntitlements,
  selectSubscription,
  type WorkspaceSubscription,
} from "./billing-plans";
import { billingProviderFor, type BillingEvent } from "./billing-provider";
import { json, parseJson } from "./http";
import { createId, type AgentIdentity, type Env } from "./types";

const requireAdmin = async (env: Env, identity: AgentIdentity) => {
  const membership = await selectMembership(env, identity.scope.userId, identity.scope.workspaceId);
  if (
    !membership ||
    membership.status !== "active" ||
    !["owner", "admin"].includes(String(membership.role).toLowerCase())
  )
    throw Object.assign(new Error("Workspace admin authority is required."), {
      code: "billing_scope_denied",
      status: 403,
    });
};

const failureResponse = (error: unknown) => {
  if (error instanceof EntitlementError)
    return json({ ok: false, code: error.code, error: error.message }, { status: error.status });
  const candidate = (error ?? {}) as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : "billing_failed";
  const status = typeof candidate.status === "number" ? candidate.status : 500;
  return json(
    {
      ok: false,
      code,
      error: code === "billing_failed" ? "Billing request failed." : String(candidate.message),
    },
    { status },
  );
};

const subscriptionView = (subscription: WorkspaceSubscription | null) =>
  subscription && {
    planId: subscription.planId,
    status: subscription.status,
    provider: subscription.provider,
    hasCustomer: Boolean(subscription.providerCustomerId),
    currentPeriodEnd: subscription.currentPeriodEnd,
    seats: subscription.seats,
    updatedAt: subscription.updatedAt,
  };

const planView = (plan: (typeof billingCatalog.plans)[number]) => ({
  id: plan.id,
  label: plan.label,
  seats: plan.seats,
  limits: plan.limits,
  features: plan.features,
  purchasable: Boolean(plan.providerPrices?.stripe),
});

const dailyUsage = async (env: Env, workspaceId: string, from: string, to: string) => {
  const rows = await env.DB.prepare(
    `SELECT day, COALESCE(SUM(kind = 'model'),0) modelCalls, COALESCE(SUM(kind = 'tool'),0) toolCalls,
            COALESCE(SUM(COALESCE(input_tokens + output_tokens, reserved_tokens)),0) tokens
     FROM control_resource_reservations WHERE workspace_id = ? AND day >= ? AND day <= ?
     GROUP BY day ORDER BY day`,
  )
    .bind(workspaceId, from, to)
    .all<{ day: string; modelCalls: number; toolCalls: number; tokens: number }>();
  return rows.results ?? [];
};

const recordEvent = (
  env: Env,
  identity: AgentIdentity | null,
  workspaceId: string,
  summary: string,
  data: unknown,
  now: string,
) =>
  env.DB.prepare(
    `INSERT INTO control_plane_events (id,user_id,workspace_id,agent_id,type,summary,target_type,target_id,data_json,created_at)
     VALUES (?,?,?,?,'billing.subscription.changed',?,'workspace',?,?,?)`,
  ).bind(
    createId("event"),
    identity?.scope.userId ?? "system",
    workspaceId,
    identity?.agentId ?? "system",
    summary,
    workspaceId,
    JSON.stringify(data ?? {}),
    now,
  );

export const handleBilling = async (request: Request, env: Env, identity: AgentIdentity) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^.*\/workbench\/billing/, "");
  const workspaceId = identity.scope.workspaceId;
  const provider = billingProviderFor(env, billingCatalog.plans);
  try {
    if (request.method === "GET" && path === "") {
      const subscription = await selectSubscription(env, workspaceId);
      return json({
        ok: true,
        provider: provider.id,
        entitlements: await resolveEntitlements(env, workspaceId),
        subscription: subscriptionView(subscription),
      });
    }
    if (request.method === "GET" && path === "/plans")
      return json({
        ok: true,
        defaultPlanId: billingCatalog.defaultPlanId,
        plans: billingCatalog.plans.map(planView),
      });
    if (request.method === "GET" && path === "/usage") {
      await requireAdmin(env, identity);
      const parsed = publicBillingContracts["GET /workbench/billing/usage"].query.safeParse(
        Object.fromEntries(url.searchParams),
      );
      if (!parsed.success || parsed.data.from > parsed.data.to)
        return json(
          { ok: false, code: "invalid_request", error: "Usage needs a bounded UTC day range" },
          { status: 400 },
        );
      const days = await dailyUsage(env, workspaceId, parsed.data.from, parsed.data.to);
      const reports = await env.DB.prepare(
        "SELECT day,status,provider,reported_at reportedAt FROM control_billing_usage_reports WHERE workspace_id = ? AND day >= ? AND day <= ?",
      )
        .bind(workspaceId, parsed.data.from, parsed.data.to)
        .all<{ day: string; status: string; provider: string; reportedAt: string | null }>();
      return json({
        ok: true,
        from: parsed.data.from,
        to: parsed.data.to,
        days,
        reports: reports.results ?? [],
      });
    }
    await requireAdmin(env, identity);
    const now = new Date().toISOString();
    if (request.method === "PUT" && path === "/plan") {
      const parsed = publicBillingContracts["PUT /workbench/billing/plan"].request.safeParse(
        parseJson(await request.text()),
      );
      if (!parsed.success)
        return json(
          { ok: false, code: "invalid_request", error: "A plan id is required" },
          { status: 400 },
        );
      if (provider.id !== "manual")
        return json(
          {
            ok: false,
            code: "billing_provider_managed",
            error: "Plans are managed through the billing provider.",
          },
          { status: 409 },
        );
      const plan = findPlan(parsed.data.planId);
      if (!plan)
        return json(
          { ok: false, code: "billing_plan_unknown", error: "Unknown plan" },
          { status: 404 },
        );
      await env.DB.batch([
        ...applySubscriptionStatements(env, {
          workspaceId,
          planId: plan.id,
          status: "active",
          provider: "manual",
          seats: parsed.data.seats ?? plan.seats,
          updatedByUserId: identity.scope.userId,
          now,
        }),
        recordEvent(
          env,
          identity,
          workspaceId,
          `Plan set to ${plan.label}.`,
          { planId: plan.id, provider: "manual" },
          now,
        ),
      ]);
      return json({
        ok: true,
        entitlements: await resolveEntitlements(env, workspaceId),
        subscription: subscriptionView(await selectSubscription(env, workspaceId)),
      });
    }
    if (request.method === "POST" && (path === "/checkout" || path === "/portal")) {
      const parsed = publicBillingContracts[
        path === "/checkout" ? "POST /workbench/billing/checkout" : "POST /workbench/billing/portal"
      ].request.safeParse(parseJson(await request.text()));
      if (!parsed.success)
        return json(
          { ok: false, code: "invalid_request", error: "Return URLs must be https" },
          { status: 400 },
        );
      if (path === "/checkout") {
        const input = parsed.data as { planId: string; successUrl: string; cancelUrl: string };
        const plan = findPlan(input.planId);
        if (!plan)
          return json(
            { ok: false, code: "billing_plan_unknown", error: "Unknown plan" },
            { status: 404 },
          );
        const user = await selectUser(env, identity.scope.userId);
        const link = await provider.createCheckout({
          workspaceId,
          plan,
          customerEmail: user?.email ?? null,
          successUrl: input.successUrl,
          cancelUrl: input.cancelUrl,
        });
        if (!link)
          return json(
            {
              ok: false,
              code: "billing_checkout_unavailable",
              error: "This plan has no hosted checkout.",
            },
            { status: 409 },
          );
        return json({ ok: true, url: link.url });
      }
      const subscription = await selectSubscription(env, workspaceId);
      if (!subscription?.providerCustomerId)
        return json(
          { ok: false, code: "billing_customer_missing", error: "No billing customer yet." },
          { status: 409 },
        );
      const link = await provider.createPortal({
        providerCustomerId: subscription.providerCustomerId,
        returnUrl: (parsed.data as { returnUrl: string }).returnUrl,
      });
      if (!link)
        return json(
          { ok: false, code: "billing_portal_unavailable", error: "The provider has no portal." },
          { status: 409 },
        );
      return json({ ok: true, url: link.url });
    }
    if (request.method === "POST" && path === "/usage/report") {
      const parsed = publicBillingContracts[
        "POST /workbench/billing/usage/report"
      ].request.safeParse(parseJson(await request.text()));
      if (!parsed.success)
        return json(
          { ok: false, code: "invalid_request", error: "A UTC day is required" },
          { status: 400 },
        );
      const day = parsed.data.day;
      if (day >= now.slice(0, 10))
        return json(
          { ok: false, code: "billing_day_open", error: "Only completed days are reported." },
          { status: 409 },
        );
      const existing = await env.DB.prepare(
        "SELECT id,status,provider,reported_at reportedAt FROM control_billing_usage_reports WHERE workspace_id = ? AND day = ?",
      )
        .bind(workspaceId, day)
        .first<{ id: string; status: string; provider: string; reportedAt: string | null }>();
      if (existing && existing.status !== "pending")
        return json({ ok: true, report: existing, replayed: true });
      const [totals] = await dailyUsage(env, workspaceId, day, day);
      const subscription = await selectSubscription(env, workspaceId);
      const report = {
        workspaceId,
        day,
        modelCalls: totals?.modelCalls ?? 0,
        toolCalls: totals?.toolCalls ?? 0,
        tokens: totals?.tokens ?? 0,
        providerCustomerId: subscription?.providerCustomerId ?? null,
      };
      const outcome = await provider.reportUsage(report);
      const status = outcome.accepted ? "reported" : "skipped";
      const id = existing?.id ?? createId("usage-report");
      await env.DB.prepare(
        `INSERT INTO control_billing_usage_reports (id,workspace_id,day,provider,model_calls,tool_calls,tokens,status,provider_reference,reported_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(workspace_id, day) DO UPDATE SET status=excluded.status,provider=excluded.provider,model_calls=excluded.model_calls,
           tool_calls=excluded.tool_calls,tokens=excluded.tokens,provider_reference=excluded.provider_reference,reported_at=excluded.reported_at`,
      )
        .bind(
          id,
          workspaceId,
          day,
          provider.id,
          report.modelCalls,
          report.toolCalls,
          report.tokens,
          status,
          outcome.reference,
          outcome.accepted ? now : null,
          now,
        )
        .run();
      return json({
        ok: true,
        report: {
          id,
          status,
          provider: provider.id,
          reportedAt: outcome.accepted ? now : null,
          ...report,
        },
      });
    }
    return json({ ok: false, code: "not_found", error: "Not found" }, { status: 404 });
  } catch (error) {
    return failureResponse(error);
  }
};

/** Unauthenticated provider webhook; the provider module proves the sender before anything is read. */
export const handleBillingWebhookIngress = async (
  request: Request,
  env: Env,
  providerId: string,
) => {
  const provider = billingProviderFor(env, billingCatalog.plans);
  if (provider.id !== providerId || provider.id === "manual")
    return json({ ok: false, code: "not_found", error: "Not found" }, { status: 404 });
  const rawBody = await request.text();
  if (rawBody.length > 256 * 1024)
    return json(
      { ok: false, code: "payload_too_large", error: "Webhook body is too large" },
      { status: 413 },
    );
  const event = await provider.verifyWebhook(request, rawBody);
  if (!event)
    return json({ ok: false, code: "unauthorized", error: "Unauthorized" }, { status: 401 });
  return json(await applyBillingEvent(env, event));
};

export const applyBillingEvent = async (env: Env, event: BillingEvent) => {
  if (event.type === "ignored") return { ok: true, applied: false, reason: event.reason };
  const now = new Date().toISOString();
  const current = await selectSubscription(env, event.workspaceId);
  const planId = event.planId ?? current?.planId ?? billingCatalog.defaultPlanId;
  if (!findPlan(planId)) return { ok: true, applied: false, reason: "plan_unknown" };
  await env.DB.batch([
    ...applySubscriptionStatements(env, {
      workspaceId: event.workspaceId,
      planId,
      status: event.status,
      provider: "stripe",
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
      currentPeriodEnd: event.currentPeriodEnd,
      seats: event.seats ?? undefined,
      now,
    }),
    recordEvent(
      env,
      null,
      event.workspaceId,
      `Subscription ${event.status} on ${planId}.`,
      { planId, eventId: event.eventId, status: event.status },
      now,
    ),
  ]);
  return { ok: true, applied: true, planId, status: event.status };
};
