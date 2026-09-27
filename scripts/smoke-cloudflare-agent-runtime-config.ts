import { type TenantIdentity, createSmokeContext, runSmoke, sleep } from "./smoke-utils";

type AgentRuntimeConfig = {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  source?: string;
};

type AgentSummary = {
  id?: string;
  profile?: "default" | "analyst" | "operator";
  runtime?: AgentRuntimeConfig;
  isActive?: boolean;
};

type AdminSummaryResponse = {
  ok?: boolean;
  summary?: {
    identity?: {
      agentId?: string;
      workspaceId?: string;
    };
    activeAgent?: AgentSummary | null;
    chatRuntime?: {
      latestRun?: {
        id?: string;
        status?: string;
        metadata?: Record<string, unknown>;
      } | null;
    };
  };
  error?: string;
};

type AgentMutationResponse = {
  ok?: boolean;
  activeAgentId?: string;
  agent?: AgentSummary | null;
  error?: string;
};

const {
  baseUrl,
  suffix,
  pollTimeoutMs,
  pollIntervalMs,
  headersFor,
  readJson,
  assertStatus,
  createThread,
} = createSmokeContext();

const accountId = `workos-org:agent-runtime-config-org-${suffix}`;
const modelOptions = [
  "deepseek/deepseek-v4-flash",
  "openai/gpt-4.1-mini",
  "openai/gpt-6-luna",
] as const;

const owner: TenantIdentity = {
  userId: `agent-runtime-config-owner-${suffix}`,
  accountId,
  accountSource: "workos-organization",
  email: `agent-runtime-config-owner-${suffix}@example.com`,
  role: "owner",
  roles: ["owner"],
};

const adminSummary = async (label: string) => {
  const body = await readJson<AdminSummaryResponse>("/admin/workspace-summary", owner);
  const summary = body.summary;
  if (!body.ok || !summary?.identity?.workspaceId || !summary.identity.agentId) {
    throw new Error(`${label} did not resolve workspace and agent identity`);
  }
  if (!summary.activeAgent?.runtime?.model || !summary.activeAgent.runtime.source) {
    throw new Error(`${label} did not include active agent runtime config`);
  }
  return summary;
};

const createAgent = (input: Record<string, unknown>) =>
  readJson<AgentMutationResponse>("/agents", owner, {
    method: "POST",
    body: JSON.stringify(input),
  });

const runStream = async (threadId: string) => {
  const response = await fetch(
    `${baseUrl}/langgraph/threads/${encodeURIComponent(threadId)}/runs/stream`,
    {
      method: "POST",
      headers: headersFor(owner),
      body: JSON.stringify({
        assistant_id: "agent",
        input: {
          messages: [
            {
              role: "user",
              content: "Reply with one short sentence for the runtime config smoke.",
            },
          ],
        },
        stream_mode: ["messages"],
      }),
    },
  );
  const body = await response.text();
  if (!response.ok) throw new Error(`chat run failed with ${response.status}: ${body}`);
};

const waitForCompletedRun = async (expectedModel: string) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < pollTimeoutMs) {
    const summary = await adminSummary("runtime chat summary");
    const run = summary.chatRuntime?.latestRun;
    if (run?.status === "completed") {
      const runtimeConfig = run.metadata?.runtimeConfig;
      const model = run.metadata?.model;
      if (
        !runtimeConfig ||
        typeof runtimeConfig !== "object" ||
        !("model" in runtimeConfig) ||
        runtimeConfig.model !== expectedModel ||
        model !== expectedModel
      ) {
        throw new Error("completed run did not use selected agent runtime model");
      }
      return run.id;
    }
    if (run?.status === "failed") {
      throw new Error(`chat run failed: ${run.id ?? "unknown"}`);
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`chat run did not complete within ${pollTimeoutMs}ms`);
};

runSmoke("Cloudflare agent runtime config smoke", async () => {
  console.log(`Smoking Cloudflare agent runtime config at ${baseUrl}`);

  const initial = await adminSummary("initial summary");
  if (initial.activeAgent?.runtime?.source !== "system-default") {
    throw new Error("default agent did not fall back to system runtime config");
  }
  const fallbackModel = initial.activeAgent.runtime.model;
  const selectedModel = fallbackModel === modelOptions[0] ? modelOptions[1] : modelOptions[0];

  await assertStatus("/agents", owner, 400, {
    method: "POST",
    body: JSON.stringify({
      name: "Invalid Runtime Agent",
      profile: "analyst",
      model: "not-a-real/model",
      activate: true,
    }),
  });

  const created = await createAgent({
    name: "Runtime Config Analyst",
    description: "Smoke-created agent with explicit runtime config.",
    profile: "analyst",
    model: selectedModel,
    activate: true,
  });
  if (
    !created.ok ||
    !created.agent?.id ||
    created.activeAgentId !== created.agent.id ||
    created.agent.runtime?.source !== "agent" ||
    created.agent.runtime.model !== selectedModel
  ) {
    throw new Error(created.error ?? "agent runtime config was not stored or activated");
  }

  const afterCreate = await adminSummary("after runtime agent create");
  const activeAgentId = afterCreate.identity?.agentId;
  if (
    activeAgentId !== created.agent.id ||
    afterCreate.activeAgent?.runtime?.model !== selectedModel
  ) {
    throw new Error("admin summary did not resolve selected runtime-configured agent");
  }

  const threadId = await createThread(owner);
  await runStream(threadId);
  const runId = await waitForCompletedRun(selectedModel);

  console.log(
    JSON.stringify(
      {
        fallbackModel,
        selectedModel,
        agentId: created.agent.id,
        runId,
      },
      null,
      2,
    ),
  );
});

export {};
