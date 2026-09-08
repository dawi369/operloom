"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useActivateWorkspace,
  useWorkbenchAccounts,
  useWorkbenchWorkspaces,
} from "@operloom/workbench-react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  ArrowLeftIcon,
  Building2Icon,
  CheckCircle2Icon,
  DownloadIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
  ShieldCheckIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { readJsonResponse } from "@/lib/workbench/read-json-response";
import type {
  CloudflareDataJobResponse,
  CloudflareRetentionPolicyResponse,
  CloudflareWorkspaceMembersResponse,
  WorkbenchAccountContextResponse,
  WorkspaceMemberSummary,
  WorkspaceSummary,
} from "@/lib/workbench/workbench-types";

const workspacesPath = "/api/workbench/workspaces";
type WorkbenchAccount = NonNullable<WorkbenchAccountContextResponse["accounts"]>[number];
const retentionFields = [
  ["chatMessageRetentionDays", "Chat messages", 1, 3650],
  ["runPayloadRetentionDays", "Run and tool payloads", 1, 3650],
  ["artifactRetentionDays", "Artifacts", 1, 3650],
  ["operationalEventRetentionDays", "Operational events", 1, 3650],
  ["runtimeTraceRetentionDays", "Runtime traces", 1, 3650],
  ["auditActionRetentionDays", "Audit and action ledger", 365, 3650],
] as const;

