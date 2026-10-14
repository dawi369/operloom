import { afterEach, describe, expect, it } from "vitest";

import { createPackTestRuntime } from "../../cloudflare/control-plane/src/pack-test-runtime";

const runtimes: ReturnType<typeof createPackTestRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});
const start = () => {
  const runtime = createPackTestRuntime({ packId: "service-desk", users: ["desk"] });
  runtimes.push(runtime);
  return runtime;
};

describe("service desk provider adapters", () => {
  it("reads the calendar through the broker, falling back to the recorded sample with no connection", async () => {
    const runtime = start();
    const agenda = await runtime.runWorkflow("service-desk.agenda", {
      from: "2026-10-15T00:00:00Z",
      to: "2026-10-16T00:00:00Z",
    });
    expect(agenda.status, JSON.stringify(agenda.body)).toBe(201);
    expect(agenda.body.report).toMatchObject({
      source: "recorded",
      events: [{ id: "evt-1", title: "Roof inspection — 12 Elm St" }, { id: "evt-2" }],
    });
  });

  it("proposes a transactional email as a reviewed provider operation", async () => {
    const runtime = start();
    const confirm = await runtime.runWorkflow("service-desk.confirm", {
      to: ["owner@example.test"],
      subject: "Confirmed",
      text: "See you at 9.",
    });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(201);
    expect(confirm.body.report).toMatchObject({ status: "proposed" });
    const proposal = runtime.db
      .prepare("SELECT tool_id, status, effect_target, proposal_json FROM control_action_proposals")
      .get() as { tool_id: string; status: string; effect_target: string; proposal_json: string };
    expect(proposal).toMatchObject({
      tool_id: "email.send",
      status: "proposed",
      effect_target: "simulation",
    });
    expect(JSON.parse(proposal.proposal_json).preview).toEqual({
      to: ["owner@example.test"],
      subject: "Confirmed",
      text: "See you at 9.",
    });
  });
});
