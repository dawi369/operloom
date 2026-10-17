import { confirmCloudflareMemory } from "@/lib/workbench/control-plane-client/memory";
import { workbenchJson } from "@/lib/workbench/route-handler";

export const runtime = "nodejs";

export const POST = async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  return workbenchJson(() => confirmCloudflareMemory(id), "Memory confirm failed");
};
