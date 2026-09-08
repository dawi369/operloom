import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClientConfig,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type {
  ChatSessionResponse,
  WorkbenchClient,
  WorkbenchSessionEvent,
} from "@operloom/workbench-client";

const ClientContext = createContext<WorkbenchClient | null>(null);
const currentWorkspace = "__current__";
const tenantId = (workspaceId?: string | null) => workspaceId || currentWorkspace;

export const workbenchQueryKeys = {
  all: ["workbench"] as const,
  accounts: ["workbench", "accounts"] as const,
  workspaces: ["workbench", "workspaces"] as const,
  tenant: (workspaceId?: string | null) => ["workbench", "tenant", tenantId(workspaceId)] as const,
  session: (workspaceId?: string | null) =>
    [...workbenchQueryKeys.tenant(workspaceId), "session"] as const,
  threads: (workspaceId: string | null | undefined, status: "active" | "archived") =>
    [...workbenchQueryKeys.tenant(workspaceId), "threads", status] as const,
  agents: (workspaceId?: string | null) =>
    [...workbenchQueryKeys.tenant(workspaceId), "agents"] as const,
  workflows: (workspaceId?: string | null) =>
    [...workbenchQueryKeys.tenant(workspaceId), "workflows"] as const,
  runLists: (workspaceId?: string | null) =>
    [...workbenchQueryKeys.tenant(workspaceId), "runs"] as const,
  runs: (workspaceId?: string | null, limit = 20) =>
    [...workbenchQueryKeys.runLists(workspaceId), { limit }] as const,
  runDetails: (workspaceId?: string | null) =>
    [...workbenchQueryKeys.tenant(workspaceId), "run"] as const,
  run: (workspaceId: string | null | undefined, runId: string) =>
    [...workbenchQueryKeys.runDetails(workspaceId), runId] as const,
  artifactLists: (workspaceId?: string | null) =>
    [...workbenchQueryKeys.tenant(workspaceId), "artifacts"] as const,
  artifacts: (workspaceId?: string | null, limit = 20) =>
    [...workbenchQueryKeys.artifactLists(workspaceId), { limit }] as const,
  approvals: (workspaceId?: string | null) =>
    [...workbenchQueryKeys.tenant(workspaceId), "approvals"] as const,
  connections: (workspaceId?: string | null) =>
    [...workbenchQueryKeys.tenant(workspaceId), "connections"] as const,
  actionLists: (workspaceId?: string | null) =>
    [...workbenchQueryKeys.tenant(workspaceId), "actions"] as const,
  actions: (workspaceId?: string | null, limit = 20) =>
    [...workbenchQueryKeys.actionLists(workspaceId), { limit }] as const,
  managedState: (
    workspaceId?: string | null,
    input: { namespace?: string; type?: string; limit?: number } = {},
  ) => [...workbenchQueryKeys.tenant(workspaceId), "managed-state", input] as const,
  notificationPreferences: (workspaceId?: string | null) =>
    [...workbenchQueryKeys.tenant(workspaceId), "notification-preferences"] as const,
} as const;

export const createWorkbenchQueryClient = (config: QueryClientConfig = {}) =>
  new QueryClient({
    ...config,
    defaultOptions: {
      queries: { retry: 1, staleTime: 30_000, ...config.defaultOptions?.queries },
      mutations: { retry: false, ...config.defaultOptions?.mutations },
    },
  });

export function WorkbenchClientProvider({
  client,
  queryClient,
  children,
}: {
  client: WorkbenchClient;
  queryClient?: QueryClient;
  children: ReactNode;
}) {
  const [ownedQueryClient] = useState(() => queryClient ?? createWorkbenchQueryClient());
  return createElement(
    ClientContext.Provider,
    { value: client },
    createElement(QueryClientProvider, { client: ownedQueryClient }, children),
  );
}

export const useWorkbenchClient = () => {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useWorkbenchClient must be used inside WorkbenchClientProvider");
  return client;
};

export const useWorkbenchQueryClient = () => useQueryClient();

type TenantInput = { workspaceId?: string | null; enabled?: boolean };
const enabled = (input?: TenantInput) => input?.enabled ?? true;

export const useWorkbenchAccounts = (isEnabled = true) => {
  const client = useWorkbenchClient();
  return useQuery({
    queryKey: workbenchQueryKeys.accounts,
    queryFn: ({ signal }) => client.workspaces.listAccounts({ signal }),
    enabled: isEnabled,
  });
};

export const useWorkbenchWorkspaces = (isEnabled = true) => {
  const client = useWorkbenchClient();
  return useQuery({
    queryKey: workbenchQueryKeys.workspaces,
    queryFn: ({ signal }) => client.workspaces.list({ signal }),
    enabled: isEnabled,
  });
};

