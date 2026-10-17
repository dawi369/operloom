import { getCloudflareBilling } from "@/lib/workbench/control-plane-client/billing";
import { workbenchJson } from "@/lib/workbench/route-handler";

export const runtime = "nodejs";

export const GET = () => workbenchJson(getCloudflareBilling, "Billing failed");
