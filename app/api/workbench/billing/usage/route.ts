import { getCloudflareBillingUsage } from "@/lib/workbench/control-plane-client/billing";
import { workbenchJson } from "@/lib/workbench/route-handler";

export const runtime = "nodejs";

export const GET = (request: Request) =>
  workbenchJson(
    () => getCloudflareBillingUsage(new URL(request.url).search),
    "Billing usage failed",
  );
