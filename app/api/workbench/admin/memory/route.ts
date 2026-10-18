import { listCloudflareAdminMemory } from "@/lib/workbench/control-plane-client/memory";
import { workbenchJson } from "@/lib/workbench/route-handler";

export const runtime = "nodejs";

export const GET = (request: Request) =>
  workbenchJson(
    () => listCloudflareAdminMemory(new URL(request.url).search),
    "Admin memory failed",
  );
