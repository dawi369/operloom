import { z } from "zod";

const id = z.string().min(1);
const timestamp = z.iso.datetime();
const jsonObject = z.record(z.string(), z.unknown());

export const actionProposalSummarySchema = z
  .object({
    id,
    toolId: id,
    actionType: id,
    status: id,
    summary: z.string(),
    proposal: jsonObject.optional(),
    result: jsonObject.optional(),
    review: z.object({ requestHash: id, expiresAt: timestamp }).nullable().optional(),
    providerOperation: z
      .object({
        id,
        operationId: id,
        version: id,
        status: z.enum(["dispatching", "succeeded", "failed", "outcome_unknown"]),
        output: jsonObject,
        updatedAt: timestamp,
      })
      .nullable()
      .optional(),
    externalReference: z.string().nullable().optional(),
    version: z.number().int().nonnegative(),
    createdAt: timestamp,
    updatedAt: timestamp,
    terminalAt: timestamp.nullable().optional(),
    ledger: z.array(
      z
        .object({
          sequence: z.number().int().nonnegative(),
          status: id,
          summary: z.string(),
          externalReference: z.string().nullable().optional(),
          createdAt: timestamp,
        })
        .passthrough(),
    ),
  })
  .passthrough();

const executionResult = z
  .object({
    proposalId: id,
    status: z.enum(["executed", "reconciled", "failed", "outcome_unknown"]),
    summary: z.string(),
    externalReference: z.string().optional(),
    output: jsonObject.optional(),
  })
  .passthrough();

export const publicActionContracts = {
  "GET /workbench/actions": {
    statuses: [200],
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }).strict(),
    response: z.object({ ok: z.literal(true), proposals: z.array(actionProposalSummarySchema) }),
  },
  "POST /workbench/actions/{id}/execute": {
    statuses: [202],
    response: z.object({
      ok: z.literal(false),
      code: z.literal("approval_required"),
      proposalId: id,
      approvalRequest: z.object({
        id,
        status: z.literal("requested"),
        requestHash: id,
        expiresAt: timestamp,
      }),
      run: z.object({ id, workflowIntentId: id, status: z.literal("interrupted") }),
    }),
  },
  "POST /workbench/actions/{id}/reconcile": {
    statuses: [200, 202],
    response: z.object({ ok: z.boolean(), result: executionResult }),
  },
} as const;

export type ActionProposalsResponse = z.infer<
  (typeof publicActionContracts)["GET /workbench/actions"]["response"]
>;
export type ActionRequestResponse = z.infer<
  (typeof publicActionContracts)["POST /workbench/actions/{id}/execute"]["response"]
>;
export type ActionReconciliationResponse = z.infer<
  (typeof publicActionContracts)["POST /workbench/actions/{id}/reconcile"]["response"]
>;

export const findPublicActionContract = (method: string, path: string) => {
  const template = path.replace(
    /^\/workbench\/actions\/[^/]+\/(execute|reconcile)$/,
    "/workbench/actions/{id}/$1",
  );
  return publicActionContracts[`${method} ${template}` as keyof typeof publicActionContracts];
};

export const publicActionOpenApiQueryParameters = (
  method: string,
  path: string,
): Array<{ name: string; in: "query"; required: boolean; schema: unknown }> => {
  const contract = findPublicActionContract(method, path);
  if (!contract || !("query" in contract)) return [];
  const schema = z.toJSONSchema(contract.query, { io: "input" });
  return Object.entries(schema.properties ?? {}).map(([name, definition]) => ({
    name,
    in: "query",
    required: schema.required?.includes(name) ?? false,
    schema: definition,
  }));
};

export const publicActionOpenApiOperation = (method: string, path: string) => {
  const contract = findPublicActionContract(method, path);
  return contract
    ? {
        responses: {
          ...Object.fromEntries(
            contract.statuses.map((status) => [
              String(status),
              {
                description:
                  status === 202
                    ? "Approval requested or reconciliation still unresolved"
                    : "Canonical action evidence",
                content: { "application/json": { schema: z.toJSONSchema(contract.response) } },
              },
            ]),
          ),
          default: { description: "Failure with code, error and requestId" },
        },
      }
    : null;
};
