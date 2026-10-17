import { rememberCloudflareMemory } from "@/lib/workbench/control-plane-client/memory";
import { workbenchJson } from "@/lib/workbench/route-handler";

export const runtime = "nodejs";

export const PUT = async (
  request: Request,
  context: { params: Promise<{ kind: string; key: string }> },
) => {
  const { kind, key } = await context.params;
  const body = await request.json();
  return workbenchJson(() => rememberCloudflareMemory(kind, key, body), "Memory write failed");
};