export const useWorkbenchSession = (input: TenantInput = {}) => {
  const client = useWorkbenchClient();
  return useQuery({
    queryKey: workbenchQueryKeys.session(input.workspaceId),
    queryFn: ({ signal }) => client.session.get({ signal }),
    enabled: enabled(input),
  });
};

export const useWorkbenchThreads = (
  status: "active" | "archived" = "active",
  input: TenantInput = {},
) => {
  const client = useWorkbenchClient();
  return useQuery({
    queryKey: workbenchQueryKeys.threads(input.workspaceId, status),
    queryFn: ({ signal }) => client.threads.list(status, { signal }),
    enabled: enabled(input),
  });
};

export const useWorkbenchAgents = (isEnabled = true, workspaceId?: string | null) => {
  const client = useWorkbenchClient();
  return useQuery({
    queryKey: workbenchQueryKeys.agents(workspaceId),
    queryFn: ({ signal }) => client.agents.list({ signal }),
    enabled: isEnabled,
  });
};

export const useWorkbenchWorkflows = (input: TenantInput = {}) => {
  const client = useWorkbenchClient();
  return useQuery({
    queryKey: workbenchQueryKeys.workflows(input.workspaceId),
    queryFn: ({ signal }) => client.workflows.list({ signal }),
    enabled: enabled(input),
  });
};

export const useWorkbenchRuns = (input: TenantInput & { limit?: number } = {}) => {
  const client = useWorkbenchClient();
  const limit = input.limit ?? 20;
  return useQuery({
    queryKey: workbenchQueryKeys.runs(input.workspaceId, limit),
    queryFn: ({ signal }) => client.history.listRuns({ limit, signal }),
    enabled: enabled(input),
  });
};

export const useWorkbenchRun = (runId: string | null, input: TenantInput = {}) => {
  const client = useWorkbenchClient();
  return useQuery({
    queryKey: workbenchQueryKeys.run(input.workspaceId, runId ?? "none"),
    queryFn: ({ signal }) => client.history.getRun(runId!, { signal }),
    enabled: Boolean(runId) && enabled(input),
  });
};

export const useWorkbenchArtifacts = (input: TenantInput & { limit?: number } = {}) => {
  const client = useWorkbenchClient();
  const limit = input.limit ?? 20;
  return useQuery({
    queryKey: workbenchQueryKeys.artifacts(input.workspaceId, limit),
    queryFn: ({ signal }) => client.history.listArtifacts({ limit, signal }),
    enabled: enabled(input),
  });
};

export const useWorkbenchApprovals = (input: TenantInput = {}) => {
  const client = useWorkbenchClient();
  return useQuery({
    queryKey: workbenchQueryKeys.approvals(input.workspaceId),
    queryFn: ({ signal }) => client.approvals.list({ signal }),
    enabled: enabled(input),
  });
};

export const useWorkbenchConnections = (input: TenantInput = {}) => {
  const client = useWorkbenchClient();
  return useQuery({
    queryKey: workbenchQueryKeys.connections(input.workspaceId),
    queryFn: ({ signal }) => client.connections.list({ signal }),
    enabled: enabled(input),
  });
};

export const useWorkbenchActions = (input: TenantInput & { limit?: number } = {}) => {
  const client = useWorkbenchClient();
  const limit = input.limit ?? 20;
  return useQuery({
    queryKey: workbenchQueryKeys.actions(input.workspaceId, limit),
    queryFn: ({ signal }) => client.actions.list({ limit, signal }),
    enabled: enabled(input),
  });
};

export const useWorkbenchManagedState = (
  input: TenantInput & { namespace?: string; type?: string; limit?: number } = {},
) => {
  const client = useWorkbenchClient();
  const filter = { namespace: input.namespace, type: input.type, limit: input.limit };
  return useQuery({
    queryKey: workbenchQueryKeys.managedState(input.workspaceId, filter),
    queryFn: ({ signal }) => client.managedState.list({ ...filter, signal }),
    enabled: enabled(input),
  });
};

export const useWorkbenchNotificationPreferences = (input: TenantInput = {}) => {
  const client = useWorkbenchClient();
  return useQuery({
    queryKey: workbenchQueryKeys.notificationPreferences(input.workspaceId),
    queryFn: ({ signal }) => client.notificationPreferences.get({ signal }),
    enabled: enabled(input),
  });
};

const invalidate = (queryClient: QueryClient, keys: readonly QueryKey[]) =>
  Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));

export const invalidateWorkbenchQueries = invalidate;

