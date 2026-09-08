import { createWorkbenchClient } from "@operloom/workbench-client";
import { workbenchQueryKeys } from "@operloom/workbench-react";

const client = createWorkbenchClient({
  baseUrl: "https://example.invalid",
  client: { platform: "web", version: "zero-context" },
  fetch,
});

document.querySelector("#app")!.textContent = String(
  Boolean(client.session && workbenchQueryKeys.session),
);
