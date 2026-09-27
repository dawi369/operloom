import { createWorkbenchClient } from "@operloom/client";
import { workbenchQueryKeys } from "@operloom/react";

const client = createWorkbenchClient({
  baseUrl: "https://example.invalid",
  client: { platform: "web", version: "zero-context" },
  fetch,
});

document.querySelector("#app")!.textContent = String(
  Boolean(client.session && workbenchQueryKeys.session),
);
