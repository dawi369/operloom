import { json, parseJson } from "./http";
import type { SessionAgent } from "./session-agent-runtime";
import { ensureCoordinatorRequest } from "./session-agent-transitions";

export const handleSessionAgentRequest = async (agent: SessionAgent, request: Request) => {
  const input = ensureCoordinatorRequest(parseJson(await request.text()));
  if (!input) {
    return json({ ok: false, error: "Invalid session coordinator request" }, { status: 400 });
  }

  try {
    if (input.action === "stream") return agent.stream(input);
    if (input.action === "broadcast") {
      const result = agent.broadcast(input);
      return json(result, { status: "status" in result ? result.status : 200 });
    }
    if (input.action === "list") return json(await agent.listThreads(input));
    if (input.action === "create") return json(await agent.createThread(input));
    if (input.action === "stageThread") return json(await agent.stageThread(input));
    if (input.action === "materializeTurn") {
      const result = await agent.materializeTurn(input);
      return json(result, { status: "status" in result ? result.status : 200 });
    }
    if (input.action === "update") {
      const result = await agent.updateThread(input);
      return json(result, { status: "status" in result ? result.status : 200 });
    }
    if (input.action === "activate") {
      const result = await agent.activateThread(input);
      return json(result, { status: "status" in result ? result.status : 200 });
    }
    if (input.action === "switchAgent") {
      const result = await agent.switchAgent(input);
      return json(result, { status: "status" in result ? result.status : 200 });
    }
    return json(await agent.getSession(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Session coordinator failed";
    return json(
      { ok: false, error: message },
      { status: message.includes("not active") ? 403 : 500 },
    );
  }
};
