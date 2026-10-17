import { forgetCloudflareMemory } from "@/lib/workbench/control-plane-client/memory";
import { workbenchJson } from "@/lib/workbench/route-handler";

export const runtime = "nodejs";

export const DELETE = async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  return workbenchJson(() => forgetCloudflareMemory(id), "Memory forget failed");
};