export const clearWorkbenchTenantCache = (queryClient: QueryClient, workspaceId?: string | null) =>
  queryClient.removeQueries({ queryKey: workbenchQueryKeys.tenant(workspaceId) });

export const clearAllWorkbenchTenantCaches = (queryClient: QueryClient) =>
  queryClient.removeQueries({
    predicate: (query) =>
      query.queryKey[0] === workbenchQueryKeys.all[0] && query.queryKey[1] === "tenant",
  });

const threadKeys = (workspaceId?: string | null) => [
  workbenchQueryKeys.session(workspaceId),
  workbenchQueryKeys.threads(workspaceId, "active"),
  workbenchQueryKeys.threads(workspaceId, "archived"),
];

export const workbenchSessionEventInvalidations = (
  event: Pick<WorkbenchSessionEvent, "type">,
  workspaceId?: string | null,
): readonly QueryKey[] => {
  if (event.type.startsWith("session.thread") || event.type === "session.threads.refreshed") {
    return threadKeys(workspaceId);
  }
  if (event.type === "session.snapshot" || event.type === "session.agent.handoff") {
    return [
      ...threadKeys(workspaceId),
      workbenchQueryKeys.agents(workspaceId),
      workbenchQueryKeys.workflows(workspaceId),
      workbenchQueryKeys.connections(workspaceId),
      workbenchQueryKeys.managedState(workspaceId),
    ];
  }
  if (event.type === "workflow.run.updated" || event.type === "tool.run.updated") {
    return [
      workbenchQueryKeys.runLists(workspaceId),
      workbenchQueryKeys.artifactLists(workspaceId),
    ];
  }
  if (event.type === "approval.updated") {
    return [
      workbenchQueryKeys.approvals(workspaceId),
      workbenchQueryKeys.runLists(workspaceId),
      workbenchQueryKeys.runDetails(workspaceId),
      workbenchQueryKeys.actionLists(workspaceId),
    ];
  }
  if (event.type === "action.updated") {
    return [
      workbenchQueryKeys.actionLists(workspaceId),
      workbenchQueryKeys.approvals(workspaceId),
      workbenchQueryKeys.runLists(workspaceId),
      workbenchQueryKeys.runDetails(workspaceId),
    ];
  }
  if (event.type.startsWith("chat.run.")) return threadKeys(workspaceId);
  return [];
};

export const usePublishWorkbenchSession = (session: ChatSessionResponse | null) => {
  const queryClient = useQueryClient();
  useEffect(() => {
    const workspaceId = session?.workspace?.id;
    if (!session || !workspaceId) return;
    queryClient.setQueryData(workbenchQueryKeys.session(workspaceId), session);
    queryClient.setQueryData(workbenchQueryKeys.session(), session);
    queryClient.setQueryData(workbenchQueryKeys.threads(workspaceId, "active"), {
      ok: true,
      status: "active",
      threads: session.threads ?? [],
    });
  }, [queryClient, session]);
};

export const useWorkbenchSessionEventInvalidation = (
  event: Pick<WorkbenchSessionEvent, "type"> | null,
  workspaceId?: string | null,
) => {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!event) return;
    void invalidate(queryClient, workbenchSessionEventInvalidations(event, workspaceId));
  }, [event, queryClient, workspaceId]);
};

const useTenantMutation = <TVariables, TData>(input: {
  mutationFn: (client: WorkbenchClient, variables: TVariables) => Promise<TData>;
  invalidations: (variables: TVariables, data: TData) => readonly QueryKey[];
}) => {
  const client = useWorkbenchClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: TVariables) => input.mutationFn(client, variables),
    onSuccess: (data, variables) => invalidate(queryClient, input.invalidations(variables, data)),
  });
};

export const useRunWorkflow = (workspaceId?: string | null) =>
  useTenantMutation<
    { workflowType: string; input?: Record<string, unknown>; executionMode?: "dry_run" },
    Awaited<ReturnType<WorkbenchClient["workflows"]["run"]>>
  >({
    mutationFn: (client, input) => client.workflows.run(input.workflowType, input),
    invalidations: () => [
      workbenchQueryKeys.runLists(workspaceId),
      workbenchQueryKeys.artifactLists(workspaceId),
      workbenchQueryKeys.managedState(workspaceId),
    ],
  });

export const useActivateWorkspace = () => {
  const client = useWorkbenchClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => client.workspaces.activate(workspaceId),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: workbenchQueryKeys.all });
      clearAllWorkbenchTenantCaches(queryClient);
    },
    onSuccess: async () => {
      await invalidate(queryClient, [workbenchQueryKeys.accounts, workbenchQueryKeys.workspaces]);
    },
  });
};

