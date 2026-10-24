import { z } from "zod";
import { publicMessageSchema } from "./messages.js";

const id = z.string().min(1);
const ok = z.literal(true);

/** These schemas drive OpenAPI, Worker input checks and Fetch response validation. */
export const publicChatContracts = {
  "POST /chat/threads": {
    status: 201,
    response: z.object({ ok, threadId: id, sessionId: id, agentId: id }),
  },
  "POST /chat/threads/{id}/turns": {
    status: 202,
    request: z
      .object({
        text: z.string().trim().min(1).max(8000),
        clientTurnId: id.max(128).optional(),
        /** `steer` joins the running turn at its next step; `turn` (default) waits its turn. */
        mode: z.enum(["turn", "steer"]).optional(),
      })
      .strict(),
    response: z.object({
      ok,
      messageId: id,
      threadId: id,
      /** `queued` means another turn holds the thread; the command runs when it finishes. */
      status: z.enum(["accepted", "queued"]),
      mode: z.enum(["turn", "steer"]).optional(),
      queuePosition: z.number().int().min(1).optional(),
      duplicate: z.boolean().optional(),
      commandId: id.optional(),
    }),
    idempotency: true,
  },
  "GET /chat/threads/{id}/messages": {
    status: 200,
    response: z.object({
      ok,
      messages: z.array(publicMessageSchema),
      run: z.object({ id, status: z.string() }).nullable().optional(),
    }),
  },
  "POST /chat/threads/{id}/cancel": {
    status: 200,
    response: z.object({ ok, cancelled: z.boolean() }),
  },
  "GET /chat/commands/{id}": {
    status: 200,
    response: z.object({
      ok,
      command: z.object({
        id,
        threadId: id,
        messageId: id,
        status: z.enum(["queued", "pending", "running", "completed", "failed", "cancelled"]),
        mode: z.enum(["turn", "steer"]).optional(),
        queuePosition: z.number().int().min(0).optional(),
        runId: id.nullable(),
        queuedAt: z.string().nullable().optional(),
        acceptedAt: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string(),
        errorCode: z.string().nullable(),
      }),
    }),
  },
} as const;

export type ChatCommandResponse = z.infer<
  (typeof publicChatContracts)["GET /chat/commands/{id}"]["response"]
>;

export const findPublicChatContract = (method: string, path: string) =>
  Object.entries(publicChatContracts).find(([key]) => {
    const [verb, template] = key.split(" ");
    return method === verb && new RegExp(`^${template!.replace(/\{\w+\}/g, "[^/]+")}$`).test(path);
  })?.[1];

export const publicChatOpenApiOperation = (method: string, path: string) => {
  const contract = findPublicChatContract(method, path);
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
        description: contract.status === 202 ? "Durable acceptance" : "Canonical result",
        content: { "application/json": { schema: z.toJSONSchema(contract.response) } },
      },
      default: { description: "Failure with code, error and requestId" },
    },
  };
};

export type ChatTurnSubmitResponse = z.infer<
  (typeof publicChatContracts)["POST /chat/threads/{id}/turns"]["response"]
>;
