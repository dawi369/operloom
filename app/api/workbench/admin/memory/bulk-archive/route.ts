import { bulkArchiveCloudflareAdminMemory } from "@/lib/workbench/control-plane-client/memory";
import { workbenchJson } from "@/lib/workbench/route-handler";

export const runtime = "nodejs";

export const POST = async (request: Request) => {
  const body: unknown = await request.json();
  return workbenchJson(() => bulkArchiveCloudflareAdminMemory(body), "Bulk archive failed");
};
