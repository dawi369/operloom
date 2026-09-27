"use client";

import { ChevronDownIcon, ShieldCheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/workbench/dev-monitor-primitives";
import type { ToolApprovalRequestSummary, ToolSummary } from "@/lib/workbench/workbench-types";

export type AdminApprovalDecision = {
  approval: ToolApprovalRequestSummary;
  action: "approve" | "deny";
};

export function AdminControlsPanel({
  approvals,
  tools,
  busyTool,
  onDecideApproval,
  onUpdateToolPolicy,
}: {
  approvals: ToolApprovalRequestSummary[];
  tools: ToolSummary[];
  busyTool: string | null;
  onDecideApproval: (decision: AdminApprovalDecision) => void;
  onUpdateToolPolicy: (
    tool: ToolSummary,
    change: Record<string, string | boolean>,
  ) => Promise<void>;
}) {
  return (
    <div className="space-y-5">
      <section className="border-border bg-background rounded-lg border">
        <div className="border-border flex items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Approvals</h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Requests waiting for an operator decision.
            </p>
          </div>
          {approvals.length ? (
            <span className="bg-amber-500/10 text-amber-800 dark:text-amber-300 rounded-full px-2 py-1 text-xs font-medium">
              {approvals.length} pending
            </span>
          ) : null}
        </div>

        {approvals.length ? (
          <div className="divide-border divide-y">
            {approvals.map((approval) => (
              <div
                key={approval.id}
                className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{approval.toolId ?? "Tool request"}</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {approval.reason ?? approval.input?.url ?? "Operator decision required."}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onDecideApproval({ approval, action: "deny" })}
                  >
                    Deny
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => onDecideApproval({ approval, action: "approve" })}
                  >
                    Approve
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 px-4 py-4 text-sm">
            <ShieldCheckIcon className="text-emerald-600 size-4" />
            Nothing needs your approval.
          </div>
        )}
      </section>

      <details className="group border-border bg-background rounded-lg border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden">
          <span>
            <span className="block text-sm font-semibold">Tool permissions</span>
            <span className="text-muted-foreground mt-0.5 block text-xs">
              {tools.length} registered tools. Change access only when needed.
            </span>
          </span>
          <ChevronDownIcon className="text-muted-foreground size-4 transition-transform group-open:rotate-180" />
        </summary>

        <div className="divide-border border-border divide-y border-t">
          {tools.map((tool) => (
            <div
              key={tool.name}
              className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{tool.name}</p>
                  <StatusPill
                    status={tool.permissionStatus ?? tool.status}
                    tone={tool.permissionStatus === "enabled" ? "completed" : undefined}
                  />
                  {tool.modelVisible ? (
                    <span className="text-muted-foreground text-xs">Model visible</span>
                  ) : null}
                  {tool.mutationRisk === "mutation_capable" ? (
                    <span className="text-muted-foreground text-xs">
                      {tool.mutationEnabled ? "Mutation enabled" : "Mutation disabled"}
                    </span>
                  ) : null}
                </div>
                <p className="text-muted-foreground mt-1 text-xs">{tool.description}</p>
              </div>

              {tool.policyEditable ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyTool === tool.name}
                    onClick={() =>
                      void onUpdateToolPolicy(tool, {
                        status: tool.permissionStatus === "enabled" ? "disabled" : "enabled",
                      })
                    }
                  >
                    {tool.permissionStatus === "enabled" ? "Disable" : "Enable"}
                  </Button>
                  {tool.mutationRisk === "mutation_capable" ? (
                    <Button
                      size="sm"
                      variant={tool.mutationEnabled ? "destructive" : "outline"}
                      disabled={busyTool === tool.name}
                      onClick={() =>
                        void onUpdateToolPolicy(tool, {
                          mutationEnabled: !tool.mutationEnabled,
                        })
                      }
                    >
                      {tool.mutationEnabled ? "Revoke mutation" : "Enable mutation"}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyTool === tool.name}
                    onClick={() =>
                      void onUpdateToolPolicy(tool, { modelVisible: !tool.modelVisible })
                    }
                  >
                    {tool.modelVisible ? "Hide from model" : "Show to model"}
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
