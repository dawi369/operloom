import { describe, expect, it, vi } from "vitest";

import {
  createExpoNotificationPort,
  createMemoryNotificationPort,
  enqueueNotificationEvent,
  notificationIntentForEvent,
  processNotificationQueue,
  sweepNotificationDeliveries,
} from "./notification-delivery";
import { createMemoryCredentialVault } from "./credential-vault";
import type { D1PreparedStatement, Env } from "./types";

const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("mobile notification delivery", () => {
  it("maps only approval and terminal evidence to opaque routes", () => {
    expect(
      notificationIntentForEvent({
        type: "approval.requested",
        targetType: "approvalRequest",
        targetId: "approval-1",
      }),
    ).toMatchObject({ category: "approval", route: "approvals", targetId: "approval-1" });
    expect(
      notificationIntentForEvent({
        type: "action.updated",
        targetId: "proposal-1",
        data: { status: "outcome_unknown", providerBody: "must-not-escape" },
      }),
    ).toMatchObject({ category: "terminal", route: "actions", targetId: "proposal-1" });
    expect(
      notificationIntentForEvent({
        type: "run.progress",
        targetId: "run-1",
      }),
    ).toBeNull();
  });

  it("sends generic lock-screen text and opaque routing metadata", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({ data: { status: "ok", id: "ticket-1" } }),
    );
    const port = createExpoNotificationPort(fetcher);

    await expect(
      port.deliver({
        token: "ExponentPushToken[opaque-token]",
        title: "Workbench update",
        body: "Open Operloom for the latest result.",
        data: { route: "history", recordId: "run-1" },
      }),
    ).resolves.toEqual({ ok: true, ticketId: "ticket-1" });

    const request = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(request).toEqual({
      to: "ExponentPushToken[opaque-token]",
      title: "Workbench update",
      body: "Open Operloom for the latest result.",
      data: { route: "history", recordId: "run-1" },
      sound: "default",
      channelId: "workbench",
    });
    expect(JSON.stringify(request)).not.toContain("customer");
  });

  it("classifies invalid provider tokens as terminal", async () => {
    const port = createExpoNotificationPort(async () =>
      response({ data: { status: "error", details: { error: "DeviceNotRegistered" } } }),
    );
    await expect(
      port.deliver({
        token: "ExponentPushToken[expired]",
        title: "Action needed",
        body: "Open Operloom to review.",
        data: { route: "approvals", recordId: "approval-1" },
      }),
    ).resolves.toEqual({
      ok: false,
      code: "DeviceNotRegistered",
      invalidToken: true,
      retryable: false,
    });
  });

  it("provides a deterministic provider-neutral adapter", async () => {
    const port = createMemoryNotificationPort();
    await expect(
      port.deliver({
        token: "memory",
        title: "title",
        body: "body",
        data: { route: "history", recordId: "run" },
      }),
    ).resolves.toEqual({ ok: true, ticketId: "memory-ticket" });
    await expect(port.receipt("memory-ticket")).resolves.toEqual({ status: "delivered" });
  });

  it("persists queue handoff failures without failing terminal publication", async () => {
    const updates: string[] = [];
    const env = {
      WORKBENCH_PUSH_ENABLED: "true",
      NOTIFICATIONS: { send: vi.fn(async () => Promise.reject(new Error("queue unavailable"))) },
      DB: {
        prepare(query: string) {
          return {
            bind() {
              return this;
            },
            async first<T>() {
              return null as T | null;
            },
            async all<T>() {
              return query.includes("FROM control_client_devices")
                ? { results: [{ id: "device-1" }] as T[] }
                : { results: [] as T[] };
            },
            async run() {
              updates.push(query);
              return { meta: { changes: 1 } };
            },
          } satisfies D1PreparedStatement;
        },
        async batch() {
          return [];
        },
      },
    } as unknown as Env;
    await expect(
      enqueueNotificationEvent(
        env,
        {
          agentId: "agent-1",
          scope: { userId: "user-1", workspaceId: "workspace-1" },
        },
        { type: "run.completed", targetId: "run-1" },
      ),
    ).resolves.toEqual({ queued: 1 });
    expect(updates.some((query) => query.includes("queue_enqueue_failed"))).toBe(true);
  });

  it("requeues a stranded delivery during the bounded sweep", async () => {
    const send = vi.fn(async () => undefined);
    const updates: string[] = [];
    const env = {
      NOTIFICATIONS: { send },
      DB: {
        prepare(query: string) {
          return {
            bind() {
              return this;
            },
            async first<T>() {
              return null as T | null;
            },
            async all<T>() {
              return query.includes("last_error_code = 'queue_enqueue_failed'")
                ? { results: [{ id: "delivery-1" }] as T[] }
                : { results: [] as T[] };
            },
            async run() {
              updates.push(query);
              return { meta: { changes: 0 } };
            },
          } satisfies D1PreparedStatement;
        },
        async batch() {
          return [];
        },
      },
    } as unknown as Env;
    await expect(sweepNotificationDeliveries(env)).resolves.toMatchObject({ requeued: 1 });
    expect(send).toHaveBeenCalledWith({ deliveryId: "delivery-1", phase: "send" });
    expect(updates.some((query) => query.includes("last_error_code = NULL"))).toBe(true);
  });

  it("disables a device and terminally records an invalid provider token", async () => {
    const reference = await createMemoryCredentialVault().create({
      context: { workspaceId: "workspace-1" },
      name: "push:device-1",
      value: "ExponentPushToken[expired]",
    });
    const updates: Array<{ query: string; values: unknown[] }> = [];
    const env = {
      WORKBENCH_E2E_MODE: "true",
      WORKBENCH_VAULT_BACKEND: "memory",
      DB: {
        prepare(query: string) {
          let values: unknown[] = [];
          return {
            bind(...input: unknown[]) {
              values = input;
              return this;
            },
            async first<T>() {
              if (query.includes("FROM control_notification_deliveries"))
                return {
                  id: "delivery-1",
                  user_id: "user-1",
                  workspace_id: "workspace-1",
                  device_id: "device-1",
                  event_type: "run.completed",
                  target_type: "run",
                  target_id: "run-1",
                  route: "history",
                  status: "queued",
                  attempt_count: 0,
                  provider_ticket_id: null,
                  last_error_code: null,
                  expires_at: "2999-01-01T00:00:00.000Z",
                  delivered_at: null,
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                } as T;
              if (query.includes("FROM control_client_devices"))
                return {
                  id: "device-1",
                  user_id: "user-1",
                  workspace_id: "workspace-1",
                  installation_id: "installation-1",
                  platform: "ios",
                  provider: "expo",
                  vault_object_id: reference.id,
                  vault_version: reference.version,
                  status: "active",
                  last_seen_at: "2026-01-01T00:00:00.000Z",
                  app_version: "0.1.0",
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                  revoked_at: null,
                } as T;
              return null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              updates.push({ query, values });
              return { meta: { changes: 1 } };
            },
          } satisfies D1PreparedStatement;
        },
        async batch() {
          return [];
        },
      },
    } as unknown as Env;
    const ack = vi.fn();
    await processNotificationQueue(
      { messages: [{ body: { deliveryId: "delivery-1", phase: "send" }, ack, retry: vi.fn() }] },
      env,
      {
        port: createMemoryNotificationPort({
          delivery: {
            ok: false,
            code: "DeviceNotRegistered",
            invalidToken: true,
            retryable: false,
          },
        }),
      },
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(
      updates.some(
        (update) => update.query.includes("status = ?") && update.values[0] === "disabled",
      ),
    ).toBe(true);
    expect(
      updates.some(
        (update) =>
          update.query.includes("control_notification_deliveries") &&
          update.values.includes("DeviceNotRegistered"),
      ),
    ).toBe(true);
  });
});
