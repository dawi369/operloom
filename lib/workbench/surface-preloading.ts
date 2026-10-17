import { workbenchQueryKeys, type QueryClient, type WorkbenchClient } from "@operloom/react";

export type WorkbenchPreloadSurface = "agents" | "history" | "workspace";

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

  // Accounts and workspaces are account-scoped, so the switcher opens populated after a switch too.
  if (surface === "workspace") {
    return Promise.all([
      queryClient.prefetchQuery({
        queryKey: workbenchQueryKeys.accounts,
        queryFn: ({ signal }) => client.workspaces.listAccounts({ signal }),
      }),
      queryClient.prefetchQuery({
        queryKey: workbenchQueryKeys.workspaces,
        queryFn: ({ signal }) => client.workspaces.list({ signal }),
      }),
    ]);
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
