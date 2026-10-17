import type { WorkbenchAgentIdentity } from "../../../lib/workbench/agent-identity-types";
import { compiledWorkbenchVersion } from "../../../generated/agent-runtime/platform";
import { json, type ControlPlaneAuthContext } from "./http";
import { publicApiCommandRequest } from "./public-api-auth";
import type { Env } from "./types";

/**
 * MCP over Streamable HTTP, stateless: every user-invocable workflow and query of the
 * target agent is a tool. Auth is the same WorkOS bearer as `/v1`; a client id must also
 * be on the MCP allowlist. Tool results carry the pack's renderer kind in `_meta` so an
 * MCP Apps widget can reuse the W6 data-only renderers.
 */
export const mcpProtocolVersions = ["2025-06-18", "2025-03-26"] as const;
const metaPrefix = "operloom/";
const toolNamePattern = /[^a-zA-Z0-9_-]/g;

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };
type Dispatch = (command: Request, auth: ControlPlaneAuthContext) => Promise<Response>;

type McpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  _meta: Record<string, unknown>;
  kind: "workflow" | "query";
  id: string;
};

const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });

export const mcpAllowedClientIds = (env: Pick<Env, "OPERLOOM_MCP_ALLOWED_CLIENT_IDS">) =>
  new Set(
    (env.OPERLOOM_MCP_ALLOWED_CLIENT_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

export const mcpClientAllowed = (
  env: Pick<Env, "OPERLOOM_MCP_ALLOWED_CLIENT_IDS">,
  principal: Pick<WorkbenchAgentIdentity, "clientId">,
) => Boolean(principal.clientId && mcpAllowedClientIds(env).has(principal.clientId));

/** RFC 9728 metadata so MCP clients discover the WorkOS authorization server. */
export const mcpProtectedResourceMetadata = (
  origin: string,
  env: Pick<Env, "OPERLOOM_WORKOS_ISSUER">,
) => ({
  resource: `${origin}/v1/me/mcp`,
  authorization_servers: [env.OPERLOOM_WORKOS_ISSUER?.trim() || "https://api.workos.com"],
  bearer_methods_supported: ["header"],
  resource_documentation: `${origin}/v1/openapi.json`,
});

export const mcpToolName = (kind: McpTool["kind"], id: string) =>
  `${kind}_${id.replace(toolNamePattern, "_")}`.slice(0, 64);

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readJson = async (response: Response) =>
  (await response.json().catch(() => ({}))) as Record<string, unknown>;

export const createMcpSession = (input: {
  request: Request;
  env: Env;
  principal: WorkbenchAgentIdentity;
  context: ControlPlaneAuthContext;
  target?: { workspaceId: string; agentId: string };
  dispatch: Dispatch;
}) => {
  const command = (method: string, path: string, body?: unknown) =>
    input.dispatch(
      publicApiCommandRequest(
        new Request(input.request.url, {
          method,
          headers: { "content-type": "application/json", accept: "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        { principal: input.principal, path, target: input.target },
      ),
      input.context,
    );

  const listTools = async (): Promise<McpTool[]> => {
    const [workflows, queries] = await Promise.all([
      command("GET", "/workbench/workflows").then(readJson),
      command("GET", "/queries").then(readJson),
    ]);
    const tools: McpTool[] = [];
    for (const raw of Array.isArray(workflows.workflows) ? workflows.workflows : []) {
      const workflow = asObject(raw);
      if (typeof workflow.type !== "string") continue;
      tools.push({
        name: mcpToolName("workflow", workflow.type),
        title: typeof workflow.label === "string" ? workflow.label : undefined,
        description:
          typeof workflow.description === "string" && workflow.description
            ? workflow.description
            : `Run the ${workflow.type} workflow.`,
        inputSchema: asObject(workflow.inputSchema).type
          ? asObject(workflow.inputSchema)
          : { type: "object" },
        outputSchema: asObject(workflow.outputSchema).type
          ? asObject(workflow.outputSchema)
          : undefined,
        _meta: { [`${metaPrefix}kind`]: "workflow", [`${metaPrefix}id`]: workflow.type },
        kind: "workflow",
        id: workflow.type,
      });
    }
    for (const raw of Array.isArray(queries.queries) ? queries.queries : []) {
      const query = asObject(raw);
      if (typeof query.id !== "string") continue;
      tools.push({
        name: mcpToolName("query", query.id),
        description:
          typeof query.description === "string" && query.description
            ? query.description
            : `Read ${query.id}.`,
        inputSchema: asObject(query.inputSchema).type
          ? asObject(query.inputSchema)
          : { type: "object" },
        outputSchema: asObject(query.outputSchema).type ? asObject(query.outputSchema) : undefined,
        _meta: { [`${metaPrefix}kind`]: "query", [`${metaPrefix}id`]: query.id },
        kind: "query",
        id: query.id,
      });
    }
    return tools;
  };

  const callTool = async (name: string, args: Record<string, unknown>) => {
    const tool = (await listTools()).find((candidate) => candidate.name === name);
    if (!tool) return null;
    const response =
      tool.kind === "workflow"
        ? await command("POST", `/workbench/workflows/${encodeURIComponent(tool.id)}`, {
            input: args,
          })
        : await command("POST", `/queries/${encodeURIComponent(tool.id)}`, { input: args });
    const body = await readJson(response);
    const ok = response.ok && body.ok !== false;
    const structured = asObject(body.report ?? body.output ?? body.result ?? body);
    const artifact = asObject(body.artifact);
    const run = asObject(body.run);
    const summary =
      typeof body.summary === "string"
        ? body.summary
        : typeof body.error === "string"
          ? body.error
          : ok
            ? `${tool.id} completed.`
            : `${tool.id} failed.`;
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: structured,
      isError: !ok,
      _meta: {
        ...tool._meta,
        ...(typeof artifact.kind === "string" ? { [`${metaPrefix}renderer`]: artifact.kind } : {}),
        ...(typeof run.runId === "string" ? { [`${metaPrefix}runId`]: run.runId } : {}),
        ...(typeof body.code === "string" ? { [`${metaPrefix}code`]: body.code } : {}),
      },
    };
  };

  const handle = async (message: JsonRpcRequest) => {
    const id = message.id ?? null;
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
      return rpcError(id, -32600, "Invalid JSON-RPC request");
    const params = asObject(message.params);
    switch (message.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return rpcResult(id, {
          protocolVersion: (mcpProtocolVersions as readonly string[]).includes(requested)
            ? requested
            : mcpProtocolVersions[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "operloom", version: compiledWorkbenchVersion },
          instructions:
            "Tools are the active agent's user-invocable workflows and read-only queries. Workflow results are durable runs the operator can inspect in the workbench.",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: (await listTools()).map(({ kind: _kind, id: _id, ...tool }) => tool),
        });
      case "tools/call": {
        if (typeof params.name !== "string") return rpcError(id, -32602, "Tool name is required");
        const result = await callTool(params.name, asObject(params.arguments));
        return result ? rpcResult(id, result) : rpcError(id, -32602, `Unknown tool ${params.name}`);
      }
      default:
        return message.method.startsWith("notifications/")
          ? null
          : rpcError(id, -32601, `Method not found: ${message.method}`);
    }
  };

  return { handle };
};

export const handleMcp = async (input: {
  request: Request;
  env: Env;
  principal: WorkbenchAgentIdentity;
  context: ControlPlaneAuthContext;
  target?: { workspaceId: string; agentId: string };
  dispatch: Dispatch;
}) => {
  const { request } = input;
  if (!mcpClientAllowed(input.env, input.principal))
    return json(
      {
        ok: false,
        code: "mcp_client_not_allowed",
        error: "This client is not allowed to use MCP.",
      },
      { status: 403 },
    );
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST")
    return json(
      { ok: false, code: "method_not_allowed", error: "MCP is served over POST." },
      { status: 405 },
    );
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const session = createMcpSession(input);
  const messages = Array.isArray(payload) ? payload : [payload];
  if (messages.length === 0 || messages.length > 20)
    return json(rpcError(null, -32600, "Expected 1 to 20 JSON-RPC messages"), { status: 400 });
  const responses = (
    await Promise.all(messages.map((message) => session.handle(asObject(message))))
  ).filter((response) => response !== null);
  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(payload) ? responses : responses[0]);
};
