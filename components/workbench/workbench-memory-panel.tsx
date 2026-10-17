"use client";

import {
  useConfirmMemory,
  useForgetMemory,
  useRememberMemory,
  useWorkbenchMemory,
} from "@operloom/react";
import type { MemoryKind, MemoryRecord } from "@operloom/client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const kinds: MemoryKind[] = ["goal", "preference", "watchlist", "conclusion", "note"];

/** Everything the agent remembers about the user, with confirm and forget; the user owns this list. */
export function WorkbenchMemoryPanel({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const memory = useWorkbenchMemory({ enabled: open, status: "all" });
  const confirm = useConfirmMemory();
  const forget = useForgetMemory();
  const remember = useRememberMemory();
  const [draft, setDraft] = useState({ kind: "note" as MemoryKind, title: "", text: "" });
  const records = (memory.data?.records ?? []).filter((record) => record.status !== "archived");
  const submitDraft = () =>
    remember.mutate(
      {
        kind: draft.kind,
        key:
          draft.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 60) || "note",
        title: draft.title.trim(),
        content: { text: draft.text.trim() },
      },
      { onSuccess: () => setDraft({ kind: "note", title: "", text: "" }) },
    );
  const grouped = kinds
    .map((kind) => ({ kind, items: records.filter((record) => record.kind === kind) }))
    .filter((group) => group.items.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Memory</DialogTitle>
          <DialogDescription>
            What the agent carries across threads. Proposals wait for you; anything here can be
            forgotten.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-2 rounded-lg border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.title.trim()) submitDraft();
          }}
        >
          <div className="flex gap-2">
            <select
              aria-label="Kind"
              className="bg-background rounded-md border px-2 text-sm"
              value={draft.kind}
              onChange={(event) => setDraft({ ...draft, kind: event.target.value as MemoryKind })}
            >
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <input
              aria-label="Title"
              className="bg-background flex-1 rounded-md border px-2 py-1 text-sm"
              placeholder="Something the agent should remember"
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
            <Button type="submit" size="sm" disabled={!draft.title.trim() || remember.isPending}>
              Remember
            </Button>
          </div>
          <input
            aria-label="Details"
            className="bg-background rounded-md border px-2 py-1 text-sm"
            placeholder="Details (optional)"
            value={draft.text}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
          {remember.error ? (
            <p className="text-destructive text-xs">{String(remember.error)}</p>
          ) : null}
        </form>
        {memory.isPending ? <p className="text-muted-foreground text-sm">Loading…</p> : null}
        {memory.data && records.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing remembered yet.</p>
        ) : null}
        {grouped.map((group) => (
          <section key={group.kind} className="grid gap-1.5">
            <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              {group.kind}
            </h3>
            {group.items.map((record) => (
              <MemoryRow
                key={record.id}
                record={record}
                onConfirm={() => confirm.mutate(record.id)}
                onForget={() => forget.mutate(record.id)}
                busy={confirm.isPending || forget.isPending}
              />
            ))}
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}

const MemoryRow = ({
  record,
  onConfirm,
  onForget,
  busy,
}: {
  record: MemoryRecord;
  onConfirm: () => void;
  onForget: () => void;
  busy: boolean;
}) => {
  const detail =
    typeof record.content.text === "string" ? record.content.text : JSON.stringify(record.content);
  return (
    <div className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{record.title}</span>
          {record.status === "proposed" ? (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900">
              proposed
            </span>
          ) : null}
          {record.source !== "user" ? (
            <span className="text-muted-foreground text-[11px]">by {record.source}</span>
          ) : null}
          {record.agentId ? (
            <span className="text-muted-foreground text-[11px]">this agent</span>
          ) : null}
        </div>
        {detail && detail !== "{}" ? (
          <p className="text-muted-foreground mt-0.5 truncate text-xs">{detail}</p>
        ) : null}
      </div>
      {record.status === "proposed" ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={onConfirm}>
          Confirm
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" disabled={busy} onClick={onForget}>
        Forget
      </Button>
    </div>
  );
};
