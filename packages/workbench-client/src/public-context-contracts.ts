import { z } from "zod";
const id = z.string().min(1);
const source = z.object({
  id,
  binding: id,
  version: id,
  trust: z.enum(["trusted", "retrieved", "untrusted"]),
  required: z.boolean(),
  status: z.enum(["fresh", "stale", "missing", "invalid", "failed"]),
  observedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  provenance: z.array(z.object({ reference: id, version: id.optional() })).optional(),
});
export const publicContextContracts = {
  "GET /workbench/context-snapshots": {
    status: 200,
    query: z
      .object({
        runId: id.max(128),
        runKind: z.enum(["workflow", "chat"]),
        afterRevision: z.coerce.number().int().min(0).max(128).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict(),
    response: z.object({
      ok: z.literal(true),
      snapshots: z
        .array(
          z.object({
            id,
            captureKey: id,
            revision: z.number().int().min(0).max(128),
            stepId: id.nullable(),
            status: z.enum(["ready", "blocked"]),
            capturedAt: id,
          }),
        )
        .max(50),
      nextAfterRevision: z.number().int().min(0).max(128).optional(),
    }),
  },
  "GET /workbench/context-snapshots/{id}": {
    status: 200,
    response: z.object({
      ok: z.literal(true),
      snapshot: z.object({
        id,
        runId: id,
        runKind: z.enum(["workflow", "chat"]),
        target: z.enum(["simulation", "external"]),
        agentRevision: z.number().int().nonnegative(),
        packId: id,
        packVersion: id,
        runtimeVersion: id,
        configurationHash: id,
        inputHash: id,
        contentHash: id,
        captureKey: id.optional(),
        revision: z.number().int().min(0).max(128).optional(),
        stepId: id.optional(),
        capturedAt: id,
        status: z.enum(["ready", "blocked"]),
        sources: z.array(source).max(16),
      }),
    }),
  },
} as const;
export type ContextSnapshotResponse = z.infer<
  (typeof publicContextContracts)["GET /workbench/context-snapshots/{id}"]["response"]
>;
export type ContextSnapshotsQuery = {
  runId: string;
  runKind: "workflow" | "chat";
  afterRevision?: number;
  limit?: number;
};
export type ContextSnapshotsResponse = z.infer<
  (typeof publicContextContracts)["GET /workbench/context-snapshots"]["response"]
>;
export const findPublicContextContract = (method: string, path: string) =>
  method === "GET" && path === "/workbench/context-snapshots"
    ? publicContextContracts["GET /workbench/context-snapshots"]
    : method === "GET" && /^\/workbench\/context-snapshots\/[^/]+$/.test(path)
      ? publicContextContracts["GET /workbench/context-snapshots/{id}"]
      : undefined;
export const publicContextOpenApiOperation = (method: string, path: string) => {
  const contract = findPublicContextContract(method, path);
  return contract
    ? {
        responses: {
          "200": {
            description: "Canonical context evidence",
            content: { "application/json": { schema: z.toJSONSchema(contract.response) } },
          },
          default: { description: "Failure with code, error and requestId" },
        },
      }
    : null;
};
export const publicContextOpenApiQueryParameters = (
  method: string,
  path: string,
): Array<{ name: string; in: "query"; required: boolean; schema: unknown }> => {
  const contract = findPublicContextContract(method, path);
  if (!contract || !("query" in contract)) return [];
  const schema = z.toJSONSchema(contract.query, { io: "input" });
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    in: "query",
    required: schema.required?.includes(name) ?? false,
    schema: property,
  }));
};
