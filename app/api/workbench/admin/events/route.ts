import { listCloudflareAdminEvents } from "@/lib/workbench/control-plane-client/memory";
import { workbenchJson } from "@/lib/workbench/route-handler";

export const runtime = "nodejs";

export const GET = (request: Request) =>
  workbenchJson(() => listCloudflareAdminEvents(new URL(request.url).search), "Audit feed failed");
