# @operloom/workbench-client

Framework-neutral TypeScript client for Operloom product APIs. It is used
by the web workbench and is suitable for independent React web clients. Native
consumers are future work on the `codex/mobile-wip` branch.

```ts
import { createWorkbenchClient } from "@operloom/workbench-client";

const client = createWorkbenchClient({
  baseUrl: "https://assistant.example.com",
  getAccessToken: () => auth.getAccessToken({ minValidityMs: 60_000 }),
  client: { platform: "web", version: "1.0.0" },
});

const { agents } = await client.agents.list();
```

The package supplies runtime-validated clients for sessions, threads,
workspaces, agents, workflows, History, approvals, connections, actions,
managed state, devices, and notification preferences. It also defines the
stable chat/realtime contracts and an exactly-once pending-turn controller.

Authentication remains application-owned. Omit `getAccessToken` for a
same-origin WorkOS cookie session; provide it for public browser or native
bearer clients. The package never stores credentials, owns UI/cache state, or
contains service secrets. Invalid successful responses fail closed as a
`WorkbenchClientError` with `code: "invalid_response"` without exposing the
response body.

This package is private and initially unpublished. From the repository, run
`pnpm workbench client pack` to create checked archives and a checksum manifest
under `output/workbench-client-distribution/`.

See the [frontend integration guide](https://github.com/dawi369/operloom/blob/main/docs/frontend-integration.md).
