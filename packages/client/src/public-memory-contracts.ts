import { z } from "zod";

export const memoryKindSchema = z.enum(["goal", "preference", "watchlist", "conclusion", "note"]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;
const memoryStatus = z.enum(["active", "proposed", "archived"]);
const memorySource = z.enum(["user", "model", "workflow"]);
const content = z.record(z.string(), z.unknown());
const memoryScope = z.enum(["user", "agent", "workspace"]);
const targetId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);
export const memoryTargetSchema = z.object({ type: targetId, id: targetId });

export const memoryRecordSchema = z.object({
  id: z.string(),
  kind: memoryKindSchema,
  key: z.string(),
  title: z.string(),
  content,
  source: memorySource,
  status: memoryStatus,
  scope: memoryScope,
  agentId: z.string().nullable(),
  target: memoryTargetSchema.nullable(),
  /** Set for model and workflow records under a TTL; archived automatically when passed. */
  expiresAt: z.string().nullable(),
  /** Content observations such as `contact`; secrets and card numbers are refused on write. */
  flags: z.array(z.string()),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

const single = z.object({ ok: z.literal(true), record: memoryRecordSchema });

/** Admin view: every record in the workspace, with who it belongs to. */
export const adminMemoryRecordSchema = memoryRecordSchema.extend({
  userId: z.string(),
  userLabel: z.string(),
});
export type AdminMemoryRecord = z.infer<typeof adminMemoryRecordSchema>;
const memoryPolicySchema = z.object({
  autoActivate: z.array(memoryKindSchema),
  ttlDays: z.record(memoryKindSchema, z.number().nullable()),
});
export type MemoryPolicyView = z.infer<typeof memoryPolicySchema>;

export const publicMemoryContracts = {
  "GET /workbench/memory": {
    status: 200,
    query: z
      .object({
        kind: memoryKindSchema.optional(),
        status: z.enum(["active", "proposed", "archived", "all"]).optional(),
        /** `user` lists only user-wide records; `workspace` only shared ones; default includes this agent's records too. */
        scope: memoryScope.optional(),
        targetType: targetId.optional(),
        targetId: targetId.optional(),
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
        scope: memoryScope.optional(),
        target: memoryTargetSchema.optional(),
      })
      .strict(),
    response: single,
  },
  "POST /workbench/memory/{id}/confirm": { status: 200, response: single },
  "DELETE /workbench/memory/{id}": { status: 200, response: single },
  "GET /admin/memory": {
    status: 200,
    query: z
      .object({
        status: z.enum(["active", "proposed", "archived", "all"]).optional(),
        kind: memoryKindSchema.optional(),
        userId: z.string().optional(),
        /** Case-insensitive match against title, key and content. */
        q: z.string().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .strict(),
    response: z.object({
      ok: z.literal(true),
      records: z.array(adminMemoryRecordSchema),
      members: z.array(z.object({ userId: z.string(), label: z.string() })),
      /** The active agent's effective policy, so admins see why a record waited. */
      policy: memoryPolicySchema,
      /** Non-archived records and bytes per member, against `limits`. */
      usage: z.array(
        z.object({ userId: z.string(), activeRecords: z.number(), totalBytes: z.number() }),
      ),
      limits: z.object({
        recordBytes: z.number(),
        activeRecords: z.number(),
        totalBytes: z.number(),
      }),
    }),
  },
  "PATCH /admin/memory/{id}": {
    status: 200,
    request: z
      .object({
        title: z.string().min(1).max(160).optional(),
        content: content.optional(),
        kind: memoryKindSchema.optional(),
        status: memoryStatus.optional(),
        target: memoryTargetSchema.nullable().optional(),
        /** ISO timestamp, or null to make the record permanent. */
        expiresAt: z.string().nullable().optional(),
      })
      .strict(),
    response: z.object({ ok: z.literal(true), record: adminMemoryRecordSchema }),
  },
  "POST /admin/memory/bulk-archive": {
    status: 200,
    request: z
      .object({
        status: z.enum(["active", "proposed"]).optional(),
        kind: memoryKindSchema.optional(),
        userId: z.string().optional(),
        target: memoryTargetSchema.optional(),
        /** Only records not updated within this many days. */
        olderThanDays: z.number().int().min(0).max(3650).optional(),
      })
      .strict()
      .refine((filter) => Object.keys(filter).length > 0, "At least one filter is required."),
    response: z.object({ ok: z.literal(true), archived: z.number() }),
  },
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
