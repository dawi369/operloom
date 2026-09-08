"use client";

import { useCallback } from "react";
import {
  useWorkbenchThreads,
  useWorkbenchQueryClient,
  workbenchQueryKeys,
  type QueryClient,
} from "@operloom/workbench-react";

import type { ChatThreadsResponse, ChatThreadSummary } from "@/lib/workbench/workbench-types";
import type { ArchivedThreadsLoadInput } from "./session-runtime";

const updateArchivedThreads = (
  queryClient: QueryClient,
  workspaceId: string | undefined,
  updater: (threads: ChatThreadSummary[]) => ChatThreadSummary[],
) => {
  queryClient.setQueryData<ChatThreadsResponse>(
    workbenchQueryKeys.threads(workspaceId, "archived"),
    (current) => ({
      ...current,
      ok: current?.ok ?? true,
      status: "archived",
      threads: updater(current?.threads ?? []),
    }),
  );
};

export const useArchivedThreadsResource = (input: { workspaceId?: string; preload: boolean }) => {
  const queryClient = useWorkbenchQueryClient();
  const query = useWorkbenchThreads("archived", {
    workspaceId: input.workspaceId,
    enabled: Boolean(input.workspaceId && input.preload),
  });
  const { refetch } = query;

  const load = useCallback(
    async (loadInput: ArchivedThreadsLoadInput = {}) => {
      if (!input.workspaceId) return;
      const key = workbenchQueryKeys.threads(input.workspaceId, "archived");
      if (!loadInput.force && queryClient.getQueryData(key) !== undefined) return;
      const result = await refetch();
      if (result.error) throw result.error;
    },
    [input.workspaceId, queryClient, refetch],
  );

  const refreshIfLoaded = useCallback(() => {
    const key = workbenchQueryKeys.threads(input.workspaceId, "archived");
    if (queryClient.getQueryData(key) === undefined) return;
    void queryClient.invalidateQueries({ queryKey: key });
  }, [input.workspaceId, queryClient]);

  const setArchivedThreads = useCallback(
    (updater: (threads: ChatThreadSummary[]) => ChatThreadSummary[]) =>
      updateArchivedThreads(queryClient, input.workspaceId, updater),
    [input.workspaceId, queryClient],
  );

  return {
    archivedThreads: query.data?.threads ?? [],
    setArchivedThreads,
    isLoadingArchivedThreads: query.isPending && query.fetchStatus === "fetching",
    archivedThreadsError: query.error?.message ?? null,
    loadArchivedThreads: load,
    refreshArchivedThreadsIfLoaded: refreshIfLoaded,
  };
};
