import { reportCloudflareBillingUsage } from "@/lib/workbench/control-plane-client/billing";
import { workbenchJson } from "@/lib/workbench/route-handler";

export const runtime = "nodejs";

export const POST = async (request: Request) => {
  const body = await request.json();
  return workbenchJson(() => reportCloudflareBillingUsage(body), "Billing usage report failed");
};
