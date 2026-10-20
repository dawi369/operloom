import { useWorkbenchFleet, useWorkbenchFleetTimeline } from "@operloom/react";
import type { FleetAgent, FleetAgentStatus } from "@operloom/client";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { Card, ErrorNotice, Screen } from "../../src/components/screen";
import { colors } from "../../src/theme";

const label: Record<FleetAgentStatus, string> = {
  running: "Running",
  waiting_approval: "Waiting on you",
  erroring: "Last run failed",
  idle: "Idle",
  paused: "Paused",
};
const tint: Record<FleetAgentStatus, string> = {
  running: "#1d4ed8",
  waiting_approval: "#b45309",
  erroring: colors.danger,
  idle: colors.muted,
  paused: colors.muted,
};
const order: FleetAgentStatus[] = ["waiting_approval", "erroring", "running", "idle", "paused"];

export const relativeTime = (iso: string | null, now = Date.now()) => {
  if (!iso) return null;
  const delta = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(delta);
  const text =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.round(abs / 60)}m`
        : abs < 86_400
          ? `${Math.round(abs / 3600)}h`
          : `${Math.round(abs / 86_400)}d`;
  return delta < 0 ? `${text} ago` : `in ${text}`;
};

/** The whole team at a glance; tap an agent with open approvals to go review them. */
export default function FleetScreen() {
  const fleet = useWorkbenchFleet({ updates: 2, chars: 120 });
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);
  const agents = [...(fleet.data?.agents ?? [])].sort(
    (left, right) => order.indexOf(left.status) - order.indexOf(right.status),
  );
  const waiting = agents.reduce((sum, agent) => sum + agent.openApprovals, 0);
  const running = agents.filter((agent) => agent.status === "running").length;
  return (
    <Screen
      title="Fleet"
      subtitle={
        waiting
          ? `${waiting} waiting on you`
          : running
            ? `${running} running`
            : agents.length
              ? "All quiet"
              : "No agents yet"
      }
      refreshing={fleet.isFetching}
      onRefresh={() => void fleet.refetch()}
    >
      <ErrorNotice message={fleet.error ? String(fleet.error) : null} />
      {agents.map((agent) => (
        <Card
          key={agent.id}
          onPress={() => setExpanded((current) => (current === agent.id ? null : agent.id))}
        >
          <AgentRow
            agent={agent}
            expanded={expanded === agent.id}
            onReview={agent.openApprovals ? () => router.navigate("/approvals") : undefined}
          />
        </Card>
      ))}
    </Screen>
  );
}

const AgentRow = ({
  agent,
  expanded,
  onReview,
}: {
  agent: FleetAgent;
  expanded: boolean;
  onReview?: () => void;
}) => {
  const line = agent.currentRun
    ? `${agent.currentRun.workflowType ?? "run"}${agent.currentRun.stage ? ` · ${agent.currentRun.stage}` : ""} · started ${relativeTime(agent.currentRun.startedAt)}`
    : agent.lastRun
      ? `${agent.lastRun.summary ?? agent.lastRun.workflowType ?? agent.lastRun.status} · ${relativeTime(agent.lastRun.finishedAt)}`
      : "Nothing has run yet";
  const tick = agent.triggers.enabled
    ? `Next tick ${relativeTime(agent.triggers.nextTickAt) ?? "pending"}`
    : agent.triggers.paused
      ? `${agent.triggers.paused} trigger${agent.triggers.paused === 1 ? "" : "s"} paused`
      : "No triggers";
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: colors.ink, fontWeight: "600", flex: 1 }}>{agent.name}</Text>
        <Text style={{ color: tint[agent.status], fontSize: 12, fontWeight: "600" }}>
          {label[agent.status]}
        </Text>
      </View>
      <Text style={{ color: colors.ink }} numberOfLines={2}>
        {line}
      </Text>
      <Text style={{ color: colors.muted, fontSize: 12 }}>
        {tick} · {agent.runsToday} today
        {agent.failedToday ? `, ${agent.failedToday} failed` : ""}
        {agent.effectTarget === "simulation" ? " · simulation" : ""}
      </Text>
      {agent.lastError ? (
        <Text style={{ color: colors.danger, fontSize: 12 }} numberOfLines={2}>
          {agent.lastError.summary ?? "Run failed"} · {relativeTime(agent.lastError.at)}
        </Text>
      ) : null}
      {agent.updates.map((update) => (
        <Text key={update.id} style={{ color: colors.ink, fontSize: 13 }} numberOfLines={2}>
          <Text style={{ color: colors.muted }}>{relativeTime(update.at)} </Text>
          {update.text}
        </Text>
      ))}
      {onReview ? (
        <Pressable
          accessibilityRole="button"
          onPress={onReview}
          style={{ alignSelf: "flex-start" }}
        >
          <Text style={{ color: colors.accent, fontWeight: "600" }}>
            Review {agent.openApprovals} approval{agent.openApprovals === 1 ? "" : "s"} ›
          </Text>
        </Pressable>
      ) : null}
      {expanded ? <Timeline agentId={agent.id} /> : null}
    </View>
  );
};

const eventLabel: Record<string, string> = {
  "agent.update": "",
  "run.started": "Started",
  "run.completed": "Finished",
  "run.failed": "Failed",
  "artifact.created": "Produced",
  "approval.requested": "Asked for approval",
  "approval.approved": "Approved",
  "approval.denied": "Denied",
  "memory.proposed": "Suggested a memory",
};

const Timeline = ({ agentId }: { agentId: string }) => {
  const timeline = useWorkbenchFleetTimeline({ agentId, limit: 20, chars: 200 });
  const updates = timeline.data?.updates ?? [];
  return (
    <View style={{ borderLeftWidth: 1, borderLeftColor: colors.line, paddingLeft: 10, gap: 4 }}>
      {timeline.isPending ? <Text style={{ color: colors.muted }}>Loading…</Text> : null}
      {updates.map((update) => {
        const label = eventLabel[update.type] ?? update.type;
        return (
          <Text key={update.id} style={{ color: colors.ink, fontSize: 13 }}>
            <Text style={{ color: colors.muted }}>
              {relativeTime(update.at)} {label ? `${label}: ` : ""}
            </Text>
            {update.text}
          </Text>
        );
      })}
      {timeline.data && !updates.length ? (
        <Text style={{ color: colors.muted }}>Nothing recorded yet.</Text>
      ) : null}
    </View>
  );
};
