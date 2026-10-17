import { listCloudflareMemory } from "@/lib/workbench/control-plane-client/memory";
import { workbenchJson } from "@/lib/workbench/route-handler";

export const runtime = "nodejs";

export const GET = (request: Request) =>
  workbenchJson(() => listCloudflareMemory(new URL(request.url).search), "Memory failed");
