"use client";

import { useForgetMemory } from "@operloom/react";
import type { ToolApprovalRequestSummary } from "@operloom/client";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** What the agent remembered when it raised this request; a wrong record can be forgotten right here. */
export function ApprovalMemoryUsed({
  records,
}: {
  records: NonNullable<ToolApprovalRequestSummary["memoryUsed"]>;
}) {
  const forget = useForgetMemory();
  const [forgotten, setForgotten] = useState<Set<string>>(new Set());
  if (!records.length) return null;
  return (
    <section aria-label="Memory the agent relied on" className="min-w-0 space-y-1.5 text-xs">
      <p className="text-muted-foreground">
        Based on {records.length} memory record{records.length === 1 ? "" : "s"}. Forget one if it
        is wrong; the request itself is unchanged.
      </p>
      <ul className="divide-border divide-y rounded-md border">
        {records.map((record) => {
          const gone = forgotten.has(record.id) || record.status === "archived";
          return (
            <li key={record.id} className="flex items-start gap-2 px-2.5 py-1.5">
              <div className={`min-w-0 flex-1 ${gone ? "line-through opacity-60" : ""}`}>
                <span className="font-medium">{record.title}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {record.kind}
                  {record.source !== "user"
                    ? ` · by ${record.source} ${record.updatedAt.slice(0, 10)}`
                    : ""}
                  {record.target ? ` · ${record.target.type}: ${record.target.id}` : ""}
                </span>
              </div>
              {!gone ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  disabled={forget.isPending}
                  onClick={() =>
                    forget.mutate(record.id, {
                      onSuccess: () => setForgotten((current) => new Set(current).add(record.id)),
                    })
                  }
                >
                  Forget
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
