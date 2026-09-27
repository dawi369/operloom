import { describe, expect, it } from "vitest";

import { resolveAgentRuntimeConfig } from "./agent-records";
import type { AgentRow, Env } from "./types";

const env = (model?: string) => ({ OPENROUTER_MODEL: model }) as Env;
const agent = (model: string) =>
  ({ data_json: JSON.stringify({ runtime: { provider: "openrouter", model } }) }) as AgentRow;

describe("agent runtime model defaults", () => {
  it("uses Luna with explicit instant reasoning by default", () => {
    expect(resolveAgentRuntimeConfig(env(), null)).toMatchObject({
      model: "openai/gpt-6-luna",
      reasoningEffort: "none",
      source: "system-default",
    });
  });

  it("keeps configured legacy and per-agent model choices", () => {
    expect(resolveAgentRuntimeConfig(env("openai/gpt-4.1-mini"), null)).toMatchObject({
      model: "openai/gpt-4.1-mini",
      reasoningEffort: undefined,
    });
    expect(resolveAgentRuntimeConfig(env(), agent("deepseek/deepseek-v4-flash"))).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      reasoningEffort: undefined,
      source: "agent",
    });
    expect(resolveAgentRuntimeConfig(env(), agent("openai/gpt-6-luna"))).toMatchObject({
      model: "openai/gpt-6-luna",
      reasoningEffort: "none",
      source: "agent",
    });
  });
});
