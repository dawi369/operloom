import type { RuntimeBudgetLimits } from "../../../packages/client/src/public-budget-contracts";

import catalog from "../../../config/billing.json";
import type { Env } from "./types";

/**
 * Plans are policy inputs, not a billing system: a plan is a budget ceiling plus a
 * feature set. Forks edit `config/billing.json`; the Worker never invents a plan.
 */
export const billingFeatures = ["delegation", "notifications.relay", "runner"] as const;
export type BillingFeature = (typeof billingFeatures)[number];
export type BillingProviderId = "manual" | "stripe";
export type SubscriptionStatus = "active" | "past_due" | "cancelled";

export type BillingPlan = {
  id: string;
  label: string;
  seats: number;
  limits: RuntimeBudgetLimits;
  features: readonly BillingFeature[];
  providerPrices?: Partial<Record<BillingProviderId, string>>;
};

export type WorkspaceSubscription = {
  workspaceId: string;
  planId: string;
  status: SubscriptionStatus;
  provider: BillingProviderId;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  seats: number;
  updatedAt: string;
};

export type WorkspaceEntitlements = {
  planId: string;
  planLabel: string;
  status: SubscriptionStatus;
  limits: RuntimeBudgetLimits;
  features: readonly BillingFeature[];
  seats: number;
  provider: BillingProviderId;
  subscribed: boolean;
};

const limitKeys = [
  "dailyModelCalls",
  "dailyToolCalls",
  "dailyTokens",
  "runModelCalls",
  "runToolCalls",
  "runTokens",
  "concurrentOperations",
] as const satisfies readonly (keyof RuntimeBudgetLimits)[];

const isFeature = (value: unknown): value is BillingFeature =>
  typeof value === "string" && (billingFeatures as readonly string[]).includes(value);

const parsePlan = (raw: unknown): BillingPlan => {
  if (!raw || typeof raw !== "object") throw new Error("billing_plan_invalid");
  const plan = raw as Record<string, unknown>;
  if (typeof plan.id !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(plan.id))
    throw new Error("billing_plan_id_invalid");
  const limits = plan.limits as Record<string, unknown> | undefined;
  for (const key of limitKeys) {
    const value = limits?.[key];
    if (!Number.isSafeInteger(value) || (value as number) < 0)
      throw new Error(`billing_plan_limit_invalid:${plan.id}.${key}`);
  }
  const features = Array.isArray(plan.features) ? plan.features : [];
  if (!features.every(isFeature)) throw new Error(`billing_plan_feature_invalid:${plan.id}`);
  const seats = plan.seats ?? 1;
  if (!Number.isSafeInteger(seats) || (seats as number) < 1)
    throw new Error(`billing_plan_seats_invalid:${plan.id}`);
  const prices =
    plan.providerPrices && typeof plan.providerPrices === "object"
      ? Object.fromEntries(
          Object.entries(plan.providerPrices as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
          ),
        )
      : undefined;
  return {
    id: plan.id,
    label: typeof plan.label === "string" && plan.label ? plan.label : plan.id,
    seats: seats as number,
    limits: Object.fromEntries(limitKeys.map((key) => [key, limits![key]])) as RuntimeBudgetLimits,
    features,
    ...(prices && Object.keys(prices).length > 0 ? { providerPrices: prices } : {}),
  };
};

export const loadBillingCatalog = (raw: unknown = catalog) => {
  const source = raw as { defaultPlanId?: unknown; plans?: unknown };
  const plans = Array.isArray(source.plans) ? source.plans.map(parsePlan) : [];
  if (plans.length === 0) throw new Error("billing_catalog_empty");
  if (new Set(plans.map((plan) => plan.id)).size !== plans.length)
    throw new Error("billing_plan_id_duplicate");
  const defaultPlanId =
    typeof source.defaultPlanId === "string" ? source.defaultPlanId : plans[0]!.id;
  if (!plans.some((plan) => plan.id === defaultPlanId))
    throw new Error("billing_default_plan_missing");
  return { defaultPlanId, plans } as const;
};

export const billingCatalog = loadBillingCatalog();

export const findPlan = (planId: string, plans = billingCatalog.plans) =>
  plans.find((plan) => plan.id === planId) ?? null;

export const defaultPlan = () => findPlan(billingCatalog.defaultPlanId)!;

/** The plan is a ceiling: every admin-tuned limit is capped to it. */
export const clampLimitsToPlan = (
  limits: RuntimeBudgetLimits,
  plan: Pick<BillingPlan, "limits">,
): RuntimeBudgetLimits =>
  Object.fromEntries(
    limitKeys.map((key) => [key, Math.min(limits[key], plan.limits[key])]),
  ) as RuntimeBudgetLimits;

