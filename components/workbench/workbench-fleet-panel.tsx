"use client";

import { useWorkbenchFleet } from "@operloom/react";
import type { FleetAgent, FleetAgentStatus } from "@operloom/client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const statusLabel: Record<FleetAgentStatus, string> = {
  running: "Running",
  waiting_approval: "Waiting on you",
  erroring: "Last run failed",
  idle: "Idle",
  paused: "Paused",
};

const statusClass: Record<FleetAgentStatus, string> = {
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  waiting_approval: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  erroring: "bg-red-500/15 text-red-700 dark:text-red-300",
  idle: "bg-muted text-muted-foreground",
  paused: "bg-muted text-muted-foreground",
};

const order: FleetAgentStatus[] = ["waiting_approval", "erroring", "running", "idle", "paused"];

export const relativeTime = (iso: string | null, now = Date.now()) => {
  if (!iso) return null;
  const delta = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(delta);
  const unit =
    abs < 60
      ? [abs, "s"]
      : abs < 3600
        ? [Math.round(abs / 60), "m"]
        : abs < 86_400
          ? [Math.round(abs / 3600), "h"]
          : [Math.round(abs / 86_400), "d"];
  return delta < 0 ? `${unit[0]}${unit[1]} ago` : `in ${unit[0]}${unit[1]}`;
};

const compactTokens = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${Math.round(value / 1000)}k`
      : String(value);

/** Every agent in the workspace on one board: what it is doing now, what waits on a human, when it ticks next. */
export function WorkbenchFleetPanel({
  open,
  onOpenChange,
  onCloseAutoFocus,
  onOpenApprovals,
  onOpenRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onOpenApprovals?: () => void;
  onOpenRun?: (runId: string) => void;
}) {
  const fleet = useWorkbenchFleet({ enabled: open });
  const agents = [...(fleet.data?.agents ?? [])].sort(
    (left, right) => order.indexOf(left.status) - order.indexOf(right.status),
  );
  const waiting = agents.reduce((sum, agent) => sum + agent.openApprovals, 0);
  const running = agents.filter((agent) => agent.status === "running").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Fleet</DialogTitle>
          <DialogDescription>
            {agents.length} agent{agents.length === 1 ? "" : "s"}
            {running ? ` · ${running} running` : ""}
            {waiting ? ` · ${waiting} waiting on you` : ""}
            {fleet.data ? ` · updated ${relativeTime(fleet.data.generatedAt)}` : ""}
          </DialogDescription>
        </DialogHeader>
        {fleet.error ? <p className="text-destructive text-sm">{String(fleet.error)}</p> : null}
        <ul className="grid gap-3" aria-label="Agents">
          {agents.map((agent) => (
            <FleetCard
              key={agent.id}
              agent={agent}
              onOpenApprovals={onOpenApprovals}
              onOpenRun={onOpenRun}
            />
          ))}
        </ul>
        {fleet.data && agents.length === 0 ? (
          <p className="text-muted-foreground text-sm">No agents in this workspace yet.</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FleetCard({
  agent,
  onOpenApprovals,
  onOpenRun,
}: {
  agent: FleetAgent;
  onOpenApprovals?: () => void;
  onOpenRun?: (runId: string) => void;
}) {
  const now = agent.currentRun?.startedAt ? agent.currentRun : agent.lastRun;
  return (
    <li className="border-border rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{agent.name}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass[agent.status]}`}
        >
          {statusLabel[agent.status]}
        </span>
        {agent.effectTarget === "simulation" ? (
          <span className="text-muted-foreground text-xs">simulation</span>
        ) : null}
        <span className="text-muted-foreground ml-auto text-xs">
          {agent.runsToday} run{agent.runsToday === 1 ? "" : "s"} today
          {agent.failedToday ? `, ${agent.failedToday} failed` : ""}
          {agent.tokensToday ? ` · ${compactTokens(agent.tokensToday)} tokens` : ""}
        </span>
      </div>
      <dl className="text-muted-foreground mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {agent.currentRun ? (
          <Row label="Now">
            {agent.currentRun.workflowType ?? "run"}
            {agent.currentRun.stage ? ` · ${agent.currentRun.stage}` : ""} · started{" "}
            {relativeTime(agent.currentRun.startedAt)}
          </Row>
        ) : agent.lastRun ? (
          <Row label="Last">
            {agent.lastRun.summary ?? agent.lastRun.workflowType ?? agent.lastRun.status} ·{" "}
            {relativeTime(agent.lastRun.finishedAt)}
          </Row>
        ) : (
          <Row label="Last">Nothing has run yet</Row>
        )}
        <Row label="Next tick">
          {agent.triggers.enabled
            ? `${relativeTime(agent.triggers.nextTickAt) ?? "pending"} · ${agent.triggers.enabled} active`
            : agent.triggers.paused
              ? `${agent.triggers.paused} paused`
              : "No triggers"}
        </Row>
        {agent.lastError ? (
          <Row label="Last error">
            <span className="text-destructive">{agent.lastError.summary ?? "Run failed"}</span> ·{" "}
            {relativeTime(agent.lastError.at)}
          </Row>
        ) : null}
      </dl>
      {agent.openApprovals || now ? (
        <div className="mt-2 flex gap-2">
          {agent.openApprovals && onOpenApprovals ? (
            <Button size="sm" onClick={onOpenApprovals}>
              Review {agent.openApprovals} approval{agent.openApprovals === 1 ? "" : "s"}
            </Button>
          ) : null}
          {now && onOpenRun ? (
            <Button size="sm" variant="outline" onClick={() => onOpenRun(now.id)}>
              Open run
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex gap-2">
    <dt className="w-16 shrink-0">{label}</dt>
    <dd className="text-foreground min-w-0">{children}</dd>
  </div>
);
