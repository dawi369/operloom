import { describe, expect, it, vi } from "vitest";

import {
  handleOperatorRetryWorkspaceDeletion,
  handleRetryWorkspaceDeletion,
  handleWorkspaceDeletionPlan,
} from "./workspace-data-lifecycle";
import type { AgentIdentity, D1PreparedStatement, Env } from "./types";

const identity: AgentIdentity = {
  scope: { userId: "user-1", workspaceId: "workspace-1" },
  agentId: "agent-1",
};

const membership = (role: "owner" | "member") => ({
  id: "membership-1",
  user_id: "user-1",
  workspace_id: "workspace-1",
  role,
  status: "active",
  roles_json: JSON.stringify([role]),
  permissions_json: "[]",
  data_json: "{}",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
});

const makeEnv = (role: "owner" | "member" = "owner") => {
  const queries: string[] = [];
  const bindings: unknown[][] = [];
  const env = {
    ARTIFACTS: {
      put: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(async () => ({
        body: new ReadableStream(),
        arrayBuffer: async () => new TextEncoder().encode("artifact body").buffer,
        httpMetadata: { contentType: "text/plain" },
      })),
    },
    DB: {
      prepare(query: string): D1PreparedStatement {
        queries.push(query);
        const statement: D1PreparedStatement = {
          bind(...nextValues: unknown[]) {
            bindings.push(nextValues);
            return statement;
          },
          async first<T>() {
            if (query.includes("FROM memberships")) return membership(role) as T;
            return null;
          },
          async all<T>() {
            if (query.includes("FROM control_artifacts")) {
              return {
                results: [
                  {
                    id: "artifact-1",
                    user_id: "user-1",
                    workspace_id: "workspace-1",
                    kind: "report",
                    uri: "artifact://artifact-1",
                    mime_type: "text/plain",
                    storage_provider: "r2",
                    storage_key: "tenants/user-1/workspace-1/artifacts/artifact-1",
                    content_sha256:
                      "9938be87d35f2a7a2b80237e8dc71806b209aaea8252f12c1b12949f61d40476",
                    retention_class: "standard",
                    expires_at: "2026-10-01T00:00:00.000Z",
                    deleted_at: null,
                    data_json: "{}",
                    created_at: "2026-07-01T00:00:00.000Z",
                  },
                ] as T[],
              };
            }
            if (query.includes("FROM control_runs")) {
              return { results: [{ id: "run-1", user_id: "user-1" }] as T[] };
            }
            return { results: [] as T[] };
          },
          async run() {
            return { success: true };
          },
        };
        return statement;
      },
      async batch() {
        return [];
      },
    },
  } as unknown as Env;
  return { env, queries, bindings };
};

