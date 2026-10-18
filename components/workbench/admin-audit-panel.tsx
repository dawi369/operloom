"use client";

import { useAdminEvents } from "@operloom/react";
import type { AdminEvent } from "@operloom/client";
import { useState } from "react";

import { Button } from "@/components/ui/button";

const inputClass =
  "border-input bg-background h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Who changed what: every control-plane event in the workspace, newest first. */
export function AdminAuditPanel({
  open,
  members,
}: {
  open: boolean;
  members: { userId: string; label: string }[];
}) {
  const [type, setType] = useState("");
  const [userId, setUserId] = useState("");
  const [q, setQ] = useState("");
  const [before, setBefore] = useState<string | undefined>();
  const [earlier, setEarlier] = useState<AdminEvent[]>([]);
  const events = useAdminEvents({
    enabled: open,
    type: type || undefined,
    userId: userId || undefined,
    q: q.trim() || undefined,
    before,
  });
  const resetPaging = () => {
    setBefore(undefined);
    setEarlier([]);
  };
  const page = events.data?.events ?? [];
  const rows = before ? [...earlier, ...page] : page;
  const prefixes = Array.from(
    new Set((events.data?.types ?? []).map((value) => value.split(".")[0]!)),
  ).sort();

  return (
    <div className="space-y-4">
      <section className="border-border bg-background rounded-lg border">
        <div className="border-border border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Audit</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Approvals, policy changes, memory edits and every other control-plane event, with who
            did it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <select
            aria-label="Event type"
            className={inputClass}
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              resetPaging();
            }}
          >
            <option value="">any type</option>
            {prefixes.map((prefix) => (
              <option key={prefix} value={`${prefix}.`}>
                {prefix}.*
              </option>
            ))}
            {(events.data?.types ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            aria-label="Actor"
            className={inputClass}
            value={userId}
            onChange={(event) => {
              setUserId(event.target.value);
              resetPaging();
            }}
          >
            <option value="">anyone</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.label}
              </option>
            ))}
          </select>
          <input
            aria-label="Search events"
            className={`${inputClass} min-w-40 flex-1`}
            placeholder="Search summary or target"
            value={q}
            onChange={(event) => {
              setQ(event.target.value);
              resetPaging();
            }}
          />
        </div>
      </section>

      {events.error ? <p className="text-destructive text-xs">{String(events.error)}</p> : null}
      {events.isPending && !rows.length ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : null}
      {events.data && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No events match these filters.</p>
      ) : null}

      {rows.length ? (
        <div className="divide-border border-border bg-background divide-y rounded-lg border">
          {rows.map((event) => (
            <div key={event.id} className="grid gap-1 px-4 py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
                  {event.createdAt.replace("T", " ").slice(0, 19)}
                </span>
                <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]">
                  {event.type}
                </span>
                <span className="text-muted-foreground text-xs">{event.actorLabel}</span>
              </div>
              <p className="truncate">{event.summary}</p>
              {event.targetType ? (
                <p className="text-muted-foreground text-[11px]">
                  {event.targetType}: {event.targetId}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {events.data?.nextBefore ? (
        <Button
          size="sm"
          variant="outline"
          disabled={events.isFetching}
          onClick={() => {
            setEarlier(rows);
            setBefore(events.data!.nextBefore!);
          }}
        >
          Load earlier
        </Button>
      ) : null}
    </div>
  );
}
