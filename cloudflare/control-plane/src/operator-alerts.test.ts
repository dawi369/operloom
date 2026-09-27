import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deliverPendingOperatorAlerts,
  handleRetryOperatorAlertDelivery,
  handleUpdateOperatorAlert,
} from "./operator-alerts";
import type { ControlOperatorAlertRow, D1PreparedStatement, D1Result, Env } from "./types";

const alert: ControlOperatorAlertRow = {
  id: "alert-1",
  user_id: "user-1",
  workspace_id: "workspace-1",
  agent_id: "agent-1",
  severity: "critical",
  code: "lease_expired",
  summary: "Trigger dispatch lease expired.",
  target_type: "triggerDispatch",
  target_id: "dispatch-1",
  status: "open",
  dedup_key: "trigger-dispatch:dispatch-1:lease_expired",
  delivery_status: "pending",
  delivery_attempts: 0,
  last_delivery_at: null,
  data_json: '{"runId":"run-1"}',
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
};

const statement = (
  input: {
    first?: unknown;
    results?: unknown[];
    changes?: number;
    values?: unknown[];
  } = {},
) => {
  const values: unknown[] = input.values ?? [];
  let result: D1PreparedStatement;
  result = {
    bind(...nextValues: unknown[]) {
      values.push(...nextValues);
      return result;
    },
    async first<T>() {
      return (input.first ?? null) as T | null;
    },
    async all<T>() {
      return { results: (input.results ?? []) as T[] };
    },
    async run() {
      return { success: true, meta: { changes: input.changes ?? 1 } };
    },
  } satisfies D1PreparedStatement;
  return { result, values };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operator alerts", () => {
  it("does not query or deliver when a complete webhook configuration is absent", async () => {
    const prepare = vi.fn();
    const env = { DB: { prepare, batch: vi.fn() } } as unknown as Env;

    await expect(deliverPendingOperatorAlerts(env)).resolves.toEqual({
      configured: false,
      inspected: 0,
      delivered: 0,
      failed: 0,
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects insecure non-test webhook destinations", async () => {
    const prepare = vi.fn();
    const env = {
      OPERLOOM_OPERATOR_ALERT_WEBHOOK_URL: "http://alerts.example.test/ingest",
      OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET: "operator-alert-secret-0001",
      DB: { prepare, batch: vi.fn() },
    } as unknown as Env;

    const result = await deliverPendingOperatorAlerts(env);

    expect(result.configured).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("signs and records successful alert delivery with a compare-and-set", async () => {
    const select = statement({ results: [alert] });
    const update = statement({ changes: 1 });
    const prepare = vi.fn().mockReturnValueOnce(select.result).mockReturnValueOnce(update.result);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      OPERLOOM_OPERATOR_ALERT_WEBHOOK_URL: "https://alerts.example.test/ingest",
      OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET: "operator-alert-secret-0001",
      DB: { prepare, batch: vi.fn() },
    } as unknown as Env;

    const result = await deliverPendingOperatorAlerts(env, {
      now: new Date("2026-07-12T00:01:00.000Z"),
    });

    expect(result).toEqual({ configured: true, inspected: 1, delivered: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://alerts.example.test/ingest"),
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        headers: expect.objectContaining({
          "x-operloom-alert-id": "alert-1",
          "x-operloom-alert-signature": expect.any(String),
        }),
      }),
    );
    expect(update.values).toEqual([
      "delivered",
      "2026-07-12T00:01:00.000Z",
      "2026-07-12T00:01:00.000Z",
      "alert-1",
      0,
    ]);
  });

  it("does not follow receiver redirects and records redacted delivery diagnostics", async () => {
    const select = statement({ results: [alert] });
    const update = statement({ changes: 1 });
    const prepare = vi.fn().mockReturnValueOnce(select.result).mockReturnValueOnce(update.result);
    const fetchMock = vi.fn(async () => new Response(null, { status: 307 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      OPERLOOM_OPERATOR_ALERT_WEBHOOK_URL: "https://alerts.example.test/ingest",
      OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET: "operator-alert-secret-0001",
      DB: { prepare, batch: vi.fn() },
    } as unknown as Env;

    const result = await deliverPendingOperatorAlerts(env, {
      now: new Date("2026-07-12T00:01:00.000Z"),
    });

    expect(result).toEqual({ configured: true, inspected: 1, delivered: 0, failed: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://alerts.example.test/ingest"),
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(update.values).toEqual([
      "failed",
      "2026-07-12T00:01:00.000Z",
      "2026-07-12T00:01:00.000Z",
      "alert-1",
      0,
    ]);
    expect(warn).toHaveBeenCalledWith("Operator alert delivery failed", {
      alertId: "alert-1",
      endpointOrigin: "https://alerts.example.test",
      attempt: 1,
      reason: "receiver_rejected",
      status: 307,
    });
  });

  it("updates alerts only inside the active admin tenant and writes audit evidence", async () => {
    const membership = statement({
      first: {
        id: "membership-1",
        user_id: "user-1",
        workspace_id: "workspace-1",
        role: "owner",
        status: "active",
        roles_json: '["owner"]',
        permissions_json: "[]",
        data_json: "{}",
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
    });
    const update = statement();
    const audit = statement();
    const queries: string[] = [];
    const env = {
      DB: {
        prepare(query: string) {
          queries.push(query);
          if (query.includes("FROM memberships")) return membership.result;
          return query.includes("UPDATE control_operator_alerts") ? update.result : audit.result;
        },
        async batch() {
          return [
            { success: true, meta: { changes: 1 } },
            { success: true, meta: { changes: 1 } },
          ] as D1Result[];
        },
      },
    } as Env;
    const response = await handleUpdateOperatorAlert(
      new Request("https://control.test/admin/operator-alerts/alert-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "resolved" }),
      }),
      env,
      { scope: { userId: "user-1", workspaceId: "workspace-1" }, agentId: "agent-1" },
      "alert-1",
    );

    expect(response.status).toBe(200);
    expect(update.values.slice(2)).toEqual(["alert-1", "user-1", "workspace-1"]);
    expect(queries.some((query) => query.includes("INSERT INTO control_audit_events"))).toBe(true);
  });

  it("lets an admin requeue exhausted delivery without reopening a resolved alert", async () => {
    const membershipStatement = statement({
      first: {
        id: "membership-1",
        user_id: "user-1",
        workspace_id: "workspace-1",
        role: "owner",
        status: "active",
        roles_json: '["owner"]',
        permissions_json: "[]",
        data_json: "{}",
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
    });
    const update = statement();
    const audit = statement();
    const env = {
      DB: {
        prepare(query: string) {
          if (query.includes("FROM memberships")) return membershipStatement.result;
          return query.includes("UPDATE control_operator_alerts") ? update.result : audit.result;
        },
        async batch() {
          return [
            { success: true, meta: { changes: 1 } },
            { success: true, meta: { changes: 1 } },
          ] as D1Result[];
        },
      },
    } as Env;

    const response = await handleRetryOperatorAlertDelivery(
      env,
      {
        scope: { userId: "user-1", workspaceId: "workspace-1" },
        agentId: "agent-1",
      },
      "alert-1",
    );

    expect(response.status).toBe(200);
    expect(update.values.slice(1)).toEqual(["alert-1", "user-1", "workspace-1"]);
  });
});
