import { z } from "zod";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const id = z.string().min(1).max(256);
const target = z.enum(["simulation", "external"]);
const data = z.record(z.string(), z.unknown());
const pageQuery = z.object({
  target,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});
const page = { ok: z.literal(true), nextCursor: z.string().optional() };
const record = z.object({
  id,
  namespace: identifier,
  kind: identifier,
  key: identifier,
  schemaVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  data,
  updatedAt: z.string(),
});
const entry = z.object({
  id,
  key: identifier,
  commitId: id,
  type: z.enum(["decision", "effect"]),
  data,
  createdAt: z.string(),
});
const delivery = z.object({
  id,
  eventId: identifier,
  commitId: id,
  type: z.string(),
  data,
  status: z.enum(["pending", "delivered", "failed"]),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
});
const migrationDescriptor = z.object({
  id: identifier,
  namespace: identifier,
  kind: identifier,
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
});
const migration = migrationDescriptor.extend({
  planId: identifier.optional(),
  status: z.enum(["running", "completed"]),
  revision: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
});

/** Shared by HTTP handlers, Fetch consumers and OpenAPI. Mutations never accept a raw scope ID. */
export const publicStateContracts = {
  "GET /workbench/state/migrations": {
    status: 200,
    query: pageQuery.strict(),
    response: z.object({
      ...page,
      available: z.array(migrationDescriptor),
      migrations: z.array(migration),
    }),
  },
  "POST /workbench/state/migrations/{id}": {
    status: 202,
    request: z.object({ target }).strict(),
    response: z.object({ ok: z.literal(true), migration }),
  },
  "POST /workbench/state/migrations/{id}/advance": {
    status: 200,
    request: z.object({ target, expectedRevision: z.number().int().nonnegative() }).strict(),
    response: z.object({ ok: z.literal(true), migration }),
  },
  "POST /workbench/state/migrations/{id}/repair": {
    status: 200,
    request: z
      .object({
        target,
        expectedRevision: z.number().int().nonnegative(),
        replacementId: identifier,
        idempotencyKey: identifier,
      })
      .strict(),
    response: z.object({ ok: z.literal(true), migration }),
  },
  "GET /workbench/state/records": {
    status: 200,
    query: pageQuery.extend({ namespace: identifier, kind: identifier }).strict(),
    response: z.object({ ...page, records: z.array(record) }),
  },
  "GET /workbench/state/entries": {
    status: 200,
    query: pageQuery.extend({ type: z.enum(["decision", "effect"]).optional() }).strict(),
    response: z.object({ ...page, entries: z.array(entry) }),
  },
  "GET /workbench/state/deliveries": {
    status: 200,
    query: pageQuery
      .extend({ status: z.enum(["pending", "delivered", "failed"]).optional() })
      .strict(),
    response: z.object({ ...page, deliveries: z.array(delivery) }),
  },
  "POST /workbench/state/deliveries/{id}/retry": {
    status: 202,
    request: z.object({ target, expectedAttempts: z.number().int().nonnegative() }).strict(),
    response: z.object({ ok: z.literal(true), id, status: z.literal("pending") }),
  },
} as const;

type PageInput<T> = Omit<T, "limit"> & { limit?: number };
export type RuntimeStateMigrationQuery = PageInput<
  z.output<(typeof publicStateContracts)["GET /workbench/state/migrations"]["query"]>
>;
export type RuntimeStateMigrationsResponse = z.output<
  (typeof publicStateContracts)["GET /workbench/state/migrations"]["response"]
>;
export type RuntimeStateMigrationResponse = z.output<
  (typeof publicStateContracts)["POST /workbench/state/migrations/{id}"]["response"]
>;
export type RuntimeStateRecordQuery = PageInput<
  z.output<(typeof publicStateContracts)["GET /workbench/state/records"]["query"]>
>;
export type RuntimeStateEntryQuery = PageInput<
  z.output<(typeof publicStateContracts)["GET /workbench/state/entries"]["query"]>
>;
export type RuntimeStateDeliveryQuery = PageInput<
  z.output<(typeof publicStateContracts)["GET /workbench/state/deliveries"]["query"]>
>;
export type RuntimeStateRecordsResponse = z.infer<
  (typeof publicStateContracts)["GET /workbench/state/records"]["response"]
>;
export type RuntimeStateEntriesResponse = z.infer<
  (typeof publicStateContracts)["GET /workbench/state/entries"]["response"]
>;
export type RuntimeStateDeliveriesResponse = z.infer<
  (typeof publicStateContracts)["GET /workbench/state/deliveries"]["response"]
>;

export const findPublicStateContract = (method: string, path: string) =>
  Object.entries(publicStateContracts).find(([key]) => {
    const [verb, template] = key.split(" ");
    return method === verb && new RegExp(`^${template!.replace(/\{\w+\}/g, "[^/]+")}$`).test(path);
  })?.[1];

export const publicStateOpenApiOperation = (method: string, path: string) => {
  const contract = findPublicStateContract(method, path);
  if (!contract) return null;
  return {
    ...("request" in contract
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: z.toJSONSchema(contract.request, { io: "input" }) },
            },
          },
        }
      : {}),
    responses: {
      [contract.status]: {
        description: contract.status === 202 ? "Durable command acceptance" : "Canonical result",
        content: { "application/json": { schema: z.toJSONSchema(contract.response) } },
      },
      default: { description: "Failure with code, error and requestId" },
    },
  };
};

export const publicStateOpenApiQueryParameters = (
  method: string,
  path: string,
): Array<{
  name: string;
  in: "query";
  required: boolean;
  schema: unknown;
}> => {
  const contract = findPublicStateContract(method, path);
  if (!contract || !("query" in contract)) return [];
  const schema = z.toJSONSchema(contract.query);
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    in: "query",
    required: name !== "limit" && (schema.required?.includes(name) ?? false),
    schema: property,
  }));
};
