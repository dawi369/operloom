import { z } from "zod";

export const fleetAgentStatusSchema = z.enum([
  "idle",
  "running",
  "waiting_approval",
  "erroring",
  "paused",
]);
export type FleetAgentStatus = z.infer<typeof fleetAgentStatusSchema>;

export const fleetUpdateSchema = z.object({
  id: z.string(),
  at: z.string(),
  text: z.string(),
  /** `agent.update` for the agent's own lines; run, artifact, approval and memory events otherwise. */
  type: z.string(),
  runId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type FleetUpdate = z.infer<typeof fleetUpdateSchema>;

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
  updates: z.array(fleetUpdateSchema),
});
export type FleetAgent = z.infer<typeof fleetAgentSchema>;

export const publicFleetContracts = {
  "GET /workbench/fleet": {
    status: 200,
    query: z.object({
      /** Status lines per agent, 0 to 20; default 3. */
      updates: z.coerce.number().int().min(0).max(20).optional(),
      /** Characters per line, 40 to 280; default 140. */
      chars: z.coerce.number().int().min(40).max(280).optional(),
    }),
    response: z.object({
      ok: z.literal(true),
      generatedAt: z.string(),
      agents: z.array(fleetAgentSchema),
    }),
  },
  "GET /workbench/fleet/{agentId}": {
    status: 200,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      /** Id of the last update seen; the page continues after it. */
      before: z.string().optional(),
      chars: z.coerce.number().int().min(40).max(280).optional(),
    }),
    response: z.object({
      ok: z.literal(true),
      agent: z.object({ id: z.string(), name: z.string() }),
      updates: z.array(fleetUpdateSchema),
      nextBefore: z.string().nullable(),
    }),
  },
} as const;

export const findPublicFleetContract = (method: string, path: string) =>
  publicFleetContracts[`${method} ${path}` as keyof typeof publicFleetContracts];

export const publicFleetOpenApiQueryParameters = (method: string, path: string) => {
  const contract = findPublicFleetContract(method, path);
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

export const publicFleetOpenApiOperation = (method: string, path: string) => {
  const contract = findPublicFleetContract(method, path);
  return contract
    ? {
        responses: {
          "200": {
            description: "Live status of agents in the workspace",
            content: { "application/json": { schema: z.toJSONSchema(contract.response) } },
          },
          default: { description: "Failure with code, error and requestId" },
        },
      }
    : null;
};
