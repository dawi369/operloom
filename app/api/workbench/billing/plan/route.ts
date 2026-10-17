import { assignCloudflareBillingPlan } from "@/lib/workbench/control-plane-client/billing";
import { workbenchJson } from "@/lib/workbench/route-handler";

export const runtime = "nodejs";

export const PUT = async (request: Request) => {
  const body = await request.json();
  return workbenchJson(() => assignCloudflareBillingPlan(body), "Billing plan failed");
};
