import { z } from "zod";
const count = z.number().int().min(0).max(10000);
const tokens = z.number().int().min(0).max(100000000);
export const runtimeBudgetLimitsSchema = z
  .object({
    dailyModelCalls: count,
    dailyToolCalls: count,
    dailyTokens: tokens,
    runModelCalls: count,
    runToolCalls: count,
    runTokens: tokens,
    concurrentOperations: z.number().int().min(0).max(100),
  })
  .strict();
export type RuntimeBudgetLimits = z.infer<typeof runtimeBudgetLimitsSchema>;
const policy = z.object({
  version: z.number().int().nonnegative(),
  limits: runtimeBudgetLimitsSchema,
});
const usage = z.object({
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  knownTokens: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  activeOperations: z.number().int().nonnegative(),
  unresolvedOperations: z.number().int().nonnegative(),
  fixtureTokens: z.number().int().nonnegative(),
});
export const publicBudgetContracts = {
  "GET /workbench/usage": {
    status: 200,
    query: z
      .object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().max(128).optional(),
      })
      .strict(),
    response: z.object({
      ok: z.literal(true),
      nextCursor: z.string().optional(),
      reservations: z.array(
        z.object({
          id: z.string(),
          userId: z.string(),
          agentId: z.string(),
          runId: z.string(),
          runKind: z.enum(["workflow", "chat"]),
          budgetRunId: z.string(),
          budgetRunKind: z.enum(["workflow", "chat"]),
          kind: z.enum(["model", "tool"]),
          status: z.enum(["reserved", "settled", "unknown"]),
          estimatedInputTokens: z.number().int().nonnegative(),
          reservedTokens: z.number().int().nonnegative(),
          inputTokens: z.number().int().nonnegative().nullable(),
          outputTokens: z.number().int().nonnegative().nullable(),
          usageSource: z.enum(["provider", "fixture", "unreported"]),
          errorCode: z.string().nullable(),
          createdAt: z.string(),
          expiresAt: z.string(),
          settledAt: z.string().nullable(),
        }),
      ),
    }),
  },
  "GET /workbench/budgets": {
    status: 200,
    response: z.object({ ok: z.literal(true), policy: policy.nullable(), day: z.string(), usage }),
  },
  "PUT /workbench/budgets": {
    status: 200,
    request: z
      .object({
        expectedVersion: z.number().int().nonnegative(),
        idempotencyKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
        limits: runtimeBudgetLimitsSchema,
      })
      .strict(),
    response: z.object({ ok: z.literal(true), policy }),
  },
} as const;
export type RuntimeBudgetSnapshot = z.infer<
  (typeof publicBudgetContracts)["GET /workbench/budgets"]["response"]
>;
export type RuntimeBudgetUpdate = z.infer<
  (typeof publicBudgetContracts)["PUT /workbench/budgets"]["request"]
>;
export type RuntimeBudgetUpdated = z.infer<
  (typeof publicBudgetContracts)["PUT /workbench/budgets"]["response"]
>;
export type RuntimeUsageQuery = z.input<
  (typeof publicBudgetContracts)["GET /workbench/usage"]["query"]
>;
export type RuntimeUsageResponse = z.infer<
  (typeof publicBudgetContracts)["GET /workbench/usage"]["response"]
>;
export const publicBudgetOpenApiQueryParameters = (
  method: string,
  path: string,
): Array<{ name: string; in: "query"; required: boolean; schema: unknown }> => {
  const contract = findPublicBudgetContract(method, path);
  if (!contract || !("query" in contract)) return [];
  const schema = z.toJSONSchema(contract.query);
  return Object.entries(schema.properties ?? {}).map(([name, definition]) => ({
    name,
    in: "query",
    required: schema.required?.includes(name) ?? false,
    schema: definition,
  }));
};
export const findPublicBudgetContract = (method: string, path: string) =>
  publicBudgetContracts[`${method} ${path}` as keyof typeof publicBudgetContracts];
export const publicBudgetOpenApiOperation = (method: string, path: string) => {
  const contract = findPublicBudgetContract(method, path);
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
            description: "Canonical workspace resource budget",
            content: { "application/json": { schema: z.toJSONSchema(contract.response) } },
          },
          default: { description: "Failure with code, error and requestId" },
        },
      }
    : null;
};