export const useActivateAgent = (workspaceId?: string | null) =>
  useTenantMutation<
    { agentId?: string; packId?: string },
    Awaited<ReturnType<WorkbenchClient["agents"]["activate"]>>
  >({
    mutationFn: (client, input) =>
      input.packId
        ? client.agents.instantiatePack(input.packId)
        : client.agents.activate(input.agentId!),
    invalidations: () => [
      workbenchQueryKeys.session(workspaceId),
      workbenchQueryKeys.agents(workspaceId),
      workbenchQueryKeys.workflows(workspaceId),
      workbenchQueryKeys.connections(workspaceId),
      workbenchQueryKeys.managedState(workspaceId),
    ],
  });

export const useCreateThread = (workspaceId?: string | null) =>
  useTenantMutation<void, Awaited<ReturnType<WorkbenchClient["threads"]["create"]>>>({
    mutationFn: (client) => client.threads.create(),
    invalidations: () => threadKeys(workspaceId),
  });

export const useActivateThread = (workspaceId?: string | null) =>
  useTenantMutation<string, Awaited<ReturnType<WorkbenchClient["threads"]["activate"]>>>({
    mutationFn: (client, threadId) => client.threads.activate(threadId),
    invalidations: () => threadKeys(workspaceId),
  });

export const useUpdateThread = (workspaceId?: string | null) =>
  useTenantMutation<
    { threadId: string; title?: string; status?: "active" | "archived" | "deleted" },
    Awaited<ReturnType<WorkbenchClient["threads"]["update"]>>
  >({
    mutationFn: (client, input) =>
      client.threads.update(input.threadId, { title: input.title, status: input.status }),
    invalidations: () => threadKeys(workspaceId),
  });

export const useRunAction = (action: "cancel" | "retry", workspaceId?: string | null) =>
  useTenantMutation<string, Awaited<ReturnType<WorkbenchClient["history"][typeof action]>>>({
    mutationFn: (client, runId) => client.history[action](runId),
    invalidations: (runId) => [
      workbenchQueryKeys.runLists(workspaceId),
      workbenchQueryKeys.run(workspaceId, runId),
      workbenchQueryKeys.artifactLists(workspaceId),
    ],
  });

export const useApprovalAction = (action: "approve" | "deny", workspaceId?: string | null) =>
  useTenantMutation<
    { approvalId: string; reason?: string },
    Awaited<ReturnType<WorkbenchClient["approvals"][typeof action]>>
  >({
    mutationFn: (client, input) =>
      action === "deny"
        ? client.approvals.deny(input.approvalId, input.reason)
        : client.approvals.approve(input.approvalId),
    invalidations: () => [
      workbenchQueryKeys.approvals(workspaceId),
      workbenchQueryKeys.runLists(workspaceId),
      workbenchQueryKeys.runDetails(workspaceId),
      workbenchQueryKeys.actionLists(workspaceId),
    ],
  });

export const useConnectionAction = (
  action: "authorize" | "submitCredential" | "refresh" | "health" | "revoke",
  workspaceId?: string | null,
) =>
  useTenantMutation<
    { connectionId: string; secret?: string },
    Awaited<ReturnType<WorkbenchClient["connections"][typeof action]>>
  >({
    mutationFn: (client, input) => {
      if (action === "submitCredential") {
        return client.connections.submitCredential(input.connectionId, input.secret ?? "");
      }
      return client.connections[action](input.connectionId) as ReturnType<
        WorkbenchClient["connections"][typeof action]
      >;
    },
    invalidations: () => [
      workbenchQueryKeys.connections(workspaceId),
      workbenchQueryKeys.workflows(workspaceId),
      workbenchQueryKeys.actionLists(workspaceId),
    ],
  });

export const useProposalAction = (action: "execute" | "reconcile", workspaceId?: string | null) =>
  useTenantMutation<string, Awaited<ReturnType<WorkbenchClient["actions"][typeof action]>>>({
    mutationFn: (client, proposalId) => client.actions[action](proposalId),
    invalidations: () => [
      workbenchQueryKeys.actionLists(workspaceId),
      workbenchQueryKeys.approvals(workspaceId),
      workbenchQueryKeys.runLists(workspaceId),
    ],
  });

export const useUpdateNotificationPreferences = (workspaceId?: string | null) =>
  useTenantMutation<
    { approvalRequired: boolean; terminalOutcomes: boolean },
    Awaited<ReturnType<WorkbenchClient["notificationPreferences"]["update"]>>
  >({
    mutationFn: (client, input) => client.notificationPreferences.update(input),
    invalidations: () => [workbenchQueryKeys.notificationPreferences(workspaceId)],
  });

export type { WorkbenchClient } from "@operloom/workbench-client";
export type { QueryClient } from "@tanstack/react-query";
