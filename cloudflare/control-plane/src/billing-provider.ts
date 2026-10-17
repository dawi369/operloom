import type { BillingPlan, BillingProviderId, SubscriptionStatus } from "./billing-plans";
import type { Env } from "./types";

/**
 * One interface, one external module. The Worker owns the subscription row; a
 * provider only moves money and reports verified events back.
 */
export type BillingEvent =
  | {
      type: "subscription.changed";
      provider: Exclude<BillingProviderId, "manual">;
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
        provider: "stripe",
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
        provider: "stripe",
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

const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

/**
 * Polar signs with Standard Webhooks: base64 HMAC-SHA256 over `id.timestamp.body` under the
 * `webhook-signature` header (`v1,<sig>` entries), bounded by `webhook-timestamp`.
 */
export const verifyPolarSignature = async (
  headers: Headers,
  rawBody: string,
  secret: string,
  now = Date.now(),
  toleranceMs = 5 * 60_000,
) => {
  const id = headers.get("webhook-id");
  const timestamp = Number(headers.get("webhook-timestamp"));
  const signatures = (headers.get("webhook-signature") ?? "")
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("v1,"))
    .map((entry) => entry.slice(3));
  if (!id || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now - timestamp * 1000) > toleranceMs) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = base64(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${id}.${timestamp}.${rawBody}`)),
  );
  return signatures.some((signature) => constantTimeEqual(signature, expected));
};

const polarStatus = (status: unknown): SubscriptionStatus => {
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

/** Maps a verified Polar event; plans are matched by product id, the workspace by metadata or external customer id. */
export const mapPolarEvent = (event: unknown, plans: readonly BillingPlan[]): BillingEvent => {
  const envelope = (event ?? {}) as Record<string, unknown>;
  const type = String(envelope.type ?? "");
  const eventId =
    string((envelope.data as Record<string, unknown> | undefined)?.id) ?? `polar:${type}`;
  const data = (envelope.data ?? {}) as Record<string, unknown>;
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  const customer = (data.customer ?? {}) as Record<string, unknown>;
  if (!type.startsWith("subscription."))
    return { type: "ignored", eventId, reason: `unhandled_${type || "event"}` };
  const workspaceId = string(metadata.workspaceId) ?? string(customer.external_id);
  if (!workspaceId) return { type: "ignored", eventId, reason: "subscription_without_workspace" };
  const productId =
    string(data.product_id) ?? string((data.product as Record<string, unknown> | undefined)?.id);
  const planId =
    plans.find((plan) => plan.providerPrices?.polar === productId)?.id ?? string(metadata.planId);
  const revoked = type === "subscription.revoked" || type === "subscription.canceled";
  return {
    type: "subscription.changed",
    provider: "polar",
    workspaceId,
    planId,
    status: revoked ? "cancelled" : polarStatus(data.status),
    providerCustomerId: string(data.customer_id) ?? string(customer.id),
    providerSubscriptionId: string(data.id),
    currentPeriodEnd: typeof data.current_period_end === "string" ? data.current_period_end : null,
    seats: null,
    eventId,
  };
};

export const createPolarBillingProvider = (
  env: Pick<Env, "POLAR_ACCESS_TOKEN" | "POLAR_WEBHOOK_SECRET" | "POLAR_API_BASE_URL">,
  plans: readonly BillingPlan[],
  fetcher: typeof fetch = fetch,
): BillingProvider => {
  const accessToken = env.POLAR_ACCESS_TOKEN?.trim() ?? "";
  const webhookSecret = env.POLAR_WEBHOOK_SECRET?.trim() ?? "";
  const baseUrl = (env.POLAR_API_BASE_URL?.trim() || "https://api.polar.sh").replace(/\/$/, "");
  const call = async (path: string, body: Record<string, unknown>) => {
    if (!accessToken)
      throw Object.assign(new Error("Polar is not configured."), {
        code: "billing_provider_unconfigured",
      });
    const response = await fetcher(`${baseUrl}/v1${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok)
      throw Object.assign(new Error("Polar request failed."), {
        code: `polar_http_${response.status}`,
        status: 502,
      });
    return parsed;
  };
  return {
    id: "polar",
    async createCheckout(input) {
      const product = input.plan.providerPrices?.polar;
      if (!product) return null;
      const session = await call("/checkouts/", {
        products: [product],
        success_url: input.successUrl,
        external_customer_id: input.workspaceId,
        ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
        metadata: { workspaceId: input.workspaceId, planId: input.plan.id },
      });
      return typeof session.url === "string" ? { url: session.url } : null;
    },
    async createPortal(input) {
      const session = await call("/customer-sessions/", { customer_id: input.providerCustomerId });
      return typeof session.customer_portal_url === "string"
        ? { url: session.customer_portal_url }
        : null;
    },
    async verifyWebhook(request, rawBody) {
      if (!webhookSecret || !(await verifyPolarSignature(request.headers, rawBody, webhookSecret)))
        return null;
      try {
        return mapPolarEvent(JSON.parse(rawBody), plans);
      } catch {
        return null;
      }
    },
    async reportUsage(report) {
      const ingested = await call("/events/ingest", {
        events: [
          {
            name: "operloom_tokens",
            external_customer_id: report.workspaceId,
            metadata: {
              day: report.day,
              tokens: report.tokens,
              model_calls: report.modelCalls,
              tool_calls: report.toolCalls,
            },
          },
        ],
      });
      return {
        accepted: true,
        reference:
          typeof ingested.inserted === "number" ? `${report.workspaceId}:${report.day}` : null,
      };
    },
  };
};

export const billingProviderFor = (env: Env, plans: readonly BillingPlan[]): BillingProvider => {
  switch (env.OPERLOOM_BILLING_PROVIDER?.trim()) {
    case "stripe":
      return createStripeBillingProvider(env, plans);
    case "polar":
      return createPolarBillingProvider(env, plans);
    default:
      return manualBillingProvider;
  }
};
