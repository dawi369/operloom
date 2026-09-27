import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runDurableWorkflow } from "./durable-workflow-runtime";
import type { Env } from "./types";

export class OperloomDurableWorkflow extends WorkflowEntrypoint<Env, { runId: string }> {
  async run(event: WorkflowEvent<{ runId: string }>, step: WorkflowStep) {
    if (event.payload.runId !== event.instanceId)
      throw new Error("Durable instance identity mismatch");
    return runDurableWorkflow(this.env, event.payload.runId, {
      do: (name, options, callback) => step.do(name, options, callback),
      async sleepUntil(name, timestamp) {
        // A saved deadline may already have elapsed during D1 work. Persist the
        // remaining duration so replay uses the same native sleep identity.
        const duration = await step.do(
          `__timer:${name}`,
          { retries: { limit: 0, delay: 1000 }, timeout: 10000 },
          async () => Math.max(0, timestamp - Date.now()),
        );
        await step.sleep(name, duration);
      },
      waitForEvent: (name, options) => step.waitForEvent(name, options),
    });
  }
}
