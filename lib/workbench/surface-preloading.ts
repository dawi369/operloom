import {
  workbenchQueryKeys,
  type QueryClient,
  type WorkbenchClient,
} from "@operloom/workbench-react";

export type WorkbenchPreloadSurface = "agents" | "history";

/** Warm bounded list data without pulling run details, artifact bodies, or runner-backed content. */
export const preloadWorkbenchSurface = ({
  surface,
  client,
  queryClient,
  workspaceId,
}: {
  surface: WorkbenchPreloadSurface;
  client: WorkbenchClient;
  queryClient: QueryClient;
  workspaceId?: string | null;
}) => {
  if (surface === "agents") {
    return queryClient.prefetchQuery({
      queryKey: workbenchQueryKeys.agents(workspaceId),
      queryFn: ({ signal }) => client.agents.list({ signal }),
    });
  }

  return Promise.all([
    queryClient.prefetchQuery({
      queryKey: workbenchQueryKeys.runs(workspaceId, 20),
      queryFn: ({ signal }) => client.history.listRuns({ limit: 20, signal }),
    }),
    queryClient.prefetchQuery({
      queryKey: workbenchQueryKeys.artifacts(workspaceId, 20),
      queryFn: ({ signal }) => client.history.listArtifacts({ limit: 20, signal }),
    }),
    queryClient.prefetchQuery({
      queryKey: workbenchQueryKeys.actions(workspaceId, 20),
      queryFn: ({ signal }) => client.actions.list({ limit: 20, signal }),
    }),
  ]);
};