export const limitsExceedPlan = (limits: RuntimeBudgetLimits, plan: Pick<BillingPlan, "limits">) =>
  limitKeys.filter((key) => limits[key] > plan.limits[key]);

const rowToSubscription = (row: {
  workspace_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  provider: BillingProviderId;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  current_period_end: string | null;
  seats: number;
  updated_at: string;
}): WorkspaceSubscription => ({
  workspaceId: row.workspace_id,
  planId: row.plan_id,
  status: row.status,
  provider: row.provider,
  providerCustomerId: row.provider_customer_id,
  providerSubscriptionId: row.provider_subscription_id,
  currentPeriodEnd: row.current_period_end,
  seats: row.seats,
  updatedAt: row.updated_at,
});

export const selectSubscription = async (env: Env, workspaceId: string) => {
  const row = await env.DB.prepare(
    "SELECT * FROM control_workspace_subscriptions WHERE workspace_id = ?",
  )
    .bind(workspaceId)
    .first<Parameters<typeof rowToSubscription>[0]>();
  return row ? rowToSubscription(row) : null;
};

/**
 * A cancelled or unknown-plan subscription falls back to the default plan so a
 * workspace is never without a ceiling.
 */
export const entitlementsFor = (
  subscription: WorkspaceSubscription | null,
  plans = billingCatalog.plans,
  fallback = defaultPlan(),
): WorkspaceEntitlements => {
  const active = subscription && subscription.status !== "cancelled";
  const plan = (active && findPlan(subscription.planId, plans)) || fallback;
  return {
    planId: plan.id,
    planLabel: plan.label,
    status: subscription?.status ?? "active",
    limits: plan.limits,
    features: plan.features,
    seats: active ? Math.max(plan.seats, subscription.seats) : plan.seats,
    provider: subscription?.provider ?? "manual",
    subscribed: Boolean(active),
  };
};

export const resolveEntitlements = async (env: Env, workspaceId: string) =>
  entitlementsFor(await selectSubscription(env, workspaceId));

export class EntitlementError extends Error {
  readonly code = "entitlement_required";
  readonly status = 403;
  constructor(
    readonly feature: BillingFeature,
    readonly planId: string,
  ) {
    super(`The ${planId} plan does not include ${feature}.`);
  }
}

export const requireEntitlement = async (
  env: Env,
  workspaceId: string,
  feature: BillingFeature,
) => {
  const entitlements = await resolveEntitlements(env, workspaceId);
  if (!entitlements.features.includes(feature))
    throw new EntitlementError(feature, entitlements.planId);
  return entitlements;
};

/** Writes the subscription and clamps the stored budget policy to the new ceiling in one batch. */
export const applySubscriptionStatements = (
  env: Env,
  input: {
    workspaceId: string;
    planId: string;
    status: SubscriptionStatus;
    provider: BillingProviderId;
    providerCustomerId?: string | null;
    providerSubscriptionId?: string | null;
    currentPeriodEnd?: string | null;
    seats?: number;
    updatedByUserId?: string | null;
    now: string;
  },
) => {
  const plan = findPlan(input.planId);
  if (!plan) throw new Error("billing_plan_unknown");
  const ceiling = plan.limits;
  const clampSql = limitKeys
    .map((key) => `'${key}', MIN(COALESCE(json_extract(limits_json,'$.${key}'), ?), ?)`)
    .join(", ");
  return [
    env.DB.prepare(
      `INSERT INTO control_workspace_subscriptions (workspace_id,plan_id,status,provider,provider_customer_id,provider_subscription_id,current_period_end,seats,updated_by_user_id,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(workspace_id) DO UPDATE SET plan_id=excluded.plan_id,status=excluded.status,provider=excluded.provider,
         provider_customer_id=COALESCE(excluded.provider_customer_id,control_workspace_subscriptions.provider_customer_id),
         provider_subscription_id=COALESCE(excluded.provider_subscription_id,control_workspace_subscriptions.provider_subscription_id),
         current_period_end=excluded.current_period_end,seats=excluded.seats,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`,
    ).bind(
      input.workspaceId,
      input.planId,
      input.status,
      input.provider,
      input.providerCustomerId ?? null,
      input.providerSubscriptionId ?? null,
      input.currentPeriodEnd ?? null,
      Math.max(1, input.seats ?? plan.seats),
      input.updatedByUserId ?? null,
      input.now,
    ),
    env.DB.prepare(
      `UPDATE control_budget_policies SET limits_json = json_object(${clampSql}), version = version + 1, updated_at = ?
       WHERE workspace_id = ?`,
    ).bind(
      ...limitKeys.flatMap((key) => [ceiling[key], ceiling[key]]),
      input.now,
      input.workspaceId,
    ),
  ];
};
