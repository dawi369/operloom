import { describe, expect, it } from "vitest";

import { responseSchemaContract, responseSchemas } from "./response-schemas.js";

const validFixtures = {
  session: { ok: true },
  threads: { ok: true, threads: [] },
  accounts: { ok: true, accounts: [] },
  workspaces: { ok: true, workspaces: [] },
  workspaceMutation: { ok: true },
  agents: { ok: true, agents: [] },
  agentMutation: { ok: true },
  workflows: { ok: true, runnable: true, workflows: [] },
  toolRun: { ok: true },
  runList: { ok: true, runs: [] },
  runDetail: { ok: true, snapshot: null },
  executionRun: { ok: true, snapshot: null },
  artifacts: { ok: true, artifacts: [] },
  approvals: { ok: true, approvals: [] },
  connections: { ok: true, connections: [] },
  connectionAuthorization: {
    ok: true,
    authorizationUrl: "https://identity.example.test/authorize",
    expiresAt: "2026-08-12T20:00:00.000Z",
  },
  actions: { ok: true, proposals: [] },
  managedState: { ok: true, states: [] },
  devices: { ok: true, devices: [] },
  notificationPreferences: { ok: true },
  billing: {
    ok: true,
    provider: "manual",
    entitlements: {
      planId: "free",
      planLabel: "Free",
      status: "active",
      limits: {
        dailyModelCalls: 1,
        dailyToolCalls: 1,
        dailyTokens: 1,
        runModelCalls: 1,
        runToolCalls: 1,
        runTokens: 1,
        concurrentOperations: 1,
      },
      features: [],
      seats: 1,
      provider: "manual",
      subscribed: false,
    },
    subscription: null,
  },
  billingPlans: { ok: true, defaultPlanId: "free", plans: [] },
  billingLink: { ok: true, url: "https://billing.example/session" },
  billingUsage: { ok: true, from: "2026-01-01", to: "2026-01-02", days: [], reports: [] },
  fleet: { ok: true, generatedAt: "2026-01-01T00:00:00.000Z", agents: [] },
  fleetTimeline: { ok: true, agent: { id: "a", name: "A" }, updates: [], nextBefore: null },
  memoryList: {
    ok: true,
    records: [],
    limits: { recordBytes: 1, activeRecords: 1, totalBytes: 1 },
  },
  memoryRecord: {
    ok: true,
    record: {
      id: "m1",
      kind: "note",
      key: "k",
      title: "t",
      content: {},
      source: "user",
      status: "active",
      scope: "user",
      agentId: null,
      target: null,
      expiresAt: null,
      flags: [],
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  },
  behaviorTemplates: { ok: true, templates: [{ id: "assistant-analyst" }] },
  toolPolicy: { ok: true },
  workspaceMembers: { ok: true, members: [{ userId: "u1" }] },
  retentionPolicy: { ok: true },
  dataJob: { ok: true },
  workspaceDeletion: { ok: true },
  adminMemoryList: {
    ok: true,
    records: [],
    members: [{ userId: "u1", label: "a@b.co" }],
    policy: {
      autoActivate: ["note"],
      ttlDays: { goal: null, preference: null, watchlist: 30, conclusion: 7, note: 14 },
    },
    usage: [{ userId: "u1", activeRecords: 3, totalBytes: 120 }],
    limits: { recordBytes: 1, activeRecords: 1, totalBytes: 1 },
  },
  adminMemoryBulk: { ok: true, archived: 2, preview: false },
  adminEvents: {
    ok: true,
    events: [
      {
        id: "e1",
        type: "memory.admin_edited",
        summary: "Edited",
        actorUserId: "u1",
        actorLabel: "a@b.co",
        agentId: "agent",
        targetType: "memory",
        targetId: "m1",
        data: {},
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    types: ["memory.admin_edited"],
    nextBefore: null,
  },
  adminMemoryRecord: {
    ok: true,
    record: {
      id: "m1",
      kind: "note",
      key: "k",
      title: "t",
      content: {},
      source: "user",
      status: "active",
      scope: "user",
      agentId: null,
      target: null,
      expiresAt: null,
      flags: [],
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      userId: "u1",
      userLabel: "a@b.co",
    },
  },
  billingUsageReport: {
    ok: true,
    report: {
      id: "r1",
      day: "2026-01-01",
      status: "skipped",
      provider: "manual",
      reportedAt: null,
    },
  },
} satisfies Record<keyof typeof responseSchemas, unknown>;

describe("workbench response schemas", () => {
  it("covers every registered schema with valid and additive fixtures", () => {
    expect(Object.keys(responseSchemaContract).sort()).toEqual(Object.keys(validFixtures).sort());
    for (const [name, schema] of Object.entries(responseSchemas)) {
      const fixture = validFixtures[name as keyof typeof validFixtures];
      expect(schema.safeParse(fixture).success, name).toBe(true);
      expect(
        schema.safeParse({ ...(fixture as object), futureField: { version: 2 } }).success,
        name,
      ).toBe(true);
    }
  });

  it("rejects malformed known envelope fields for every schema", () => {
    for (const [name, schema] of Object.entries(responseSchemas)) {
      const fixture = validFixtures[name as keyof typeof validFixtures] as Record<string, unknown>;
      expect(schema.safeParse({ ...fixture, ok: "yes" }).success, name).toBe(false);
    }
  });

  it("rejects unsupported chat protocol versions", () => {
    expect(
      responseSchemas.session.safeParse({ ok: true, connection: { chatProtocolVersion: 3 } })
        .success,
    ).toBe(false);
  });
});
