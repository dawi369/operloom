import { describe, expect, it } from "vitest";

import { createWorkbenchClient, WorkbenchClientError } from "./client";
import { matchesPublicApiRoute } from "./public-api";
import { createWorkbenchRealtimeAdapter } from "./realtime";
import { toControlPlanePath } from "./route-map";

const calls: Array<{ method: string; path: string }> = [];
const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  calls.push({ method: init?.method ?? "GET", path: url.pathname });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const client = createWorkbenchClient({
  baseUrl: "https://worker.test/v1/me",
  target: "control-plane",
  fetch: fetcher,
  client: { platform: "ios", version: "test" },
});

/** Every operation a native shell may call, exercised through the real client surface. */
const operations: Array<() => Promise<unknown>> = [
  () => client.session.get({ refresh: "threads" }),
  () => client.session.stageThread(),
  () => client.session.materializeTurn({ text: "hi", clientTurnId: "t1" }),
  () => client.session.switchAgent({ agentId: "a1", target: "new_thread" as never }),
  () => client.threads.list("archived"),
  () => client.threads.create("title"),
  () => client.threads.activate("th1"),
  () => client.threads.update("th1", { title: "x" }),
  () => client.workspaces.list(),
  () => client.workspaces.activate("ws1"),
  () => client.agents.list(),
  () => client.agents.activate("a1"),
  () => client.agents.instantiatePack("operloom"),
  () => client.workflows.list(),
  () => client.workflows.run("pack.flow", {}),
  () => client.history.listRuns({ limit: 5 }),
  () => client.history.getRun("r1"),
  () => client.history.listArtifacts({ limit: 5 }),
  () => client.history.cancel("r1"),
  () => client.history.retry("r1"),
  () => client.approvals.list(),
  () => client.approvals.approve("ap1"),
  () => client.approvals.deny("ap1"),
  () => client.connections.list(),
  () => client.connections.authorize("c1"),
  () => client.connections.submitCredential("c1", "s"),
  () => client.connections.refresh("c1"),
  () => client.connections.health("c1"),
  () => client.connections.revoke("c1"),
  () => client.actions.list({ limit: 5 }),
  () => client.actions.execute("p1"),
  () => client.actions.reconcile("p1"),
  () => client.managedState.list({ namespace: "n", type: "t" }),
  () => client.devices.list(),
  () =>
    client.devices.register({ installationId: "i", platform: "ios", token: "t", appVersion: "1" }),
  () => client.devices.revoke("d1"),
  () => client.billing.get(),
  () => client.billing.plans(),
  () => client.billing.assignPlan({ planId: "team" }),
  () =>
    client.billing.checkout({
      planId: "team",
      successUrl: "https://a/x",
      cancelUrl: "https://a/y",
    }),
  () => client.billing.portal({ returnUrl: "https://a/z" }),
  () => client.billing.usage({ from: "2026-01-01", to: "2026-01-02" }),
  () => client.billing.reportUsage({ day: "2026-01-01" }),
  () => client.memory.list({ status: "all" }),
  () => client.memory.remember({ kind: "note", key: "k", title: "t", content: {} }),
  () => client.memory.confirm("m1"),
  () => client.memory.forget("m1"),
  () => client.admin.memory.list({ status: "all" }),
  () => client.admin.memory.update("m1", { status: "archived" }),
  () => client.notificationPreferences.get(),
  () => client.notificationPreferences.update({ approvalRequired: true, terminalOutcomes: true }),
];

describe("control-plane route map", () => {
  it("sends every client operation to an allowlisted /v1/me path", async () => {
    for (const operation of operations) await operation().catch(() => undefined);
    expect(calls).toHaveLength(operations.length);
    const unmatched = calls.filter(
      (call) =>
        !call.path.startsWith("/v1/me/") ||
        !matchesPublicApiRoute(call.method, call.path.slice("/v1/me".length)),
    );
    expect(unmatched).toEqual([]);
    expect(calls.map((call) => call.path)).toContain("/v1/me/chat/session/threads/th1/activate");
    expect(calls.map((call) => call.path)).toContain("/v1/me/workbench/billing/usage");
    expect(calls.map((call) => call.path)).toContain("/v1/me/tools/approvals/ap1/approve");
    expect(calls.map((call) => call.path)).toContain("/v1/me/workbench/memory/m1/confirm");
  });

  it("keeps console-only operations off the control plane", async () => {
    await expect(client.workspaces.listAccounts()).rejects.toMatchObject({
      code: "console_only_operation",
    } satisfies Partial<WorkbenchClientError>);
    expect(() => toControlPlanePath("/api/workbench/accounts")).toThrow(/console/);
    expect(toControlPlanePath("/unrelated")).toBe("/unrelated");
    expect(toControlPlanePath("/api/workbench/managed-state?namespace=n")).toBe(
      "/workbench/managed-state?namespace=n",
    );
  });

  it("streams session events from the Worker route", async () => {
    const seen: string[] = [];
    const realtime = createWorkbenchRealtimeAdapter({
      baseUrl: "https://worker.test/v1/me",
      target: "control-plane",
      client: { platform: "ios", version: "test" },
      fetch: async (input) => {
        seen.push(String(input));
        return new Response("", { status: 204 });
      },
    });
    const subscription = realtime.subscribeSession({ after: "evt-1" });
    await subscription.events[Symbol.asyncIterator]()
      .next()
      .catch(() => undefined);
    subscription.close();
    expect(seen[0]).toBe("https://worker.test/v1/me/chat/session/stream?after=evt-1");
  });
});