export function WorkbenchWorkspacePanel({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { switchToOrganization } = useAuth();
  const accountsQuery = useWorkbenchAccounts(open);
  const workspacesQuery = useWorkbenchWorkspaces(open);
  const { refetch: refetchAccounts } = accountsQuery;
  const { refetch: refetchWorkspaces } = workspacesQuery;
  const { mutateAsync: activateWorkspace } = useActivateWorkspace();
  const accounts = (accountsQuery.data?.accounts ?? []) as WorkbenchAccount[];
  const workspaces = (workspacesQuery.data?.workspaces ?? []) as WorkspaceSummary[];
  const activeWorkspaceId = workspacesQuery.data?.activeWorkspaceId ?? null;
  const [members, setMembers] = useState<WorkspaceMemberSummary[]>([]);
  const [availableMembers, setAvailableMembers] = useState<WorkspaceMemberSummary[]>([]);
  const [currentMembership, setCurrentMembership] = useState<WorkspaceMemberSummary | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [memberToAdd, setMemberToAdd] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retention, setRetention] = useState<CloudflareRetentionPolicyResponse["policy"] | null>(
    null,
  );
  const [dataJob, setDataJob] = useState<CloudflareDataJobResponse["job"] | null>(null);
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [view, setView] = useState<"switcher" | "settings">("switcher");

  const canManageWorkspace =
    currentMembership?.status === "active" &&
    (currentMembership.role === "owner" || currentMembership.role === "admin");

  const loadPanel = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accountResult, workspaceResult] = await Promise.all([
        refetchAccounts(),
        refetchWorkspaces(),
      ]);
      if (accountResult.error) throw accountResult.error;
      if (workspaceResult.error) throw workspaceResult.error;
      const workspaceBody = workspaceResult.data;
      if (!workspaceBody) throw new Error("Workspace response was empty");
      const nextActiveWorkspaceId = workspaceBody.activeWorkspaceId ?? null;

      if (!nextActiveWorkspaceId) {
        setMembers([]);
        setAvailableMembers([]);
        setCurrentMembership(null);
        return;
      }

      const response = await fetch(
        `${workspacesPath}/${encodeURIComponent(nextActiveWorkspaceId)}/members`,
        { cache: "no-store" },
      );
      if (response.status === 403) {
        setMembers([]);
        setAvailableMembers([]);
        setCurrentMembership(null);
        return;
      }
      const memberBody = await readJsonResponse<CloudflareWorkspaceMembersResponse>(
        response,
        "Failed to load workspace members",
      );
      setMembers(memberBody.members ?? []);
      setAvailableMembers(memberBody.availableMembers ?? []);
      setCurrentMembership(memberBody.currentMembership ?? null);

      const retentionResponse = await fetch("/api/workbench/retention-policy", {
        cache: "no-store",
      });
      if (retentionResponse.ok) {
        const retentionBody = (await retentionResponse.json()) as CloudflareRetentionPolicyResponse;
        setRetention(retentionBody.policy);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load workspace access");
    } finally {
      setLoading(false);
    }
  }, [refetchAccounts, refetchWorkspaces]);

  useEffect(() => {
    if (!open) return;
    setView("switcher");
    void loadPanel();
  }, [loadPanel, open]);

  useEffect(() => {
    if (!open || !dataJob || !["queued", "running"].includes(dataJob.status)) return;
    const timeout = window.setTimeout(() => {
      void fetch(`/api/workbench/data-exports/${encodeURIComponent(dataJob.id)}`, {
        cache: "no-store",
      })
        .then((response) =>
          readJsonResponse<CloudflareDataJobResponse>(response, "Failed to refresh export"),
        )
        .then((body) => setDataJob(body.job))
        .catch((pollError) =>
          setError(pollError instanceof Error ? pollError.message : "Failed to refresh export"),
        );
    }, 1_000);
    return () => window.clearTimeout(timeout);
  }, [dataJob, open]);

  const sortedWorkspaces = useMemo(
    () =>
      [...workspaces].sort((left, right) => {
        if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
        if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
        return left.name.localeCompare(right.name);
      }),
    [workspaces],
  );
  const activeAccount = accounts.find((account) => account.isCurrent);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);

  const switchAccount = async (organizationId: string) => {
    setBusyId(`account:${organizationId}`);
    setError(null);
    try {
      const result = await switchToOrganization(organizationId);
      if ("error" in result) throw new Error(result.error);
      window.location.reload();
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : "Failed to switch account");
      setBusyId(null);
    }
  };

  const switchWorkspace = async (workspaceId: string) => {
    setBusyId(`workspace:${workspaceId}`);
    setError(null);
    try {
      await activateWorkspace(workspaceId);
      window.location.reload();
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : "Failed to switch workspace");
      setBusyId(null);
    }
  };

  const createWorkspace = async () => {
    const name = workspaceName.trim();
    if (!name) return;
    setBusyId("workspace:create");
    setError(null);
    try {
      await fetch(workspacesPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }).then((response) => readJsonResponse(response, "Failed to create workspace"));
      window.location.reload();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create workspace");
      setBusyId(null);
    }
  };

  const updateMember = async (
    member: WorkspaceMemberSummary,
    input: { role?: "owner" | "admin" | "member"; status?: "active" | "disabled" },
  ) => {
    if (!activeWorkspaceId) return;
    setBusyId(`member:${member.userId}`);
    setError(null);
    try {
      await fetch(
        `${workspacesPath}/${encodeURIComponent(activeWorkspaceId)}/members/${encodeURIComponent(member.userId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role: input.role ?? member.role,
            status: input.status ?? member.status,
          }),
        },
      ).then((response) => readJsonResponse(response, "Failed to update member access"));
      await loadPanel();
    } catch (updateError) {
      setError(
        updateError instanceof Error ? updateError.message : "Failed to update member access",
      );
    } finally {
      setBusyId(null);
    }
  };

  const addMember = async () => {
    if (!activeWorkspaceId || !memberToAdd) return;
    setBusyId(`member:add:${memberToAdd}`);
    setError(null);
    try {
      await fetch(`${workspacesPath}/${encodeURIComponent(activeWorkspaceId)}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: memberToAdd, role: "member" }),
      }).then((response) => readJsonResponse(response, "Failed to add workspace member"));
      setMemberToAdd("");
      await loadPanel();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Failed to add workspace member");
    } finally {
      setBusyId(null);
    }
  };

  const confirmRetention = async () => {
    if (!retention) return;
    setBusyId("retention:confirm");
    setError(null);
    try {
      const response = await fetch("/api/workbench/retention-policy", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactRetentionDays: retention.artifactRetentionDays,
          operationalEventRetentionDays: retention.operationalEventRetentionDays,
          runtimeTraceRetentionDays: retention.runtimeTraceRetentionDays,
          chatMessageRetentionDays: retention.chatMessageRetentionDays,
          runPayloadRetentionDays: retention.runPayloadRetentionDays,
          auditActionRetentionDays: retention.auditActionRetentionDays,
          confirm: true,
        }),
      });
      const body = await readJsonResponse<CloudflareRetentionPolicyResponse>(
        response,
        "Failed to confirm retention",
      );
      setRetention(body.policy);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Failed to confirm retention");
    } finally {
      setBusyId(null);
    }
  };

  const createDataExport = async () => {
    setBusyId("export:create");
    setError(null);
    try {
      const response = await fetch("/api/workbench/data-exports", { method: "POST" });
      const body = await readJsonResponse<CloudflareDataJobResponse>(
        response,
        "Failed to create export",
      );
      setDataJob(body.job);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Failed to create export");
    } finally {
      setBusyId(null);
    }
  };

  const requestDeletion = async () => {
    if (!activeWorkspace || deletionConfirmation !== activeWorkspace.name) return;
    setBusyId("workspace:delete");
    setError(null);
    try {
      await fetch("/api/workbench/workspace-deletion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceName: deletionConfirmation }),
      }).then((response) =>
        readJsonResponse(
          response,
          "Workspace deletion requires a WorkOS sign-in from the last five minutes",
        ),
      );
      window.location.reload();
    } catch (deletionError) {
      setError(
        deletionError instanceof Error ? deletionError.message : "Failed to quarantine workspace",
      );
      setBusyId(null);
    }
  };

  const closeFromOverlay = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          view === "switcher"
            ? "grid max-h-[min(82vh,38rem)] w-[min(94vw,34rem)] max-w-[calc(100vw-1.5rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[min(94vw,34rem)]"
            : "grid h-[min(86vh,48rem)] w-[min(94vw,48rem)] max-w-[calc(100vw-1.5rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[min(94vw,48rem)]"
        }
        onCloseAutoFocus={onCloseAutoFocus}
        onOverlayMouseDown={closeFromOverlay}
        onOverlayPointerDown={closeFromOverlay}
        onOverlayTouchStart={closeFromOverlay}
      >
        <DialogHeader className="border-border border-b px-5 py-4">
          <div className="flex items-start gap-3 pr-8">
            {view === "settings" ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Back to workspace switcher"
                onClick={() => setView("switcher")}
              >
                <ArrowLeftIcon />
              </Button>
            ) : null}
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2 text-base">
                <Building2Icon className="text-muted-foreground size-4" />
                {view === "switcher" ? "Workspace" : "Workspace settings"}
              </DialogTitle>
              <DialogDescription>
                {view === "switcher"
                  ? "Choose the workspace for your agents."
                  : `Manage ${activeWorkspace?.name ?? "this workspace"}.`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 overflow-auto">
          {error ? (
            <div className="border-destructive/40 bg-destructive/10 text-destructive m-4 rounded-md border px-3 py-2 text-sm">
              {error}
            </div>
          ) : null}

          {view === "switcher" ? (
            <WorkspaceSwitcher
              accounts={accounts}
              workspaces={sortedWorkspaces}
              activeAccount={activeAccount}
              activeWorkspace={activeWorkspace}
              role={currentMembership?.role}
              loading={loading}
              busyId={busyId}
              canManage={Boolean(canManageWorkspace)}
              onRefresh={loadPanel}
              onSwitchAccount={switchAccount}
              onSwitchWorkspace={switchWorkspace}
              onManage={() => setView("settings")}
            />
          ) : (
            <Tabs defaultValue="general" className="min-h-full">
              <div className="border-border sticky top-0 z-10 overflow-x-auto border-b bg-background px-4 py-2">
                <TabsList>
                  <TabsTrigger value="general">General</TabsTrigger>
                  <TabsTrigger value="members">Members</TabsTrigger>
                  <TabsTrigger value="data">Data & privacy</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="general" className="p-5">
                <h2 className="text-sm font-semibold">Workspace</h2>
                <p className="text-muted-foreground mt-1 text-xs">
                  {activeWorkspace?.name} · {currentMembership?.role}
                </p>
                <section className="border-border mt-6 border-t pt-5">
                  <h2 className="text-sm font-semibold">Create another workspace</h2>
                  <p className="text-muted-foreground mt-1 text-xs">
                    New workspaces start with private retention defaults.
                  </p>
                  <form
                    className="mt-3 flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createWorkspace();
                    }}
                  >
                    <input
                      value={workspaceName}
                      onChange={(event) => setWorkspaceName(event.target.value)}
                      maxLength={80}
                      placeholder="Workspace name"
                      className="border-input bg-background focus-visible:ring-ring h-9 min-w-0 flex-1 rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!workspaceName.trim() || Boolean(busyId)}
                    >
                      {busyId === "workspace:create" ? (
                        <Loader2Icon className="animate-spin" />
                      ) : (
                        <PlusIcon />
                      )}
                      Create
                    </Button>
                  </form>
                </section>
              </TabsContent>

              <TabsContent value="members" className="p-5">
                <WorkspaceMembers
                  members={members}
                  availableMembers={availableMembers}
                  memberToAdd={memberToAdd}
                  busyId={busyId}
                  onMemberToAddChange={setMemberToAdd}
                  onUpdateMember={updateMember}
                  onAddMember={addMember}
                />
              </TabsContent>

              <TabsContent value="data" className="p-5">
                <WorkspaceDataSettings
                  retention={retention}
                  dataJob={dataJob}
                  owner={currentMembership?.role === "owner"}
                  workspaceName={activeWorkspace?.name}
                  deletionConfirmation={deletionConfirmation}
                  busyId={busyId}
                  onRetentionChange={setRetention}
                  onConfirmRetention={confirmRetention}
                  onCreateExport={createDataExport}
                  onDeletionConfirmationChange={setDeletionConfirmation}
                  onDelete={requestDeletion}
                />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceSwitcher({
  accounts,
  workspaces,
  activeAccount,
  activeWorkspace,
  role,
  loading,
  busyId,
  canManage,
  onRefresh,
  onSwitchAccount,
  onSwitchWorkspace,
  onManage,
}: {
  accounts: WorkbenchAccount[];
  workspaces: WorkspaceSummary[];
  activeAccount?: WorkbenchAccount;
  activeWorkspace?: WorkspaceSummary;
  role?: string;
  loading: boolean;
  busyId: string | null;
  canManage: boolean;
  onRefresh: () => Promise<void>;
  onSwitchAccount: (organizationId: string) => Promise<void>;
  onSwitchWorkspace: (workspaceId: string) => Promise<void>;
  onManage: () => void;
}) {
  return (
    <div className="p-4">
      <section className="bg-muted/35 rounded-lg p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {activeWorkspace?.name ?? (loading ? "Loading workspace" : "No workspace")}
            </p>
            <p className="text-muted-foreground mt-1 truncate text-xs">
              {[activeAccount?.name, role].filter(Boolean).join(" · ") ||
                "Workspace context unavailable"}
            </p>
          </div>
          {activeWorkspace ? (
            <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
              <CheckCircle2Icon className="size-3.5" /> Active
            </span>
          ) : null}
        </div>
      </section>

      {accounts.length > 1 ? (
        <SwitcherGroup label="Accounts">
          {accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{account.name}</span>
                <span className="text-muted-foreground block text-xs">
                  {account.role ?? account.source}
                </span>
              </span>
              {account.isCurrent ? (
                <span className="text-muted-foreground text-xs">Current</span>
              ) : account.organizationId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={Boolean(busyId)}
                  onClick={() => void onSwitchAccount(account.organizationId!)}
                >
                  {busyId === `account:${account.organizationId}` ? (
                    <Loader2Icon className="animate-spin" />
                  ) : null}
                  Switch
                </Button>
              ) : null}
            </div>
          ))}
        </SwitcherGroup>
      ) : null}

      {workspaces.length > 1 ? (
        <SwitcherGroup label="Workspaces">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              disabled={Boolean(busyId) || workspace.status !== "active"}
              onClick={() => {
                if (!workspace.isActive) void onSwitchWorkspace(workspace.id);
              }}
              className="hover:bg-muted/50 focus-visible:ring-ring flex w-full items-center justify-between gap-3 rounded-md px-2 py-2.5 text-left outline-none focus-visible:ring-2 disabled:opacity-60"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{workspace.name}</span>
                <span className="text-muted-foreground block text-xs">
                  {workspace.isDefault ? "Default workspace" : "Workspace"}
                </span>
              </span>
              <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
                {busyId === `workspace:${workspace.id}` ? (
                  <Loader2Icon className="animate-spin" />
                ) : workspace.isActive ? (
                  <CheckCircle2Icon className="size-3.5" />
                ) : null}
                {workspace.isActive ? "Active" : "Switch"}
              </span>
            </button>
          ))}
        </SwitcherGroup>
      ) : null}

      <div className="border-border mt-5 flex items-center justify-between gap-3 border-t pt-4">
        <Button size="sm" variant="ghost" onClick={() => void onRefresh()} disabled={loading}>
          {loading ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
          Refresh
        </Button>
        {canManage ? (
          <Button size="sm" variant="outline" onClick={onManage}>
            <Settings2Icon /> Manage workspace
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SwitcherGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
        {label}
      </h2>
      <div className="divide-border divide-y">{children}</div>
    </section>
  );
}

function WorkspaceMembers({
  members,
  availableMembers,
  memberToAdd,
  busyId,
  onMemberToAddChange,
  onUpdateMember,
  onAddMember,
}: {
  members: WorkspaceMemberSummary[];
  availableMembers: WorkspaceMemberSummary[];
  memberToAdd: string;
  busyId: string | null;
  onMemberToAddChange: (value: string) => void;
  onUpdateMember: (
    member: WorkspaceMemberSummary,
    input: { role?: "owner" | "admin" | "member"; status?: "active" | "disabled" },
  ) => Promise<void>;
  onAddMember: () => Promise<void>;
}) {
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <UsersIcon className="text-muted-foreground size-4" /> Members
      </h2>
      <div className="divide-border divide-y">
        {members.map((member) => {
          const isBusy = busyId === `member:${member.userId}`;
          const canEdit = !member.isCurrentUser;
          return (
            <div
              key={member.id}
              className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_8rem_7rem] sm:items-center"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {member.displayName}
                  {member.isCurrentUser ? " (you)" : ""}
                </span>
                <span className="text-muted-foreground block truncate text-xs">
                  {member.email ?? member.userId}
                </span>
              </span>
              <select
                value={member.role}
                disabled={!canEdit || isBusy}
                aria-label={`Role for ${member.displayName}`}
                onChange={(event) =>
                  void onUpdateMember(member, {
                    role: event.target.value as "owner" | "admin" | "member",
                  })
                }
                className="border-input bg-background h-8 rounded-md border px-2 text-xs"
              >
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
              </select>
              <Button
                size="sm"
                variant={member.status === "active" ? "outline" : "secondary"}
                disabled={!canEdit || isBusy}
                onClick={() =>
                  void onUpdateMember(member, {
                    status: member.status === "active" ? "disabled" : "active",
                  })
                }
              >
                {isBusy ? <Loader2Icon className="animate-spin" /> : null}
                {member.status === "active" ? "Disable" : "Enable"}
              </Button>
            </div>
          );
        })}
      </div>
      {availableMembers.length ? (
        <form
          className="border-border mt-4 flex gap-2 border-t pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onAddMember();
          }}
        >
          <select
            value={memberToAdd}
            onChange={(event) => onMemberToAddChange(event.target.value)}
            aria-label="Account member to add"
            className="border-input bg-background h-9 min-w-0 flex-1 rounded-md border px-2 text-sm"
          >
            <option value="">Add account member</option>
            {availableMembers.map((member) => (
              <option key={member.id} value={member.userId}>
                {member.displayName}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" disabled={!memberToAdd || Boolean(busyId)}>
            {busyId === `member:add:${memberToAdd}` ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <PlusIcon />
            )}
            Add
          </Button>
        </form>
      ) : null}
    </section>
  );
}

