"use client";

import { useAdminMemory, useBulkArchiveAdminMemory, useUpdateAdminMemory } from "@operloom/react";
import type { AdminMemoryRecord, MemoryKind } from "@operloom/client";
import { useState } from "react";

import { Button } from "@/components/ui/button";

const kinds: MemoryKind[] = ["goal", "preference", "watchlist", "conclusion", "note"];
const statuses = ["proposed", "active", "archived", "all"] as const;
type StatusFilter = (typeof statuses)[number];

const inputClass =
  "border-input bg-background h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

const kib = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KiB`;

/** Every record in the workspace, who it belongs to, and inline edits; proposals float to the top. */
export function AdminMemoryPanel({
  open,
  onMembersLoaded,
}: {
  open: boolean;
  /** Lets the parent reuse the member list for other admin tabs. */
  onMembersLoaded?: (members: { userId: string; label: string }[]) => void;
}) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [kind, setKind] = useState<MemoryKind | "">("");
  const [userId, setUserId] = useState("");
  const [q, setQ] = useState("");
  const memory = useAdminMemory({
    enabled: open,
    status,
    kind: kind || undefined,
    userId: userId || undefined,
    q: q.trim() || undefined,
  });
  const update = useUpdateAdminMemory();
  const bulk = useBulkArchiveAdminMemory();
  const [editing, setEditing] = useState<string | null>(null);
  const [staleDays, setStaleDays] = useState("30");
  const [bulkTarget, setBulkTarget] = useState({ type: "", id: "" });
  const [lastBulk, setLastBulk] = useState<string | null>(null);
  const records = memory.data?.records ?? [];
  const proposed = records.filter((record) => record.status === "proposed").length;
  const policy = memory.data?.policy;
  const [reportedMembers, setReportedMembers] = useState(memory.data?.members);
  if (memory.data?.members && memory.data.members !== reportedMembers) {
    setReportedMembers(memory.data.members);
    onMembersLoaded?.(memory.data.members);
  }
  const usage = (memory.data?.usage ?? []).filter((row) => !userId || row.userId === userId);
  const limits = memory.data?.limits;
  const runBulk = (filter: Parameters<typeof bulk.mutate>[0]) =>
    bulk.mutate(filter, {
      onSuccess: (result) =>
        setLastBulk(`Archived ${result.archived} record${result.archived === 1 ? "" : "s"}.`),
    });

  return (
    <div className="space-y-5">
      <section className="border-border bg-background rounded-lg border">
        <div className="border-border flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Memory</h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              What agents carry for every member of this workspace. Edits are audited.
            </p>
          </div>
          {proposed ? (
            <span className="rounded-full bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-800 dark:text-amber-300">
              {proposed} awaiting confirmation
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <select
            aria-label="Status"
            className={inputClass}
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
          >
            {statuses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            aria-label="Kind"
            className={inputClass}
            value={kind}
            onChange={(event) => setKind(event.target.value as MemoryKind | "")}
          >
            <option value="">any kind</option>
            {kinds.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            aria-label="Member"
            className={inputClass}
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          >
            <option value="">any member</option>
            {(memory.data?.members ?? []).map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.label}
              </option>
            ))}
          </select>
          <input
            aria-label="Search memory"
            className={`${inputClass} min-w-40 flex-1`}
            placeholder="Search title, key or content"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </div>
        {limits && usage.length ? (
          <p className="text-muted-foreground border-border border-t px-4 py-2 text-xs">
            {usage
              .map((row) => {
                const label =
                  memory.data?.members.find((member) => member.userId === row.userId)?.label ??
                  row.userId;
                return `${label}: ${row.activeRecords} / ${limits.activeRecords} records, ${kib(row.totalBytes)} / ${kib(limits.totalBytes)}`;
              })
              .join(" · ")}
          </p>
        ) : null}
        {policy ? (
          <p className="text-muted-foreground border-border border-t px-4 py-2 text-xs">
            Active agent policy: activates{" "}
            {policy.autoActivate.length ? policy.autoActivate.join(", ") : "nothing"} without a tap;
            claims expire after{" "}
            {kinds
              .filter((value) => policy.ttlDays[value] != null)
              .map((value) => `${value} ${policy.ttlDays[value]} d`)
              .join(", ") || "never"}
            .
          </p>
        ) : null}
      </section>

      <details className="group border-border bg-background rounded-lg border">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold marker:hidden">
          Bulk actions
        </summary>
        <div className="border-border grid gap-3 border-t px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span>Archive proposals not touched in</span>
            <input
              aria-label="Days"
              type="number"
              min={0}
              className={`${inputClass} w-20`}
              value={staleDays}
              onChange={(event) => setStaleDays(event.target.value)}
            />
            <span>days</span>
            <Button
              size="sm"
              variant="outline"
              disabled={bulk.isPending || staleDays === ""}
              onClick={() =>
                runBulk({ status: "proposed", olderThanDays: Math.max(0, Number(staleDays)) })
              }
            >
              Archive
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span>Forget everything about</span>
            <input
              aria-label="Target type"
              className={`${inputClass} w-28`}
              placeholder="market"
              value={bulkTarget.type}
              onChange={(event) => setBulkTarget({ ...bulkTarget, type: event.target.value })}
            />
            <input
              aria-label="Target id"
              className={`${inputClass} w-44`}
              placeholder="id"
              value={bulkTarget.id}
              onChange={(event) => setBulkTarget({ ...bulkTarget, id: event.target.value })}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={bulk.isPending || !bulkTarget.type.trim() || !bulkTarget.id.trim()}
              onClick={() =>
                runBulk({ target: { type: bulkTarget.type.trim(), id: bulkTarget.id.trim() } })
              }
            >
              Archive
            </Button>
          </div>
          {lastBulk ? <p className="text-muted-foreground text-xs">{lastBulk}</p> : null}
          {bulk.error ? <p className="text-destructive text-xs">{String(bulk.error)}</p> : null}
        </div>
      </details>

      {memory.error ? <p className="text-destructive text-xs">{String(memory.error)}</p> : null}
      {update.error ? <p className="text-destructive text-xs">{String(update.error)}</p> : null}
      {memory.isPending ? <p className="text-muted-foreground text-sm">Loading…</p> : null}
      {memory.data && records.length === 0 ? (
        <p className="text-muted-foreground text-sm">No memory matches these filters.</p>
      ) : null}

      <div className="divide-border border-border bg-background divide-y rounded-lg border">
        {records.map((record) =>
          editing === record.id ? (
            <MemoryEditor
              key={record.id}
              record={record}
              busy={update.isPending}
              onCancel={() => setEditing(null)}
              onSave={(patch) =>
                update.mutate({ id: record.id, patch }, { onSuccess: () => setEditing(null) })
              }
            />
          ) : (
            <MemoryRow
              key={record.id}
              record={record}
              busy={update.isPending}
              onEdit={() => setEditing(record.id)}
              onStatus={(next) => update.mutate({ id: record.id, patch: { status: next } })}
            />
          ),
        )}
      </div>
    </div>
  );
}

const detailOf = (record: AdminMemoryRecord) =>
  typeof record.content.text === "string"
    ? record.content.text
    : typeof record.content.summary === "string"
      ? record.content.summary
      : JSON.stringify(record.content);

const MemoryRow = ({
  record,
  busy,
  onEdit,
  onStatus,
}: {
  record: AdminMemoryRecord;
  busy: boolean;
  onEdit: () => void;
  onStatus: (status: "active" | "archived") => void;
}) => {
  const detail = detailOf(record);
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{record.title}</span>
          <span className="text-muted-foreground text-[11px]">{record.kind}</span>
          {record.status !== "active" ? (
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] ${
                record.status === "proposed"
                  ? "bg-amber-100 text-amber-900"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {record.status}
            </span>
          ) : null}
        </div>
        {detail && detail !== "{}" ? (
          <p className="text-muted-foreground mt-0.5 truncate text-xs">{detail}</p>
        ) : null}
        <p className="text-muted-foreground mt-1 text-[11px]">
          {record.userLabel}
          {record.scope === "workspace" ? " · shared" : record.scope === "agent" ? " · agent" : ""}
          {record.source !== "user" ? ` · by ${record.source}` : ""}
          {record.target ? ` · ${record.target.type}: ${record.target.id}` : ""}
          {` · updated ${record.updatedAt.slice(0, 10)}`}
          {record.expiresAt ? ` · expires ${record.expiresAt.slice(0, 10)}` : ""}
          {record.flags.includes("contact") ? " · contact data" : ""}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {record.status !== "active" ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onStatus("active")}>
            {record.status === "proposed" ? "Confirm" : "Restore"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
          Edit
        </Button>
        {record.status !== "archived" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onStatus("archived")}>
            Archive
          </Button>
        ) : null}
      </div>
    </div>
  );
};

const MemoryEditor = ({
  record,
  busy,
  onCancel,
  onSave,
}: {
  record: AdminMemoryRecord;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: {
    title: string;
    content: Record<string, unknown>;
    kind: MemoryKind;
    expiresAt: string | null;
  }) => void;
}) => {
  const [title, setTitle] = useState(record.title);
  const [kind, setKind] = useState<MemoryKind>(record.kind);
  const [contentText, setContentText] = useState(JSON.stringify(record.content, null, 2));
  const [expires, setExpires] = useState(record.expiresAt?.slice(0, 10) ?? "");
  const [contentError, setContentError] = useState<string | null>(null);
  return (
    <form
      className="grid gap-2 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        let content: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(contentText);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Content must be a JSON object.");
          content = parsed as Record<string, unknown>;
        } catch (error) {
          setContentError(error instanceof Error ? error.message : "Invalid JSON");
          return;
        }
        onSave({
          title: title.trim(),
          content,
          kind,
          expiresAt: expires ? new Date(`${expires}T00:00:00.000Z`).toISOString() : null,
        });
      }}
    >
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Kind"
          className={inputClass}
          value={kind}
          onChange={(event) => setKind(event.target.value as MemoryKind)}
        >
          {kinds.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          aria-label="Title"
          className={`${inputClass} min-w-48 flex-1`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="text-muted-foreground flex items-center gap-1 text-xs">
          expires
          <input
            type="date"
            aria-label="Expires"
            className={inputClass}
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
          />
        </label>
      </div>
      <textarea
        aria-label="Content JSON"
        className="border-input bg-background min-h-28 rounded-md border px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={contentText}
        onChange={(event) => {
          setContentText(event.target.value);
          setContentError(null);
        }}
      />
      {contentError ? <p className="text-destructive text-xs">{contentError}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !title.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
};
