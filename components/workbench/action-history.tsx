"use client";

import { useState } from "react";
import type { CloudflareActionsResponse } from "@operloom/workbench-client/contracts/lifecycle-authority";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/workbench/dev-monitor-primitives";

type Action = NonNullable<CloudflareActionsResponse["proposals"]>[number];
type Props = {
  actions: Action[];
  busyAction: string | null;
  onAction: (proposalId: string, action: "execute" | "reconcile") => Promise<void>;
};

const date = (value: string) => new Date(value).toLocaleString();

function ActionDetails({ action }: { action: Action }) {
  const [expanded, setExpanded] = useState(false);
  const receipt = action.providerOperation;
  const lifecycle = receipt?.output.lifecycle;
  const noDispatch = action.result?.dispatchStatus === "not_dispatched";
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)} className="mt-3 text-xs">
      <summary className="text-muted-foreground cursor-pointer">Action evidence</summary>
      {expanded ? (
        <div className="mt-3 space-y-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            <dt className="text-muted-foreground">Target</dt>
            <dd>External</dd>
            <dt className="text-muted-foreground">Updated</dt>
            <dd>{date(action.updatedAt)}</dd>
            {receipt ? (
              <>
                <dt className="text-muted-foreground">Operation</dt>
                <dd className="break-all">
                  {receipt.operationId} · {receipt.version}
                </dd>
                <dt className="text-muted-foreground">Dispatch</dt>
                <dd>{receipt.status}</dd>
                <dt className="text-muted-foreground">Observed</dt>
                <dd>{date(receipt.updatedAt)}</dd>
                {typeof lifecycle === "string" ? (
                  <>
                    <dt className="text-muted-foreground">Resource lifecycle</dt>
                    <dd>{lifecycle}</dd>
                  </>
                ) : null}
              </>
            ) : null}
            {action.review ? (
              <>
                <dt className="text-muted-foreground">Review expires</dt>
                <dd>{date(action.review.expiresAt)}</dd>
                <dt className="text-muted-foreground">Review hash</dt>
                <dd className="break-all font-mono">{action.review.requestHash}</dd>
              </>
            ) : null}
            {action.externalReference ? (
              <>
                <dt className="text-muted-foreground">External reference</dt>
                <dd className="break-all">{action.externalReference}</dd>
              </>
            ) : null}
          </dl>
          {noDispatch ? <p>No external mutation was dispatched. This attempt is closed.</p> : null}
          {lifecycle === "pending" ? (
            <p>The provider accepted the request. The external resource is still pending.</p>
          ) : null}
          {receipt?.status === "succeeded" && action.status === "executing" ? (
            <p>
              The provider result is recorded. Reconcile to repair the action outcome without
              submitting it again.
            </p>
          ) : null}
          {action.status === "outcome_unknown" ? (
            <p>The external outcome is uncertain. Reconcile before considering another action.</p>
          ) : null}
          {action.proposal ? (
            <EvidenceJson label="Proposed action" value={action.proposal} />
          ) : null}
          {receipt ? <EvidenceJson label="Provider result" value={receipt.output} /> : null}
          {action.result && Object.keys(action.result).length ? (
            <EvidenceJson label="Recorded outcome" value={action.result} />
          ) : null}
          {action.ledger.length ? (
            <ol aria-label="Action ledger" className="border-border space-y-2 border-l pl-3">
              {action.ledger.map((entry) => (
                <li key={entry.sequence}>
                  <span className="font-medium">{entry.status}</span> · {entry.summary}
                  <span className="text-muted-foreground block">{date(entry.createdAt)}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function EvidenceJson({ label, value }: { label: string; value: Record<string, unknown> }) {
  return (
    <div>
      <h4 className="mb-1 font-medium">{label}</h4>
      <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md p-3 whitespace-pre-wrap break-all">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export function ActionHistory({ actions, busyAction, onAction }: Props) {
  return (
    <section aria-label="Actions" className="border-border mb-6 rounded-lg border p-4">
      <h2 className="text-sm font-semibold">Actions</h2>
      <p className="text-muted-foreground mt-1 text-xs">
        Recent proposals and recorded external outcomes.
      </p>
      <div className="divide-border mt-2 divide-y">
        {actions.map((action) => (
          <article
            key={action.id}
            aria-label={action.summary}
            className="py-3 first:pt-2 last:pb-0"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h3 className="text-sm font-medium">{action.summary}</h3>
                <p className="text-muted-foreground mt-1 text-xs">{date(action.createdAt)}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <StatusPill
                  status={action.status}
                  tone={
                    action.status === "executing"
                      ? "running"
                      : action.status === "executed"
                        ? "completed"
                        : action.status === "failed" || action.status === "cancelled"
                          ? action.status
                          : undefined
                  }
                />
                {action.status === "proposed" ? (
                  <Button
                    size="sm"
                    disabled={Boolean(busyAction)}
                    onClick={() => void onAction(action.id, "execute")}
                  >
                    Request approval
                  </Button>
                ) : null}
                {action.status === "outcome_unknown" ||
                (action.status === "executing" && action.providerOperation) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busyAction)}
                    onClick={() => void onAction(action.id, "reconcile")}
                  >
                    Reconcile
                  </Button>
                ) : null}
              </div>
            </div>
            <ActionDetails action={action} />
          </article>
        ))}
      </div>
    </section>
  );
}
