import type { BillingPlan, BillingProviderId, SubscriptionStatus } from "./billing-plans";
import type { Env } from "./types";

/**
 * One interface, one external module. The Worker owns the subscription row; a
 * provider only moves money and reports verified events back.
 */
export type BillingEvent =
  | {
      type: "subscription.changed";
      workspaceId: string;
      planId: string | null;
      status: SubscriptionStatus;
      providerCustomerId: string | null;
      providerSubscriptionId: string | null;
      currentPeriodEnd: string | null;
      seats: number | null;
      eventId: string;
    }
  | { type: "ignored"; eventId: string; reason: string };

export type UsageReport = {
  workspaceId: string;
  day: string;
  modelCalls: number;
  toolCalls: number;
  tokens: number;
  providerCustomerId: string | null;
};

export type BillingProvider = {
  id: BillingProviderId;
  /** A hosted page that ends in a verified webhook, or null when the provider has none. */
  createCheckout(input: {
    workspaceId: string;
    plan: BillingPlan;
    customerEmail: string | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string } | null>;
  createPortal(input: {
    providerCustomerId: string;
    returnUrl: string;
  }): Promise<{ url: string } | null>;
  /** Returns null when the signature is invalid; the caller answers 401. */
  verifyWebhook(request: Request, rawBody: string): Promise<BillingEvent | null>;
  reportUsage(report: UsageReport): Promise<{ accepted: boolean; reference: string | null }>;
};

export const manualBillingProvider: BillingProvider = {
  id: "manual",
  createCheckout: async () => null,
  createPortal: async () => null,
  verifyWebhook: async () => null,
  reportUsage: async () => ({ accepted: false, reference: null }),
};

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1)
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
};

export const hmacSha256Hex = async (secret: string, payload: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
};

/** Stripe signs `t.body` with the endpoint secret; replay is bounded by the timestamp tolerance. */
export const verifyStripeSignature = async (
  header: string | null,
  rawBody: string,
  secret: string,
  now = Date.now(),
  toleranceMs = 5 * 60_000,
) => {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((part) => part.trim().split("=", 2) as [string, string]),
  );
  const timestamp = Number(parts.t);
  const signatures = header
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now - timestamp * 1000) > toleranceMs) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((signature) => constantTimeEqual(signature, expected));
};

const stripeStatus = (status: unknown): SubscriptionStatus => {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    default:
      return "cancelled";
  }
};

const isoFromUnix = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;

const string = (value: unknown) => (typeof value === "string" && value ? value : null);

/** Maps a verified Stripe event onto the subscription row. Plans are matched by price id. */
export const mapStripeEvent = (event: unknown, plans: readonly BillingPlan[]): BillingEvent => {
  const envelope = (event ?? {}) as Record<string, unknown>;
  const eventId = string(envelope.id) ?? "evt_unknown";
  const object = ((envelope.data as Record<string, unknown> | undefined)?.object ?? {}) as Record<
    string,
    unknown
  >;
  const metadata = (object.metadata ?? {}) as Record<string, unknown>;
  const planFromPrice = (priceId: string | null) =>
    priceId ? (plans.find((plan) => plan.providerPrices?.stripe === priceId)?.id ?? null) : null;
  switch (envelope.type) {
    case "checkout.session.completed": {
      const workspaceId = string(object.client_reference_id) ?? string(metadata.workspaceId);
      if (!workspaceId || object.mode !== "subscription")
        return { type: "ignored", eventId, reason: "checkout_without_workspace" };
      return {
        type: "subscription.changed",
        workspaceId,
        planId: string(metadata.planId),
        status: "active",
        providerCustomerId: string(object.customer),
        providerSubscriptionId: string(object.subscription),
        currentPeriodEnd: null,
        seats: null,
        eventId,
      };
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const workspaceId = string(metadata.workspaceId);
      if (!workspaceId)
        return { type: "ignored", eventId, reason: "subscription_without_workspace" };
      const items = ((object.items as Record<string, unknown> | undefined)?.data ?? []) as Array<
        Record<string, unknown>
      >;
      const first = items[0] ?? {};
      const priceId = string((first.price as Record<string, unknown> | undefined)?.id);
      return {
        type: "subscription.changed",
        workspaceId,
        planId: planFromPrice(priceId) ?? string(metadata.planId),
        status:
          envelope.type === "customer.subscription.deleted"
            ? "cancelled"
            : stripeStatus(object.status),
        providerCustomerId: string(object.customer),
        providerSubscriptionId: string(object.id),
        currentPeriodEnd: isoFromUnix(object.current_period_end),
        seats: typeof first.quantity === "number" ? first.quantity : null,
        eventId,
      };
    }
    default:
      return { type: "ignored", eventId, reason: `unhandled_${String(envelope.type)}` };
  }
};

const form = (fields: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(fields)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );

export const createStripeBillingProvider = (
  env: Pick<Env, "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET">,
  plans: readonly BillingPlan[],
  fetcher: typeof fetch = fetch,
): BillingProvider => {
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? "";
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  const call = async (path: string, fields: Record<string, string | number | undefined>) => {
    if (!secretKey)
      throw Object.assign(new Error("Stripe is not configured."), {
        code: "billing_provider_unconfigured",
      });
    const response = await fetcher(`https://api.stripe.com/v1${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form(fields),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok)
      throw Object.assign(new Error("Stripe request failed."), {
        code: `stripe_http_${response.status}`,
        status: 502,
      });
    return body;
  };
  return {
    id: "stripe",
    async createCheckout(input) {
      const price = input.plan.providerPrices?.stripe;
      if (!price) return null;
      const session = await call("/checkout/sessions", {
        mode: "subscription",
        "line_items[0][price]": price,
        "line_items[0][quantity]": 1,
        client_reference_id: input.workspaceId,
        customer_email: input.customerEmail ?? undefined,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        "metadata[workspaceId]": input.workspaceId,
        "metadata[planId]": input.plan.id,
        "subscription_data[metadata][workspaceId]": input.workspaceId,
        "subscription_data[metadata][planId]": input.plan.id,
      });
      return typeof session.url === "string" ? { url: session.url } : null;
    },
    async createPortal(input) {
      const session = await call("/billing_portal/sessions", {
        customer: input.providerCustomerId,
        return_url: input.returnUrl,
      });
      return typeof session.url === "string" ? { url: session.url } : null;
    },
    async verifyWebhook(request, rawBody) {
      if (!webhookSecret) return null;
      const valid = await verifyStripeSignature(
        request.headers.get("stripe-signature"),
        rawBody,
        webhookSecret,
      );
      if (!valid) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return null;
      }
      return mapStripeEvent(parsed, plans);
    },
    async reportUsage(report) {
      if (!report.providerCustomerId) return { accepted: false, reference: null };
      const event = await call("/billing/meter_events", {
        event_name: "operloom_tokens",
        identifier: `${report.workspaceId}:${report.day}`,
        "payload[stripe_customer_id]": report.providerCustomerId,
        "payload[value]": report.tokens,
      });
      return {
        accepted: true,
        reference: string(event.identifier) ?? `${report.workspaceId}:${report.day}`,
      };
    },
  };
};

export const billingProviderFor = (env: Env, plans: readonly BillingPlan[]): BillingProvider =>
  env.OPERLOOM_BILLING_PROVIDER?.trim() === "stripe"
    ? createStripeBillingProvider(env, plans)
    : manualBillingProvider;
