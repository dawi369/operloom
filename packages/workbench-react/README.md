# @operloom/workbench-react

UI-agnostic React Query bindings for `@operloom/workbench-client`. The
package works with React DOM and React Native and is the shared resource layer
used by the bundled web and Expo applications.

```tsx
import {
  WorkbenchClientProvider,
  createWorkbenchQueryClient,
  useWorkbenchAgents,
} from "@operloom/workbench-react";

const queryClient = createWorkbenchQueryClient();

export function App() {
  return (
    <WorkbenchClientProvider client={client} queryClient={queryClient}>
      <Agents />
    </WorkbenchClientProvider>
  );
}

function Agents() {
  const agents = useWorkbenchAgents();
  // Render with web or native primitives.
  return null;
}
```

It owns stable tenant-aware query keys, abort propagation, cache fencing,
mutation invalidation, reversible thread updates, and realtime-event
invalidation. Chat transport and session reconciliation remain
application-owned; publish canonical session snapshots with
`usePublishWorkbenchSession`.

This package is private and initially unpublished. Run
`pnpm workbench client pack` to produce portable archives with the headless
client.

See the [frontend integration guide](https://github.com/dawi369/operloom/blob/main/docs/frontend-integration.md).
