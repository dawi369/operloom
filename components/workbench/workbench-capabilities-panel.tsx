"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useConnectionAction, useWorkbenchConnections } from "@operloom/workbench-react";
import {
  BotIcon,
  CircleUserRoundIcon,
  LinkIcon,
  PlayIcon,
  ShieldAlertIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { resolveAgentSlashWorkflowActions } from "@/lib/workbench/agent-slash-actions";
import { resolvePackToolCapabilities } from "@/lib/workbench/pack-capabilities";
import { useWorkbenchAgentConnection } from "@/lib/workbench/use-agent-connection";

export function WorkbenchCapabilitiesPanel({
  open,
  onOpenChange,
  onCloseAutoFocus,
  onRunWorkflow,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onRunWorkflow: (workflowType: string) => void;
}) {
  const { session } = useWorkbenchAgentConnection();
  const agent = session?.activeAgent ?? null;
  const pack = agent?.behavior.pack ?? null;
  const tools = useMemo(() => resolvePackToolCapabilities(pack), [pack]);
  const workflowActions = useMemo(() => resolveAgentSlashWorkflowActions(pack), [pack]);
  const workflowActionByType = useMemo(
    () => new Map(workflowActions.map((action) => [action.binding.workflowType, action])),
    [workflowActions],
  );
  const userTools = tools.filter((tool) => tool.invocation === "user");
  const agentTools = tools.filter((tool) => tool.invocation === "agent");
  const workflowTools = tools.filter((tool) => tool.invocation === "workflow");
  const userWorkflows =
    pack?.workflows.filter((workflow) => workflow.userInvocable !== false) ?? [];
  const connectionsQuery = useWorkbenchConnections({ enabled: open && Boolean(pack) });
  const connections = connectionsQuery.data?.connections ?? [];
  const { mutateAsync: submitCredential } = useConnectionAction("submitCredential");
  const { mutateAsync: revokeCredential } = useConnectionAction("revoke");
  const { mutateAsync: refreshCredential } = useConnectionAction("refresh");
  const { mutateAsync: checkCredentialHealth } = useConnectionAction("health");
  const { mutateAsync: authorizeCredential } = useConnectionAction("authorize");
  const [connectionSecrets, setConnectionSecrets] = useState<Record<string, string>>({});
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [killSwitches, setKillSwitches] = useState<
    Array<{
      scope_kind: "workspace" | "pack" | "tool" | "connection";
      scope_id: string;
      enabled: number;
      reason: string;
    }>
  >([]);
  const [mutationPermissions, setMutationPermissions] = useState<Record<string, boolean>>({});

  const refreshConnections = async () => {
    await connectionsQuery.refetch();
  };

  const refreshKillSwitches = async () => {
    const response = await fetch("/api/workbench/kill-switches", { cache: "no-store" });
    const body = (await response.json().catch(() => ({}))) as {
      killSwitches?: typeof killSwitches;
    };
    setKillSwitches(body.killSwitches ?? []);
  };

  const refreshMutationPermissions = async () => {
    const response = await fetch(
      "/api/workbench/tools?stage=execute&executionMode=execute&surface=admin_list",
      { cache: "no-store" },
    );
    const body = (await response.json().catch(() => ({}))) as {
      tools?: Array<{ name: string; mutationEnabled?: boolean }>;
    };
    setMutationPermissions(
      Object.fromEntries(
        (body.tools ?? []).map((tool) => [tool.name, tool.mutationEnabled === true]),
      ),
    );
  };

  useEffect(() => {
    if (!open || !pack) return;
    void Promise.all([refreshKillSwitches(), refreshMutationPermissions()]).catch(() => {
      setKillSwitches([]);
      setMutationPermissions({});
    });
  }, [open, pack?.id]);

  const authorizeConnection = async (connectionId: string) => {
    setConnectionNotice("Authorizing connection...");
    try {
      await submitCredential({ connectionId, secret: connectionSecrets[connectionId] ?? "" });
      setConnectionNotice("Connection authorized.");
      setConnectionSecrets((current) => ({ ...current, [connectionId]: "" }));
      await refreshConnections();
    } catch (error) {
      setConnectionNotice(error instanceof Error ? error.message : "Authorization failed.");
    }
  };

  const revokeConnection = async (connectionId: string) => {
    try {
      await revokeCredential({ connectionId });
      setConnectionNotice("Connection revoked.");
      await refreshConnections();
    } catch (error) {
      setConnectionNotice(error instanceof Error ? error.message : "Connection revocation failed.");
    }
  };

  const checkConnection = async (connectionId: string, refresh = false) => {
    try {
      await (refresh ? refreshCredential : checkCredentialHealth)({ connectionId });
      setConnectionNotice(`Connection ${refresh ? "refreshed" : "checked"}.`);
      await refreshConnections();
    } catch (error) {
      setConnectionNotice(
        error instanceof Error
          ? error.message
          : `Connection ${refresh ? "refresh" : "health check"} failed.`,
      );
    }
  };

  const updateKillSwitch = async (
    scopeKind: "pack" | "tool" | "connection",
    scopeId: string,
    enabled: boolean,
  ) => {
    const response = await fetch("/api/workbench/kill-switches", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scopeKind,
        scopeId,
        enabled,
        reason: enabled
          ? "Paused by a workspace operator from the capability controls."
          : "Resumed by a workspace operator from the capability controls.",
      }),
    });
    setConnectionNotice(
      response.ok ? "Mutation authority updated." : "Mutation authority update failed.",
    );
    if (response.ok) await refreshKillSwitches();
  };

  const updateMutationPermission = async (toolName: string, enabled: boolean) => {
    const response = await fetch("/api/workbench/tools/policy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolName, mutationEnabled: enabled }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setConnectionNotice(
      response.ok
        ? `Mutation execution ${enabled ? "enabled" : "disabled"} for ${toolName}.`
        : (body.error ?? "Mutation authority update failed."),
    );
    if (response.ok) await refreshMutationPermissions();
  };

  const killSwitchEnabled = (scopeKind: "pack" | "tool" | "connection", scopeId: string) =>
    killSwitches.some(
      (entry) =>
        entry.scope_kind === scopeKind && entry.scope_id === scopeId && entry.enabled === 1,
    );

  const startOAuthConnection = async (connectionId: string) => {
    setConnectionNotice("Starting secure authorization...");
    try {
      const body = await authorizeCredential({ connectionId });
      if (!("authorizationUrl" in body)) throw new Error("Authorization response was incomplete.");
      window.location.assign(body.authorizationUrl);
    } catch (error) {
      setConnectionNotice(
        error instanceof Error ? error.message : "Authorization could not be started.",
      );
    }
  };

  const closeFromOverlay = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid max-h-[min(82vh,44rem)] w-[min(92vw,40rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[min(92vw,40rem)]"
        onCloseAutoFocus={onCloseAutoFocus}
        onOverlayMouseDown={closeFromOverlay}
        onOverlayPointerDown={closeFromOverlay}
        onOverlayTouchStart={closeFromOverlay}
      >
        <DialogHeader className="border-border border-b px-5 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base">
            <WrenchIcon className="text-muted-foreground size-4" />
            {pack?.name ?? agent?.name ?? "Agent"} tools
          </DialogTitle>
          <DialogDescription>
            What you can run and what this agent uses behind the scenes.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-5 overflow-y-auto p-5">
          {!pack ? (
            <p className="text-muted-foreground text-sm">
              This agent does not declare a capability pack.
            </p>
          ) : (
            <>
              <CapabilitySection
                icon={CircleUserRoundIcon}
                title="Available to you"
                description="Direct tools and bounded workflows you can start from this chat."
              >
                {userWorkflows.map((workflow) => {
                  const action = workflowActionByType.get(workflow.type);
                  return (
                    <CapabilityRow
                      key={workflow.type}
                      name={action?.label ?? workflow.type}
                      description={workflow.description ?? "Bounded workflow."}
                      badge={`${workflow.engine} flow`}
                      action={
                        action ? (
                          <Button
                            size="sm"
                            onClick={() => {
                              onOpenChange(false);
                              onRunWorkflow(workflow.type);
                            }}
                          >
                            <PlayIcon />
                            Run
                          </Button>
                        ) : (
                          <span className="text-muted-foreground text-xs">Unavailable</span>
                        )
                      }
                    />
                  );
                })}
                {userTools.map((tool) => (
                  <CapabilityRow
                    key={tool.id}
                    name={tool.id}
                    description={tool.purpose ?? "Direct user tool."}
                    badge="direct tool"
                  />
                ))}
                {userWorkflows.length === 0 && userTools.length === 0 ? (
                  <EmptyCapabilityRow text="No user-runnable tools are declared for this agent." />
                ) : null}
              </CapabilitySection>

              <CapabilitySection
                icon={LinkIcon}
                title="Connections"
                description="Credentials remain in the platform vault and are never exposed to the agent."
              >
                {connections.map((connection) => (
                  <div
                    key={connection.id}
                    className="border-border space-y-2 border-b px-3 py-3 last:border-b-0"
                  >
                    <CapabilityRow
                      name={connection.id}
                      description={`${connection.provider} · ${connection.requestedScopes.join(", ") || "no scopes"}`}
                      badge={connection.status}
                      action={
                        connection.status === "authorized" ? (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void checkConnection(connection.id)}
                            >
                              Check
                            </Button>
                            {connection.credentialClass === "oauth2" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void checkConnection(connection.id, true)}
                              >
                                Refresh
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void revokeConnection(connection.id)}
                            >
                              Revoke
                            </Button>
                          </div>
                        ) : undefined
                      }
                    />
                    {connection.status !== "authorized" &&
                    connection.credentialClass === "api_key" ? (
                      <div className="flex gap-2">
                        <input
                          className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring h-9 min-w-0 flex-1 rounded-md border px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                          type="password"
                          value={connectionSecrets[connection.id] ?? ""}
                          autoComplete="off"
                          aria-label={`${connection.id} credential`}
                          placeholder="API key"
                          onChange={(event) =>
                            setConnectionSecrets((current) => ({
                              ...current,
                              [connection.id]: event.target.value,
                            }))
                          }
                        />
                        <Button
                          size="sm"
                          disabled={!connectionSecrets[connection.id]}
                          onClick={() => void authorizeConnection(connection.id)}
                        >
                          Connect
                        </Button>
                      </div>
                    ) : null}
                    {connection.status !== "authorized" &&
                    connection.credentialClass === "oauth2" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void startOAuthConnection(connection.id)}
                      >
                        Authorize with OAuth
                      </Button>
                    ) : null}
                  </div>
                ))}
                {connections.length === 0 ? (
                  <EmptyCapabilityRow text="This agent does not require an external connection." />
                ) : null}
                {connectionNotice ? (
                  <p className="text-muted-foreground border-border border-t px-3 py-2 text-xs">
                    {connectionNotice}
                  </p>
                ) : null}
              </CapabilitySection>

              {pack.risk.externalMutation ? (
                <CapabilitySection
                  icon={ShieldAlertIcon}
                  title="Mutation authority"
                  description="Emergency switches revoke new dispatch immediately; completed external effects are not reversed."
                >
                  <CapabilityRow
                    name={pack.id}
                    description="Pause every mutation-capable tool in this Agent Pack."
                    badge={killSwitchEnabled("pack", pack.id) ? "paused" : "clear"}
                    action={
                      <Button
                        size="sm"
                        variant={killSwitchEnabled("pack", pack.id) ? "outline" : "destructive"}
                        onClick={() =>
                          void updateKillSwitch(
                            "pack",
                            pack.id,
                            !killSwitchEnabled("pack", pack.id),
                          )
                        }
                      >
                        {killSwitchEnabled("pack", pack.id) ? "Resume pack" : "Pause pack"}
                      </Button>
                    }
                  />
                  {tools
                    .filter((tool) => tool.executionModes.includes("execute"))
                    .map((tool) => (
                      <CapabilityRow
                        key={tool.id}
                        name={tool.id}
                        description="Explicit workspace permission and emergency tool-level pause."
                        badge={mutationPermissions[tool.id] ? "enabled" : "disabled"}
                        action={
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant={mutationPermissions[tool.id] ? "destructive" : "outline"}
                              onClick={() =>
                                void updateMutationPermission(
                                  tool.id,
                                  !mutationPermissions[tool.id],
                                )
                              }
                            >
                              {mutationPermissions[tool.id]
                                ? "Disable execution"
                                : "Enable execution"}
                            </Button>
                            <Button
                              size="sm"
                              variant={
                                killSwitchEnabled("tool", tool.id) ? "outline" : "destructive"
                              }
                              onClick={() =>
                                void updateKillSwitch(
                                  "tool",
                                  tool.id,
                                  !killSwitchEnabled("tool", tool.id),
                                )
                              }
                            >
                              {killSwitchEnabled("tool", tool.id) ? "Resume" : "Pause"}
                            </Button>
                          </div>
                        }
                      />
                    ))}
                  {connections
                    .filter((connection) => connection.credentialClass !== "none")
                    .map((connection) => (
                      <CapabilityRow
                        key={`kill-${connection.id}`}
                        name={connection.id}
                        description="Connection-scoped external mutation authority."
                        badge={killSwitchEnabled("connection", connection.id) ? "paused" : "clear"}
                        action={
                          <Button
                            size="sm"
                            variant={
                              killSwitchEnabled("connection", connection.id)
                                ? "outline"
                                : "destructive"
                            }
                            onClick={() =>
                              void updateKillSwitch(
                                "connection",
                                connection.id,
                                !killSwitchEnabled("connection", connection.id),
                              )
                            }
                          >
                            {killSwitchEnabled("connection", connection.id) ? "Resume" : "Pause"}
                          </Button>
                        }
                      />
                    ))}
                </CapabilitySection>
              ) : null}

              <CapabilitySection
                icon={BotIcon}
                title="Agent only"
                description="Conversational tools the agent may choose without a separate launcher."
              >
                {agentTools.map((tool) => (
                  <CapabilityRow
                    key={tool.id}
                    name={tool.id}
                    description={tool.purpose ?? "Agent-only tool."}
                    badge={tool.modelVisibleDefault ? "model visible" : "policy gated"}
                  />
                ))}
                {agentTools.length === 0 ? (
                  <EmptyCapabilityRow text="No conversational agent-only tools are enabled." />
                ) : null}
              </CapabilitySection>

              <CapabilitySection
                icon={WorkflowIcon}
                title="Inside workflows"
                description="Internal adapters used by the bounded workflow above."
              >
                {workflowTools.map((tool) => (
                  <CapabilityRow
                    key={tool.id}
                    name={tool.id}
                    description={tool.purpose ?? "Workflow-internal tool."}
                    badge={tool.executionModes.join(" / ") || "bounded"}
                  />
                ))}
                {workflowTools.length === 0 ? (
                  <EmptyCapabilityRow text="No workflow-internal tools are declared." />
                ) : null}
              </CapabilitySection>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CapabilitySection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof WrenchIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-start gap-2">
        <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
      </div>
      <div className="border-border overflow-hidden rounded-md border">{children}</div>
    </section>
  );
}

function CapabilityRow({
  name,
  description,
  badge,
  action,
}: {
  name: string;
  description: string;
  badge: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-border flex min-w-0 items-center gap-3 border-b px-3 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="break-all text-sm font-medium">{name}</p>
          <span className="bg-muted text-foreground rounded px-1.5 py-0.5 text-[11px]">
            {badge}
          </span>
        </div>
        <p className="text-muted-foreground mt-1 text-xs leading-5 whitespace-normal">
          {description}
        </p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function EmptyCapabilityRow({ text }: { text: string }) {
  return <p className="text-muted-foreground px-3 py-3 text-xs">{text}</p>;
}
