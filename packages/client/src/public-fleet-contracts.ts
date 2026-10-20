import { z } from "zod";

export const fleetAgentStatusSchema = z.enum([
  "idle",
  "running",
  "waiting_approval",
  "erroring",
  "paused",
]);
export type FleetAgentStatus = z.infer<typeof fleetAgentStatusSchema>;

export const fleetAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: fleetAgentStatusSchema,
  effectTarget: z.enum(["simulation", "external"]),
  isDefault: z.boolean(),
  currentRun: z
    .object({
      id: z.string(),
      stage: z.string().nullable(),
      startedAt: z.string(),
      workflowType: z.string().nullable(),
    })
    .nullable(),
  lastRun: z
    .object({
      id: z.string(),
      status: z.string(),
      finishedAt: z.string(),
      summary: z.string().nullable(),
      workflowType: z.string().nullable(),
    })
    .nullable(),
  openApprovals: z.number().int().min(0),
  runsToday: z.number().int().min(0),
  failedToday: z.number().int().min(0),
  tokensToday: z.number().int().min(0),
  triggers: z.object({
    enabled: z.number().int().min(0),
    paused: z.number().int().min(0),
    nextTickAt: z.string().nullable(),
    lastTickAt: z.string().nullable(),
  }),
  lastError: z
    .object({ runId: z.string(), at: z.string(), summary: z.string().nullable() })
    .nullable(),
});
export type FleetAgent = z.infer<typeof fleetAgentSchema>;

export const publicFleetContracts = {
  "GET /workbench/fleet": {
    status: 200,
    response: z.object({
      ok: z.literal(true),
      generatedAt: z.string(),
      agents: z.array(fleetAgentSchema),
    }),
  },
} as const;

export const findPublicFleetContract = (method: string, path: string) =>
  publicFleetContracts[`${method} ${path}` as keyof typeof publicFleetContracts];

export const publicFleetOpenApiOperation = (method: string, path: string) => {
  const contract = findPublicFleetContract(method, path);
  return contract
    ? {
        responses: {
          "200": {
            description: "Live status of every agent in the workspace",
            content: { "application/json": { schema: z.toJSONSchema(contract.response) } },
          },
          default: { description: "Failure with code, error and requestId" },
        },
      }
    : null;
};
