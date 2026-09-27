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