function WorkspaceDataSettings({
  retention,
  dataJob,
  owner,
  workspaceName,
  deletionConfirmation,
  busyId,
  onRetentionChange,
  onConfirmRetention,
  onCreateExport,
  onDeletionConfirmationChange,
  onDelete,
}: {
  retention: CloudflareRetentionPolicyResponse["policy"] | null;
  dataJob: CloudflareDataJobResponse["job"] | null;
  owner: boolean;
  workspaceName?: string;
  deletionConfirmation: string;
  busyId: string | null;
  onRetentionChange: (value: CloudflareRetentionPolicyResponse["policy"] | null) => void;
  onConfirmRetention: () => Promise<void>;
  onCreateExport: () => Promise<void>;
  onDeletionConfirmationChange: (value: string) => void;
  onDelete: () => Promise<void>;
}) {
  return (
    <>
      {retention ? (
        <section>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheckIcon className="text-muted-foreground size-4" /> Data lifecycle
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            Choose how long workspace records are retained.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {retentionFields.map(([key, label, min, max]) => (
              <label key={key} className="text-muted-foreground grid gap-1 text-xs">
                <span>{label}</span>
                <input
                  type="number"
                  min={min}
                  max={max}
                  value={retention[key]}
                  onChange={(event) =>
                    onRetentionChange({
                      ...retention,
                      [key]: Math.max(min, Math.min(max, Number(event.target.value) || min)),
                    })
                  }
                  className="border-input bg-background h-9 rounded-md border px-2 text-sm text-foreground"
                />
              </label>
            ))}
          </div>
          <Button
            className="mt-4"
            size="sm"
            disabled={Boolean(busyId)}
            onClick={() => void onConfirmRetention()}
          >
            {retention.confirmed ? <CheckCircle2Icon /> : <ShieldCheckIcon />}
            {retention.confirmed ? "Save policy" : "Confirm policy"}
          </Button>
        </section>
      ) : null}

      <section className="border-border mt-6 border-t pt-5">
        <h2 className="text-sm font-semibold">Export workspace data</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Create a private, temporary archive of retained workspace data.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(busyId)}
            onClick={() => void onCreateExport()}
          >
            <DownloadIcon /> Create export
          </Button>
          {dataJob ? (
            dataJob.status === "completed" ? (
              <Button size="sm" asChild>
                <a href={`/api/workbench/data-exports/${encodeURIComponent(dataJob.id)}/download`}>
                  Download ZIP
                </a>
              </Button>
            ) : (
              <span className="text-muted-foreground text-xs">Export {dataJob.status}</span>
            )
          ) : null}
        </div>
      </section>

      {owner ? (
        <section className="border-destructive/30 mt-8 border-t pt-5">
          <h2 className="text-destructive flex items-center gap-2 text-sm font-semibold">
            <Trash2Icon className="size-4" /> Delete workspace
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            Credentials are revoked immediately. Retained content remains recoverable for 30 days.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              className="border-input bg-background h-9 min-w-0 flex-1 rounded-md border px-3 text-sm"
              value={deletionConfirmation}
              onChange={(event) => onDeletionConfirmationChange(event.target.value)}
              placeholder={`Type ${workspaceName ?? "workspace name"}`}
            />
            <Button
              size="sm"
              variant="destructive"
              disabled={deletionConfirmation !== workspaceName || Boolean(busyId)}
              onClick={() => void onDelete()}
            >
              Quarantine workspace
            </Button>
          </div>
        </section>
      ) : null}
    </>
  );
}
