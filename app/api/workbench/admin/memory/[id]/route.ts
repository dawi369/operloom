import { updateCloudflareAdminMemory } from "@/lib/workbench/control-plane-client/memory";
import { workbenchJson } from "@/lib/workbench/route-handler";

export const runtime = "nodejs";

export const PATCH = async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const body: unknown = await request.json();
  return workbenchJson(() => updateCloudflareAdminMemory(id, body), "Admin memory edit failed");
};
