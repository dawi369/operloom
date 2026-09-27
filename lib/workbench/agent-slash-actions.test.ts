import { describe, expect, it } from "vitest";

import { babyPolymancerPack } from "../../agent-packs/baby-polymancer";
import { babySwordfishPack } from "../../agent-packs/baby-swordfish";
import { resolveAgentSlashWorkflowActions } from "./agent-slash-actions";

describe("agent slash actions", () => {
  it("exposes Baby Polymancer market research as a runnable slash action", () => {
    const actions = resolveAgentSlashWorkflowActions(babyPolymancerPack);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: "market-research",
      label: "Market research",
      binding: {
        workflowType: "polymancer.market_research",
        requiredPackId: "baby-polymancer",
        route: "/api/workbench/workflows/polymancer.market_research",
      },
    });
    expect(actions[0]?.description).toContain("polymarket.market.search");
    expect(actions[0]?.description).toContain("polymarket.orderbook.snapshot");
  });

  it("keeps parked Baby Swordfish free of runnable slash actions", () => {
    const actions = resolveAgentSlashWorkflowActions(babySwordfishPack);
    expect(actions).toEqual([]);
  });

  it("ignores packs without a bound runnable workflow", () => {
    expect(
      resolveAgentSlashWorkflowActions({
        ...babyPolymancerPack,
        id: "future-pack",
        workflows: [
          {
            type: "future.research",
            engine: "cloudflare",
            status: "declared",
            description: "Future research workflow",
          },
        ],
      }),
    ).toEqual([]);
  });
});
