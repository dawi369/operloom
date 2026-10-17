import { z } from "zod";

import { runtimeBudgetLimitsSchema } from "./public-budget-contracts.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => value.startsWith("https://"), {
    message: "https required",
  });
const planId = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export const billingFeatureSchema = z.enum(["delegation", "notifications.relay", "runner"]);
export type BillingFeature = z.infer<typeof billingFeatureSchema>;
const subscriptionStatus = z.enum(["active", "past_due", "cancelled"]);
const providerId = z.enum(["manual", "stripe", "polar"]);

export const workspaceEntitlementsSchema = z.object({
  planId,
  planLabel: z.string(),
  status: subscriptionStatus,
  limits: runtimeBudgetLimitsSchema,
  features: z.array(billingFeatureSchema),
  seats: z.number().int().min(1),
  provider: providerId,
  subscribed: z.boolean(),
});
export type WorkspaceEntitlements = z.infer<typeof workspaceEntitlementsSchema>;

const subscription = z
  .object({
    planId,
    status: subscriptionStatus,
    provider: providerId,
    hasCustomer: z.boolean(),
    currentPeriodEnd: z.string().nullable(),
    seats: z.number().int().min(1),
    updatedAt: z.string(),
  })
  .nullable();

const plan = z.object({
  id: planId,
  label: z.string(),
  seats: z.number().int().min(1),
  limits: runtimeBudgetLimitsSchema,
  features: z.array(billingFeatureSchema),
  purchasable: z.boolean(),
});

const billingState = z.object({
  ok: z.literal(true),
  provider: providerId,
  entitlements: workspaceEntitlementsSchema,
  subscription,
});
const link = z.object({ ok: z.literal(true), url: z.string().url() });
const usageReport = z.object({
  id: z.string(),
  day,
  status: z.enum(["pending", "reported", "skipped"]),
  provider: providerId,
  reportedAt: z.string().nullable(),
});

export const publicBillingContracts = {
  "GET /workbench/billing": { status: 200, response: billingState },
  "GET /workbench/billing/plans": {
    status: 200,
    response: z.object({ ok: z.literal(true), defaultPlanId: planId, plans: z.array(plan) }),
  },
  "PUT /workbench/billing/plan": {
    status: 200,
    request: z.object({ planId, seats: z.number().int().min(1).max(10_000).optional() }).strict(),
    response: billingState.omit({ provider: true }),
  },
  "POST /workbench/billing/checkout": {
    status: 200,
    request: z.object({ planId, successUrl: httpsUrl, cancelUrl: httpsUrl }).strict(),
    response: link,
  },
  "POST /workbench/billing/portal": {
    status: 200,
    request: z.object({ returnUrl: httpsUrl }).strict(),
    response: link,
  },
  "GET /workbench/billing/usage": {
    status: 200,
    query: z.object({ from: day, to: day }).strict(),
    response: z.object({
      ok: z.literal(true),
      from: day,
      to: day,
      days: z.array(
        z.object({
          day,
          modelCalls: z.number().int().nonnegative(),
          toolCalls: z.number().int().nonnegative(),
          tokens: z.number().int().nonnegative(),
        }),
      ),
      reports: z.array(usageReport.omit({ id: true })),
    }),
  },
  "POST /workbench/billing/usage/report": {
    status: 200,
    request: z.object({ day }).strict(),
    response: z.object({
      ok: z.literal(true),
      replayed: z.boolean().optional(),
      report: usageReport.extend({
        modelCalls: z.number().int().nonnegative().optional(),
        toolCalls: z.number().int().nonnegative().optional(),
        tokens: z.number().int().nonnegative().optional(),
      }),
    }),
  },
} as const;

export const findPublicBillingContract = (method: string, path: string) =>
  publicBillingContracts[`${method} ${path}` as keyof typeof publicBillingContracts];

export const publicBillingOpenApiQueryParameters = (method: string, path: string) => {
  const contract = findPublicBillingContract(method, path);
  if (!contract || !("query" in contract)) return [];
  const schema = z.toJSONSchema(contract.query) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return Object.entries(schema.properties ?? {}).map(([name, definition]) => ({
    name,
    in: "query",
    required: schema.required?.includes(name) ?? false,
    schema: definition,
  }));
};

export const publicBillingOpenApiOperation = (method: string, path: string) => {
  const contract = findPublicBillingContract(method, path);
  return contract
    ? {
        ...("request" in contract
          ? {
              requestBody: {
                required: true,
                content: { "application/json": { schema: z.toJSONSchema(contract.request) } },
              },
            }
          : {}),
        responses: {
          "200": {
            description: "Workspace plan, entitlements and usage",
            content: { "application/json": { schema: z.toJSONSchema(contract.response) } },
          },
          default: { description: "Failure with code, error and requestId" },
        },
      }
    : null;
};