describe("workspace data lifecycle", () => {
  it("returns an exact non-executable deletion inventory", async () => {
    const { env } = makeEnv();

    const response = await handleWorkspaceDeletionPlan(env, identity);
    const body = (await response.json()) as {
      plan: {
        d1RowsByCollection: Record<string, number>;
        r2Objects: number;
        executable: boolean;
        blockers: string[];
      };
    };

    expect(body.plan.d1RowsByCollection.control_runs).toBe(1);
    expect(body.plan.d1RowsByCollection.control_artifacts).toBe(1);
    expect(body.plan.r2Objects).toBe(1);
    expect(body.plan.executable).toBe(false);
    expect(body.plan.blockers).toHaveLength(2);
  });

  it("does not expose deletion inventories to ordinary members", async () => {
    const { env, queries } = makeEnv("member");

    const deletionResponse = await handleWorkspaceDeletionPlan(env, identity);

    expect(deletionResponse.status).toBe(403);
    expect(queries.filter((query) => !query.includes("FROM memberships"))).toHaveLength(0);
  });

  it("queues a failed purge for a fresh-authenticated initiating owner without resetting progress", async () => {
    const queries: string[] = [];
    const env = {
      DB: {
        prepare(query: string) {
          queries.push(query);
          const statement = {
            bind() {
              return statement;
            },
            async first<T>() {
              if (query.includes("FROM memberships")) return membership("owner") as T;
              if (query.includes("FROM workspaces")) {
                return {
                  id: "workspace-1",
                  name: "Example Workspace",
                  status: "failed",
                  deletion_requested_by_user_id: "user-1",
                } as T;
              }
              if (query.includes("FROM control_data_jobs")) {
                return { id: "purge-1", status: "failed" } as T;
              }
              return null;
            },
          };
          return statement;
        },
        async batch(statements: unknown[]) {
          return statements.map(() => ({ success: true, meta: { changes: 1 } }));
        },
      },
    } as unknown as Env;
    const response = await handleRetryWorkspaceDeletion(
      new Request("https://control.test/workbench/workspace-deletion/retry", {
        method: "POST",
        body: JSON.stringify({
          workspaceName: "Example Workspace",
          reauthenticatedAt: new Date().toISOString(),
        }),
      }),
      env,
      identity,
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      deletion: { status: "purging", purgeJobId: "purge-1", canRetry: false },
    });
    const retryUpdate = queries.find((query) =>
      query.includes("manual_retry_count = manual_retry_count + 1"),
    );
    expect(retryUpdate).toBeDefined();
    expect(retryUpdate).not.toContain("cursor_json");
    expect(queries.some((query) => query.includes("workspace.purge.retry_requested"))).toBe(true);
  });

  it("rejects failed purge retry without fresh reauthentication", async () => {
    const { env } = makeEnv();
    vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      const statement = {
        bind() {
          return statement;
        },
        async first<T>() {
          if (query.includes("FROM memberships")) return membership("owner") as T;
          if (query.includes("FROM workspaces")) {
            return {
              id: "workspace-1",
              name: "Example Workspace",
              status: "failed",
              deletion_requested_by_user_id: "user-1",
            } as T;
          }
          return null;
        },
      };
      return statement as D1PreparedStatement;
    });
    const response = await handleRetryWorkspaceDeletion(
      new Request("https://control.test/workbench/workspace-deletion/retry", {
        method: "POST",
        body: JSON.stringify({
          workspaceName: "Example Workspace",
          reauthenticatedAt: "2026-01-01T00:00:00.000Z",
        }),
      }),
      env,
      identity,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "reauthentication_required" });
  });

  it("allows a signed platform operator to resume only an alerted failed purge", async () => {
    const queries: string[] = [];
    const env = {
      DB: {
        prepare(query: string) {
          queries.push(query);
          const statement = {
            bind() {
              return statement;
            },
            async first<T>() {
              if (query.includes("FROM workspaces")) {
                return {
                  id: "orphaned-workspace",
                  name: "Orphaned Workspace",
                  status: "failed",
                } as T;
              }
              if (query.includes("FROM control_data_jobs")) {
                return { id: "purge-orphaned", status: "failed" } as T;
              }
              return null;
            },
          };
          return statement;
        },
        async batch(statements: unknown[]) {
          return statements.map(() => ({ success: true, meta: { changes: 1 } }));
        },
      },
    } as unknown as Env;
    const response = await handleOperatorRetryWorkspaceDeletion(
      new Request("https://control.test/admin/workspace-purges/orphaned-workspace/retry", {
        method: "POST",
        headers: { "x-operloom-platform-operator": "true" },
        body: JSON.stringify({
          workspaceName: "Orphaned Workspace",
          reason: "The initiating owner account is no longer available.",
        }),
      }),
      env,
      identity,
      "orphaned-workspace",
      true,
    );

    expect(response.status).toBe(202);
    expect(queries.some((query) => query.includes("severity = 'critical'"))).toBe(true);
    expect(queries.some((query) => query.includes("workspace.purge.retry_requested"))).toBe(true);
  });

  it("hides the operator purge command without a signed platform assertion", async () => {
    const { env } = makeEnv();
    const response = await handleOperatorRetryWorkspaceDeletion(
      new Request("https://control.test/admin/workspace-purges/workspace-1/retry", {
        method: "POST",
        body: JSON.stringify({ workspaceName: "Example", reason: "A sufficient reason." }),
      }),
      env,
      identity,
      "workspace-1",
      false,
    );
    expect(response.status).toBe(404);
  });
});
