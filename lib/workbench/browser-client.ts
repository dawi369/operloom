import { createWorkbenchClient, createWorkbenchRealtimeAdapter } from "@operloom/workbench-client";

export const browserWorkbenchClient = createWorkbenchClient({
  baseUrl: "",
  client: { platform: "web", version: "0.1.0" },
});

export const browserWorkbenchRealtime = createWorkbenchRealtimeAdapter({
  baseUrl: "",
  client: { platform: "web", version: "0.1.0" },
});
