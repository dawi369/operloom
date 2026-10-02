import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hasModelVisibleToolCandidate,
  modelToolKey,
  resetModelToolCandidateCacheForTests,
  runtimeModelToolBindingsForPack,
} from "./model-tools";
import { createAgentBehaviorSnapshot } from "./agent-behavior-templates";
import type { AgentIdentity, Env } from "./types";
import { localAgentPacks } from "../../../agent-packs";
import { manifest as complexOperator } from "../../../examples/complex-operator/manifest";

// Forks may hide the upstream demo packs with conformanceOnly.
const demoPacksInstalled = ["repo-analyst", "baby-polymancer", "baby-swordfish"].every((id) =>
  localAgentPacks.some((pack) => pack.id === id),
);

const urlInspectToolName = "url.inspect";

const identity = {
  agentId: "agent_1",
  scope: {
    userId: "user_1",
    workspaceId: "workspace_1",
    accountId: "account_1",
    accountSource: "test",
  },
} as AgentIdentity;

const agentWithBehavior = (behavior?: unknown) => ({
  id: identity.agentId,
  workspace_id: identity.scope.workspaceId,
  name: "Test agent",
  description: null,
  status: "active",
  is_default: 0,
  created_by_user_id: identity.scope.userId,
  data_json: JSON.stringify({
    profile: "analyst",
    ...(behavior ? { behavior } : {}),
  }),
  created_at: "2026-06-23T00:00:00.000Z",
  updated_at: "2026-06-23T00:00:00.000Z",
});

const envWithPermission = (
  permission: { status: string; data_json: string } | null,
  agent = null as ReturnType<typeof agentWithBehavior> | null,
) => {
  let firstCallCount = 0;
  const first = vi.fn(() => {
    firstCallCount += 1;
    return Promise.resolve(firstCallCount % 2 === 1 ? agent : permission);
  });
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return {
    env: { DB: { prepare } } as unknown as Env,
    first,
    bind,
    prepare,
  };
};

describe("model tool exposure fast path", () => {
  beforeEach(() => {
    resetModelToolCandidateCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetModelToolCandidateCacheForTests();
  });

  it("does not treat a missing default-hidden permission as a model-visible candidate", async () => {
    const { env } = envWithPermission(null);

    await expect(hasModelVisibleToolCandidate(env, identity, urlInspectToolName)).resolves.toBe(
      false,
    );
  });

  it("recognizes an enabled model-visible permission as a candidate", async () => {
    const { env } = envWithPermission({
      status: "enabled",
      data_json: JSON.stringify({ modelVisible: true, requiresApproval: false }),
    });

    await expect(hasModelVisibleToolCandidate(env, identity, urlInspectToolName)).resolves.toBe(
      true,
    );
  });

  it.runIf(demoPacksInstalled)(
    "allows model exposure only when the active pack declares the tool",
    async () => {
      const permission = {
        status: "enabled",
        data_json: JSON.stringify({ modelVisible: true, requiresApproval: false }),
      };
      const repoAnalyst = envWithPermission(
        permission,
        agentWithBehavior(createAgentBehaviorSnapshot("analyst", "pack-repo-analyst")),
      );
      const babyPolymancer = envWithPermission(
        permission,
        agentWithBehavior(createAgentBehaviorSnapshot("analyst", "pack-baby-polymancer")),
      );
      const babySwordfish = envWithPermission(
        permission,
        agentWithBehavior(createAgentBehaviorSnapshot("analyst", "pack-baby-swordfish")),
      );

      await expect(
        hasModelVisibleToolCandidate(repoAnalyst.env, identity, urlInspectToolName),
      ).resolves.toBe(true);
      await expect(
        hasModelVisibleToolCandidate(babyPolymancer.env, identity, urlInspectToolName),
      ).resolves.toBe(false);
      await expect(
        hasModelVisibleToolCandidate(babySwordfish.env, identity, "swordfish.runtime.overview"),
      ).resolves.toBe(false);
    },
  );

  it("rejects disabled or approval-gated permissions from the fast path", async () => {
    const disabled = envWithPermission({
      status: "disabled",
      data_json: JSON.stringify({ modelVisible: true, requiresApproval: false }),
    });
    const approvalGated = envWithPermission({
      status: "enabled",
      data_json: JSON.stringify({ modelVisible: true, requiresApproval: true }),
    });

    await expect(
      hasModelVisibleToolCandidate(disabled.env, identity, urlInspectToolName),
    ).resolves.toBe(false);
    await expect(
      hasModelVisibleToolCandidate(approvalGated.env, identity, urlInspectToolName),
    ).resolves.toBe(false);
  });

  it("caches negative candidate checks briefly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00.000Z"));
    const { env, prepare } = envWithPermission(null);

    await expect(hasModelVisibleToolCandidate(env, identity, urlInspectToolName)).resolves.toBe(
      false,
    );
    await expect(hasModelVisibleToolCandidate(env, identity, urlInspectToolName)).resolves.toBe(
      false,
    );

    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("expires the negative candidate cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00.000Z"));
    const { env, prepare } = envWithPermission(null);

    await expect(hasModelVisibleToolCandidate(env, identity, urlInspectToolName)).resolves.toBe(
      false,
    );
    vi.advanceTimersByTime(30_001);
    await expect(hasModelVisibleToolCandidate(env, identity, urlInspectToolName)).resolves.toBe(
      false,
    );

    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it("does not cache positive candidate checks", async () => {
    const { env, prepare } = envWithPermission({
      status: "enabled",
      data_json: JSON.stringify({ modelVisible: true, requiresApproval: false }),
    });

    await expect(hasModelVisibleToolCandidate(env, identity, urlInspectToolName)).resolves.toBe(
      true,
    );
    await expect(hasModelVisibleToolCandidate(env, identity, urlInspectToolName)).resolves.toBe(
      true,
    );

    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it("derives stable provider-safe names from arbitrary runtime tool ids", () => {
    expect(modelToolKey("operator.signal.read")).toBe("operator_signal_read");
    expect(modelToolKey(" vendor/tool:lookup ")).toBe("vendor_tool_lookup");
    expect(modelToolKey("...")).toBe("runtime_tool");
  });

  it("builds model-visible candidates from an arbitrary active package runtime", () => {
    expect(runtimeModelToolBindingsForPack(complexOperator).map((binding) => binding.id)).toEqual([
      "operator.signal.read",
    ]);
  });
});
