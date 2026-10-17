import { z } from "zod";

export const memoryKindSchema = z.enum(["goal", "preference", "watchlist", "conclusion", "note"]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;
const memoryStatus = z.enum(["active", "proposed", "archived"]);
const memorySource = z.enum(["user", "model", "workflow"]);
const content = z.record(z.string(), z.unknown());

export const memoryRecordSchema = z.object({
  id: z.string(),
  kind: memoryKindSchema,
  key: z.string(),
  title: z.string(),
  content,
  source: memorySource,
  status: memoryStatus,
  agentId: z.string().nullable(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

const single = z.object({ ok: z.literal(true), record: memoryRecordSchema });

export const publicMemoryContracts = {
  "GET /workbench/memory": {
    status: 200,
    query: z
      .object({
        kind: memoryKindSchema.optional(),
        status: z.enum(["active", "proposed", "archived", "all"]).optional(),
        /** `user` lists only user-wide records; default includes this agent's records too. */
        scope: z.enum(["user", "agent"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .strict(),
    response: z.object({
      ok: z.literal(true),
      records: z.array(memoryRecordSchema),
      limits: z.object({
        recordBytes: z.number(),
        activeRecords: z.number(),
        totalBytes: z.number(),
      }),
    }),
  },
  "PUT /workbench/memory/{kind}/{key}": {
    status: 200,
    request: z
      .object({
        title: z.string().min(1).max(160),
        content,
        scope: z.enum(["user", "agent"]).optional(),
      })
      .strict(),
    response: single,
  },
  "POST /workbench/memory/{id}/confirm": { status: 200, response: single },
  "DELETE /workbench/memory/{id}": { status: 200, response: single },
} as const;

export const findPublicMemoryContract = (method: string, path: string) =>
  publicMemoryContracts[`${method} ${path}` as keyof typeof publicMemoryContracts];

export const publicMemoryOpenApiQueryParameters = (method: string, path: string) => {
  const contract = findPublicMemoryContract(method, path);
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

export const publicMemoryOpenApiOperation = (method: string, path: string) => {
  const contract = findPublicMemoryContract(method, path);
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
            description: "User memory records",
            content: { "application/json": { schema: z.toJSONSchema(contract.response) } },
          },
          default: { description: "Failure with code, error and requestId" },
        },
      }
    : null;
};
