import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimDemoDailyUsage,
  demoConfigurationValid,
  demoMutationCapabilityForRequest,
  demoPackAllowed,
  requireDemoConcurrencyAvailable,
  requireDemoModelBudget,
} from "./demo-policy";
import type { AgentIdentity, D1PreparedStatement, Env } from "./types";

const identity: AgentIdentity = {
  scope: { userId: "user-1", workspaceId: "workspace-1" },
  agentId: "agent-1",
};

const statement = (overrides: Partial<D1PreparedStatement> = {}): D1PreparedStatement => {
  const value = {
    bind: vi.fn(),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({})),
    ...overrides,
  } as D1PreparedStatement;
  vi.mocked(value.bind).mockReturnValue(value);
  return value;
};

const demoEnv = (prepare = vi.fn(() => statement())) =>
  ({
    DB: { prepare, batch: vi.fn(async () => []) },
    OPENROUTER_API_KEY: "demo-key",
    WORKBENCH_DEMO_MODE: "true",
    WORKBENCH_DEMO_PACK_ALLOWLIST: JSON.stringify(["operloom", "repo-analyst", "baby-polymancer"]),
    WORKBENCH_DEMO_CHAT_DAILY_LIMIT: "20",
    WORKBENCH_DEMO_WORKFLOW_DAILY_LIMIT: "3",
    WORKBENCH_DEMO_MODEL_BUDGET_USD: "20",
    WORKBENCH_DEMO_ARTIFACT_WORKSPACE_BYTES: String(20 * 1024 * 1024),
    WORKBENCH_DEMO_RETENTION_DAYS: "7",
  }) as unknown as Env;

afterEach(() => vi.restoreAllMocks());

describe("public demo policy", () => {
  it("fails closed unless the exact checked-in limits and pack allowlist are present", () => {
    const env = demoEnv();
    expect(demoConfigurationValid(env)).toBe(true);
    expect(demoPackAllowed(env, "repo-analyst")).toBe(true);
    expect(demoPackAllowed(env, "custom-pack")).toBe(false);
    env.WORKBENCH_DEMO_CHAT_DAILY_LIMIT = "21";
    expect(demoConfigurationValid(env)).toBe(false);
  });

  it("blocks demo mutation surfaces while preserving pack execution and deletion", () => {
    expect(
      demoMutationCapabilityForRequest(new Request("https://demo.test/agents", { method: "POST" })),
    ).toBe("Custom agents");
    expect(
      demoMutationCapabilityForRequest(
        new Request("https://demo.test/triggers", { method: "POST" }),
      ),
    ).toBe("Schedules and webhooks");
    expect(
      demoMutationCapabilityForRequest(
        new Request("https://demo.test/agent-packs/repo-analyst/instantiate", { method: "POST" }),
      ),
    ).toBeNull();
    expect(
      demoMutationCapabilityForRequest(
        new Request("https://demo.test/workbench/workspace-deletion", { method: "POST" }),
      ),
    ).toBeNull();
  });

  it("returns a readable 429 when the daily claim cannot be acquired", async () => {
    let index = 0;
    const inserts = statement();
    const exhausted = statement({ first: vi.fn(async () => null) });
    const env = demoEnv(vi.fn(() => [inserts, exhausted][index++]!));
    const response = await claimDemoDailyUsage(env, identity, "chat");
    expect(response?.status).toBe(429);
    await expect(response?.json()).resolves.toMatchObject({ code: "demo_daily_limit_reached" });
  });

  it("rejects a second active run for the same user", async () => {
    let index = 0;
    const chat = statement({
      first: (async <T>() => ({ count: 1 }) as T) as D1PreparedStatement["first"],
    });
    const workflow = statement({
      first: (async <T>() => ({ count: 0 }) as T) as D1PreparedStatement["first"],
    });
    const response = await requireDemoConcurrencyAvailable(
      demoEnv(vi.fn(() => [chat, workflow][index++]!)),
      identity,
    );
    expect(response?.status).toBe(429);
    await expect(response?.json()).resolves.toMatchObject({
      code: "demo_concurrency_limit_reached",
    });
  });

  it("fails closed when the provider key is not a monthly $20 key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: { limit: 25, limit_remaining: 25, limit_reset: "monthly", usage_monthly: 0 },
        }),
      ),
    );
    const response = await requireDemoModelBudget(demoEnv());
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({ code: "demo_budget_unavailable" });
  });

  it("emits each crossed budget threshold once and returns 503 at exhaustion", async () => {
    const alert = statement({ run: vi.fn(async () => ({ meta: { changes: 1 } })) });
    const env = demoEnv(vi.fn(() => alert));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: { limit: 20, limit_remaining: 0, limit_reset: "monthly", usage_monthly: 20 },
        }),
      ),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await requireDemoModelBudget(env);
    expect(response?.status).toBe(503);
    expect(env.DB.prepare).toHaveBeenCalledTimes(3);
    await expect(response?.json()).resolves.toMatchObject({ code: "demo_budget_exhausted" });
  });
});
