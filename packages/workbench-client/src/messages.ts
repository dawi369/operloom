import { z } from "zod";

export const publicContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("artifact"),
    artifactId: z.string().min(1),
    title: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool"),
    toolCallId: z.string().min(1),
    name: z.string(),
    status: z.enum(["pending", "completed", "failed"]),
  }),
]);
export const publicMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.array(publicContentBlockSchema),
});
export type PublicContentBlock = z.infer<typeof publicContentBlockSchema>;
export type PublicMessage = z.infer<typeof publicMessageSchema>;

/** Stored wire messages are translated at the edge; reasoning and provider internals are omitted. */
export const toPublicMessage = (value: Record<string, unknown>): PublicMessage | null => {
  if (typeof value.id !== "string" || !["user", "assistant", "system"].includes(String(value.role)))
    return null;
  const content: PublicContentBlock[] = [];
  for (const part of Array.isArray(value.parts) ? value.parts : []) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string")
      content.push({ type: "text", text: part.text });
    else if (
      typeof part.type === "string" &&
      (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
      typeof part.toolCallId === "string"
    ) {
      content.push({
        type: "tool",
        toolCallId: part.toolCallId,
        name: typeof part.toolName === "string" ? part.toolName : part.type.slice(5),
        status:
          part.state === "output-error"
            ? "failed"
            : part.state === "output-available"
              ? "completed"
              : "pending",
      });
    }
  }
  return { id: value.id, role: value.role as PublicMessage["role"], content };
};
