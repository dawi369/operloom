import { z } from "zod";

/** Workspace-wide audit feed for owners and admins: every control-plane event, with its actor. */
export const adminEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  summary: z.string(),
  actorUserId: z.string(),
  actorLabel: z.string(),
  agentId: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type AdminEvent = z.infer<typeof adminEventSchema>;

export const publicAdminContracts = {
  "GET /admin/events": {
    status: 200,
    query: z
      .object({
        /** Exact event type, or a prefix ending in `.` such as `memory.`. */
        type: z.string().max(80).optional(),
        userId: z.string().optional(),
        /** Case-insensitive match against summary and target id. */
        q: z.string().max(120).optional(),
        /** Return events older than this event id (cursor paging). */
        before: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .strict(),
    response: z.object({
      ok: z.literal(true),
      events: z.array(adminEventSchema),
      /** Distinct event types seen in this workspace, for filter menus. */
      types: z.array(z.string()),
      nextBefore: z.string().nullable(),
    }),
  },
} as const;

export const findPublicAdminContract = (method: string, path: string) =>
  publicAdminContracts[`${method} ${path}` as keyof typeof publicAdminContracts];

export const publicAdminOpenApiQueryParameters = (method: string, path: string) => {
  const contract = findPublicAdminContract(method, path);
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

export const publicAdminOpenApiOperation = (method: string, path: string) => {
  const contract = findPublicAdminContract(method, path);
  return contract
    ? {
        responses: {
          [String(contract.status)]: {
            description: "Canonical result",
            content: { "application/json": { schema: z.toJSONSchema(contract.response) } },
          },
          default: { description: "Failure with code, error and requestId" },
        },
      }
    : {};
};
