type HealthResponse = {
  ok?: boolean;
  service?: string;
};

type ThreadResponse = {
  thread_id?: string;
  error?: string;
};

const baseUrl = (process.env.CLOUDFLARE_CONTROL_PLANE_URL ?? "http://localhost:8787").replace(
  /\/$/,
  "",
);
const token = process.env.CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN ?? "local-dev-token";
const identity = {
  userId: process.env.WORKBENCH_DEV_USER_ID ?? "dev-user",
  workspaceId: process.env.WORKBENCH_DEV_WORKSPACE_ID ?? "dev-workspace",
  agentId: process.env.WORKBENCH_DEV_AGENT_ID ?? "dev-agent",
};

const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-assistant-mk1-user-id": identity.userId,
  "x-assistant-mk1-workspace-id": identity.workspaceId,
  "x-assistant-mk1-agent-id": identity.agentId,
};

const readJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
};

const main = async () => {
  console.log(`Smoking Cloudflare LangGraph facade at ${baseUrl}`);

  const health = await readJson<HealthResponse>("/health");
  if (!health.ok || health.service !== "operloom-control-plane") {
    throw new Error("Cloudflare control-plane health returned the wrong service response");
  }

  const thread = await readJson<ThreadResponse>("/langgraph/threads", {
    method: "POST",
    headers,
    body: "{}",
  });

  if (!thread.thread_id) {
    throw new Error(thread.error ?? "Cloudflare LangGraph facade did not create a thread");
  }

  console.log("Cloudflare LangGraph facade smoke passed");
  console.log(JSON.stringify({ threadId: thread.thread_id }, null, 2));
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

export {};
