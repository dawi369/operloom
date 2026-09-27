import { z } from "zod";

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(128);
const receipt = z.object({
  id,
  agentId: id,
  packId: id,
  fromVersion: id,
  toVersion: id,
  fromRevision: revision,
  toRevision: revision,
  committedAt: z.string(),
});
export const publicUpgradeContracts = {
  "POST /workbench/package-upgrades": {
    status: 200,
    request: z
      .object({
        targetVersion: id,
        expectedRevision: revision.max(Number.MAX_SAFE_INTEGER - 1),
        idempotencyKey: id,
      })
      .strict(),
    response: z.object({ ok: z.literal(true), upgrade: receipt }),
  },
  "GET /workbench/package-snapshots": {
    status: 200,
    query: z
      .object({
        beforeRevision: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict(),
    response: z.object({
      ok: z.literal(true),
      agentId: id,
      currentRevision: revision,
      currentVersion: id,
      availableVersion: id.nullable(),
      snapshots: z.array(
        z.object({
          revision,
          packId: id,
          packVersion: id,
          snapshot: z.record(z.string(), z.unknown()),
          createdAt: z.string(),
        }),
      ),
      nextBeforeRevision: revision.optional(),
    }),
  },
} as const;
export type PackageUpgradeInput = z.infer<
  (typeof publicUpgradeContracts)["POST /workbench/package-upgrades"]["request"]
>;
export type PackageUpgradeResponse = z.infer<
  (typeof publicUpgradeContracts)["POST /workbench/package-upgrades"]["response"]
>;
export type PackageSnapshotsResponse = z.infer<
  (typeof publicUpgradeContracts)["GET /workbench/package-snapshots"]["response"]
>;
export const findPublicUpgradeContract = (method: string, path: string) =>
  publicUpgradeContracts[`${method} ${path}` as keyof typeof publicUpgradeContracts];
export const publicUpgradeOpenApiOperation = (method: string, path: string) => {
  const contract = findPublicUpgradeContract(method, path);
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
        description: "Canonical result",
        content: {
          "application/json": { schema: z.toJSONSchema(contract.response) },
        },
      },
      default: { description: "Failure with code, error and requestId" },
    },
  };
};

export const publicUpgradeOpenApiQueryParameters = (
  method: string,
  path: string,
): Array<{ name: string; in: "query"; required: boolean; schema: unknown }> => {
  const contract = findPublicUpgradeContract(method, path);
  if (!contract || !("query" in contract)) return [];
  const schema = z.toJSONSchema(contract.query);
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    in: "query",
    required: false,
    schema: property,
  }));
};
