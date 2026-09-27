import { describe, expect, it, vi } from "vitest";

import {
  createArtifactBlob,
  handleGetArtifactBlob,
  handleGetRetentionPolicy,
  handleUpdateRetentionPolicy,
  sweepExpiredArtifacts,
  sweepExpiredChatMessages,
  sweepExpiredOperationalData,
} from "./artifact-lifecycle";
import type { AgentIdentity, D1PreparedStatement, D1Result, Env, R2Bucket } from "./types";

const identity: AgentIdentity = {
  scope: { userId: "user-1", workspaceId: "workspace-1" },
  agentId: "agent-1",
};

const createStatement = (overrides: Record<string, unknown> = {}): D1PreparedStatement => {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
    ...overrides,
  } as D1PreparedStatement;
  return statement;
};

const createBucket = (): R2Bucket => ({
  put: vi.fn(async () => ({})),
  get: vi.fn(async () => null),
  delete: vi.fn(async () => undefined),
});

describe("artifact lifecycle", () => {
  it("fails closed when blob storage is unavailable", async () => {
    const env = { DB: { prepare: vi.fn(), batch: vi.fn() } } as unknown as Env;
    const response = await createArtifactBlob(env, identity, {
      kind: "report",
      mimeType: "text/plain",
      contentBase64: btoa("retained output"),
    });

    expect(response.status).toBe(503);
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it("stores blobs under a tenant-scoped key before recording canonical metadata", async () => {
    const statement = createStatement({
      run: vi.fn(async () => ({ success: true, meta: { changes: 2 } })),
    });
    const bucket = createBucket();
    const env = {
      ARTIFACTS: bucket,
      DB: { prepare: vi.fn(() => statement), batch: vi.fn() },
    } as unknown as Env;

    const response = await createArtifactBlob(env, identity, {
      kind: "report",
      title: "Readiness report",
      mimeType: "text/plain",
      contentBase64: btoa("retained output"),
      data: { source: "test" },
    });
    const body = (await response.json()) as { artifact: { id: string; contentSha256: string } };

    expect(response.status).toBe(201);
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringMatching(/^tenants\/user-1\/workspace-1\/artifacts\/cf-artifact-/),
      expect.any(Uint8Array),
      expect.objectContaining({
        httpMetadata: { contentType: "text/plain" },
        customMetadata: expect.objectContaining({
          artifactId: body.artifact.id,
          userId: "user-1",
          workspaceId: "workspace-1",
          contentSha256: body.artifact.contentSha256,
        }),
      }),
    );
    expect(statement.run).toHaveBeenCalledOnce();
  });

  it("rejects oversized base64 before decoding or writing storage", async () => {
    const bucket = createBucket();
    const env = {
      ARTIFACTS: bucket,
      DB: { prepare: vi.fn(), batch: vi.fn() },
    } as unknown as Env;

    const response = await createArtifactBlob(env, identity, {
      kind: "report",
      mimeType: "application/octet-stream",
      contentBase64: "A".repeat(Math.ceil((5 * 1024 * 1024) / 3) * 4 + 1),
    });

    expect(response.status).toBe(413);
    expect(bucket.put).not.toHaveBeenCalled();
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it("removes an orphaned blob when the metadata write fails", async () => {
    const statement = createStatement({
      run: vi.fn(async () => {
        throw new Error("D1 unavailable");
      }),
    });
    const bucket = createBucket();
    const env = {
      ARTIFACTS: bucket,
      DB: { prepare: vi.fn(() => statement), batch: vi.fn() },
    } as unknown as Env;

    await expect(
      createArtifactBlob(env, identity, {
        kind: "report",
        mimeType: "text/plain",
        contentBase64: btoa("retained output"),
      }),
    ).rejects.toThrow("D1 unavailable");
    expect(bucket.delete).toHaveBeenCalledOnce();
  });

  it("atomically rejects aggregate quota exhaustion and removes the staged blob", async () => {
    const statement = createStatement({
      run: vi.fn(async () => ({ success: true, meta: { changes: 0 } })),
    });
    const bucket = createBucket();
    const env = {
      ARTIFACTS: bucket,
      DB: { prepare: vi.fn(() => statement), batch: vi.fn() },
    } as unknown as Env;

    const response = await createArtifactBlob(env, identity, {
      kind: "report",
      mimeType: "text/plain",
      contentBase64: btoa("retained output"),
    });

    expect(response.status).toBe(409);
    expect(bucket.delete).toHaveBeenCalledOnce();
    expect(statement.bind).toHaveBeenCalledWith(
      expect.any(String),
      "user-1",
      "workspace-1",
      "report",
      expect.stringMatching(/^artifact:\/\//),
      null,
      "text/plain",
      15,
      expect.stringMatching(/^tenants\/user-1\/workspace-1\/artifacts\//),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "standard",
      "{}",
      expect.any(String),
      "user-1",
      "workspace-1",
      1_000,
      "user-1",
      "workspace-1",
      15,
      100 * 1024 * 1024,
    );
  });

  it("does not reveal an artifact outside the authenticated tenant scope", async () => {
    const statement = createStatement({ first: vi.fn(async () => null) });
    const bucket = createBucket();
    const env = {
      ARTIFACTS: bucket,
      DB: { prepare: vi.fn(() => statement), batch: vi.fn() },
    } as unknown as Env;

    const response = await handleGetArtifactBlob(env, identity, "artifact-other-tenant");

    expect(response.status).toBe(404);
    expect(statement.bind).toHaveBeenCalledWith("artifact-other-tenant", "user-1", "workspace-1");
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("deletes expired R2 content before conditionally tombstoning metadata", async () => {
    const expired = {
      id: "artifact-1",
      user_id: "user-1",
      workspace_id: "workspace-1",
      storage_provider: "r2" as const,
      storage_key: "tenants/user-1/workspace-1/artifacts/artifact-1",
      expires_at: "2026-07-01T00:00:00.000Z",
      deleted_at: null,
    };
    const select = createStatement({ all: vi.fn(async () => ({ results: [expired] })) });
    const update = createStatement();
    const bucket = createBucket();
    const env = {
      ARTIFACTS: bucket,
      DB: {
        prepare: vi.fn((query: string) => (query.includes("SELECT id") ? select : update)),
        batch: vi.fn(),
      },
    } as unknown as Env;

    const result = await sweepExpiredArtifacts(env, {
      now: new Date("2026-07-12T00:00:00.000Z"),
    });

    expect(result).toEqual({ inspected: 1, deleted: 1, failed: 0 });
    expect(vi.mocked(env.DB.prepare).mock.calls[0]?.[0]).toContain(
      "NOT EXISTS (\n         SELECT 1 FROM control_data_export_objects pinned",
    );
    expect(bucket.delete).toHaveBeenCalledWith(expired.storage_key);
    expect(update.bind).toHaveBeenCalledWith(
      "2026-07-12T00:00:00.000Z",
      "artifact-1",
      "user-1",
      "workspace-1",
      "2026-07-12T00:00:00.000Z",
    );
  });

  it("keeps R2 metadata live when the storage binding is unavailable", async () => {
    const expired = {
      id: "artifact-1",
      user_id: "user-1",
      workspace_id: "workspace-1",
      storage_provider: "r2" as const,
      storage_key: "scoped-key",
      expires_at: "2026-07-01T00:00:00.000Z",
      deleted_at: null,
    };
    const select = createStatement({ all: vi.fn(async () => ({ results: [expired] })) });
    const prepare = vi.fn(() => select);
    const env = { DB: { prepare, batch: vi.fn() } } as unknown as Env;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await sweepExpiredArtifacts(env, {
      now: new Date("2026-07-12T00:00:00.000Z"),
    });

    expect(result).toEqual({ inspected: 1, deleted: 0, failed: 1 });
    expect(prepare).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("returns explicit safe defaults before a workspace policy is configured", async () => {
    const statement = createStatement({ first: vi.fn(async () => null) });
    const env = {
      DB: { prepare: vi.fn(() => statement), batch: vi.fn() },
    } as unknown as Env;

    const response = await handleGetRetentionPolicy(env, identity);

    expect(await response.json()).toEqual({
      ok: true,
      policy: {
        artifactRetentionDays: 90,
        operationalEventRetentionDays: 30,
        runtimeTraceRetentionDays: 14,
        chatMessageRetentionDays: 90,
        runPayloadRetentionDays: 90,
        auditActionRetentionDays: 365,
        confirmed: false,
        source: "default",
      },
    });
  });

  it("rejects workspace retention changes from non-admin members", async () => {
    const membership = {
      id: "membership-1",
      user_id: "user-1",
      workspace_id: "workspace-1",
      role: "member",
      status: "active",
      roles_json: "[]",
      permissions_json: "[]",
      data_json: "{}",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    };
    const statement = createStatement({ first: vi.fn(async () => membership) });
    const batch = vi.fn();
    const env = { DB: { prepare: vi.fn(() => statement), batch } } as unknown as Env;
    const request = new Request("https://control.test/workbench/retention-policy", {
      method: "PATCH",
      body: JSON.stringify({
        artifactRetentionDays: 60,
        operationalEventRetentionDays: 20,
        runtimeTraceRetentionDays: 7,
      }),
    });

    const response = await handleUpdateRetentionPolicy(request, env, identity);

    expect(response.status).toBe(403);
    expect(batch).not.toHaveBeenCalled();
  });

  it("atomically updates an admin retention policy and its audit evidence", async () => {
    const membership = {
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
    };
    const membershipStatement = createStatement({ first: vi.fn(async () => membership) });
    const policyStatement = createStatement();
    const expiryStatement = createStatement();
    const auditStatement = createStatement();
    const prepared: string[] = [];
    const batch = vi.fn(async () => [] as D1Result[]);
    const env = {
      DB: {
        prepare: vi.fn((query: string) => {
          prepared.push(query);
          if (query.includes("FROM memberships")) return membershipStatement;
          if (query.includes("control_retention_policies")) return policyStatement;
          return query.includes("UPDATE control_artifacts") ? expiryStatement : auditStatement;
        }),
        batch,
      },
    } as unknown as Env;
    const request = new Request("https://control.test/workbench/retention-policy", {
      method: "PATCH",
      body: JSON.stringify({
        artifactRetentionDays: 60,
        operationalEventRetentionDays: 20,
        runtimeTraceRetentionDays: 7,
      }),
    });

    const response = await handleUpdateRetentionPolicy(request, env, identity);

    expect(response.status).toBe(200);
    expect(batch).toHaveBeenCalledWith([policyStatement, expiryStatement, auditStatement]);
    expect(expiryStatement.bind).toHaveBeenCalledWith(60, "user-1", "workspace-1");
    expect(prepared.some((query) => query.includes("retention.policy.updated"))).toBe(true);
  });

  it("prunes operational events and traces in bounded policy-aware batches", async () => {
    const statements = Array.from({ length: 13 }, () => createStatement());
    let index = 0;
    const env = {
      DB: {
        prepare: vi.fn(() => statements[index++]!),
        batch: vi.fn(
          async () =>
            [
              { meta: { changes: 3 } },
              { meta: { changes: 8 } },
              { meta: { changes: 2 } },
              { meta: { changes: 5 } },
              { meta: { changes: 4 } },
              { meta: { changes: 7 } },
              { meta: { changes: 9 } },
              { meta: { changes: 2 } },
              { meta: { changes: 4 } },
              { meta: { changes: 1 } },
              { meta: { changes: 3 } },
              { meta: { changes: 2 } },
              { meta: { changes: 6 } },
            ] as D1Result[],
        ),
      },
    } as unknown as Env;

    const result = await sweepExpiredOperationalData(env, {
      now: new Date("2026-07-12T00:00:00.000Z"),
      limit: 25,
    });

    expect(result).toEqual({
      eventsDeleted: 3,
      spansDeleted: 8,
      tracesDeleted: 2,
      runPayloadsPruned: 5,
      chatPayloadsPruned: 4,
      workflowPayloadsPruned: 7,
      toolPayloadsPruned: 9,
      actionPayloadsPruned: 2,
      actionReviewPayloadsPruned: 4,
      auditEventsDeleted: 1,
      policyDecisionsDeleted: 3,
      approvalsDeleted: 2,
      actionLedgerDeleted: 6,
    });
    expect(statements[0]?.bind).toHaveBeenCalledWith("2026-07-12T00:00:00.000Z", 25);
    expect(statements[1]?.bind).toHaveBeenCalledWith("2026-07-12T00:00:00.000Z", 25);
    expect(statements[2]?.bind).toHaveBeenCalledWith("2026-07-12T00:00:00.000Z", 25);
    expect(statements[3]?.bind).toHaveBeenCalledWith(
      "2026-07-12T00:00:00.000Z",
      "2026-07-12T00:00:00.000Z",
      25,
    );
  });

  it("purges expired Durable Object chat messages before marking the retained thread", async () => {
    const list = createStatement({
      all: vi.fn(async () => ({
        results: [
          {
            thread_id: "thread-1",
            session_id: "session-1",
            user_id: "user-1",
            workspace_id: "workspace-1",
            agent_id: "agent-1",
            status: "active",
            upstream_json: JSON.stringify({ instanceName: "thread-instance-1" }),
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            last_seen_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      })),
    });
    const update = createStatement();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const env = {
      OPERLOOM_AGENT_CONNECTION_SECRET: "lifecycle-secret",
      ThreadChatAgent: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch })),
      },
      DB: {
        prepare: vi.fn((query: string) => (query.includes("FROM chat_threads") ? list : update)),
        batch: vi.fn(),
      },
    } as unknown as Env;

    const result = await sweepExpiredChatMessages(env, {
      now: new Date("2026-07-12T00:00:00.000Z"),
      limit: 10,
    });

    expect(result).toEqual({ inspected: 1, purged: 1, failed: 0, configured: true });
    expect(fetch).toHaveBeenCalledWith(
      "https://thread-agent.internal/internal/lifecycle-purge",
      expect.objectContaining({
        method: "POST",
        headers: { "x-operloom-lifecycle-secret": "lifecycle-secret" },
      }),
    );
    expect(update.bind).toHaveBeenCalledWith(
      "2026-01-01T00:00:00.000Z",
      "2026-07-12T00:00:00.000Z",
      "thread-1",
      "user-1",
      "workspace-1",
      "2026-01-01T00:00:00.000Z",
    );
  });
});
