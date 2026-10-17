import { describe, expect, it } from "vitest";

import type { WorkbenchAgentIdentity } from "../../../lib/workbench/agent-identity-types";
import { handleMcp, mcpProtectedResourceMetadata, mcpToolName } from "./mcp";
import type { Env } from "./types";

const principal: WorkbenchAgentIdentity = {
  scope: { userId: "u1", workspaceId: "ws1" },
  authMode: "local-dev",
  accountId: "acct",
  accountSource: "local-dev",
  workspaceSource: "local-dev",
  clientId: "chatgpt-app",
};
const env = { OPERLOOM_MCP_ALLOWED_CLIENT_IDS: "chatgpt-app, claude" } as Env;

const dispatched: Array<{
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}> = [];
const dispatch = async (command: Request) => {
  const url = new URL(command.url);
  const body = command.method === "POST" ? await command.json() : undefined;
  dispatched.push({
    method: command.method,
    path: url.pathname,
    body,
    headers: Object.fromEntries(command.headers),
  });
  if (url.pathname === "/workbench/workflows")
    return Response.json({
      ok: true,
      workflows: [
        {
          type: "complex-operator.observe",
          label: "Observe system",
          description: "Read a signal.",
          inputSchema: { type: "object", properties: { subject: { type: "string" } } },
        },
      ],
    });
  if (url.pathname === "/queries")
    return Response.json({
      ok: true,
      queries: [{ id: "operator.status", description: "Current status." }],
    });
  if (url.pathname.startsWith("/workbench/workflows/"))
    return Response.json(
      {
        ok: true,
        summary: "Observed.",
        report: { signal: "nominal" },
        run: { runId: "run-1" },
        artifact: { kind: "complex_operator_report" },
      },
      { status: 201 },
    );
  if (url.pathname.startsWith("/queries/"))
    return Response.json(
      { ok: false, code: "query_failed", error: "Status unavailable." },
      { status: 502 },
    );
  return Response.json({ ok: false }, { status: 404 });
};

const call = (body: unknown, overrides: Partial<WorkbenchAgentIdentity> = {}, method = "POST") =>
  handleMcp({
    request:
      method === "POST"
        ? new Request("https://worker.test/v1/me/mcp", {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        : new Request("https://worker.test/v1/me/mcp", { method }),
    env,
    principal: { ...principal, ...overrides },
    context: { mode: "local_api" },
    dispatch,
  });

describe("mcp adapter", () => {
  it("initializes, lists workflows and queries as tools and calls them through the public API", async () => {
    const init = await (
      await call({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      })
    ).json();
    expect(init).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-03-26", serverInfo: { name: "operloom" } },
    });
    const list = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "workflow_complex-operator_observe",
      "query_operator_status",
    ]);
    expect(list.result.tools[0]).toMatchObject({
      title: "Observe system",
      inputSchema: { type: "object" },
      _meta: { "operloom/kind": "workflow", "operloom/id": "complex-operator.observe" },
    });
    expect(list.result.tools[0]).not.toHaveProperty("kind");

    const run = await (
      await call({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "workflow_complex-operator_observe", arguments: { subject: "x" } },
      })
    ).json();
    expect(run.result).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "Observed." }],
      structuredContent: { signal: "nominal" },
      _meta: { "operloom/renderer": "complex_operator_report", "operloom/runId": "run-1" },
    });
    const workflowCall = dispatched.find(
      (entry) => entry.path === "/workbench/workflows/complex-operator.observe",
    );
    expect(workflowCall).toMatchObject({ method: "POST", body: { input: { subject: "x" } } });
    expect(workflowCall!.headers["x-operloom-user-id"]).toBe("u1");
    expect(workflowCall!.headers.authorization).toBeUndefined();

    const failed = await (
      await call({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "query_operator_status", arguments: {} },
      })
    ).json();
    expect(failed.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Status unavailable." }],
      _meta: { "operloom/code": "query_failed" },
    });
  });

  it("answers batches, notifications, unknown methods and malformed input per JSON-RPC", async () => {
    const batch = await (
      await call([
        { jsonrpc: "2.0", id: "a", method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: "b", method: "resources/list" },
        { id: "c", method: "ping" },
      ])
    ).json();
    expect(batch).toEqual([
      { jsonrpc: "2.0", id: "a", result: {} },
      {
        jsonrpc: "2.0",
        id: "b",
        error: { code: -32601, message: "Method not found: resources/list" },
      },
      { jsonrpc: "2.0", id: "c", error: { code: -32600, message: "Invalid JSON-RPC request" } },
    ]);
    expect((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const unknownTool = await (
      await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } })
    ).json();
    expect(unknownTool.error.code).toBe(-32602);
    const parse = await handleMcp({
      request: new Request("https://worker.test/v1/me/mcp", { method: "POST", body: "{" }),
      env,
      principal,
      context: { mode: "local_api" },
      dispatch,
    });
    expect(parse.status).toBe(400);
    expect((await call(undefined, {}, "GET")).status).toBe(405);
    expect((await call(undefined, {}, "DELETE")).status).toBe(204);
  });

  it("enforces the per-client allowlist and publishes discovery metadata", async () => {
    const denied = await call({ jsonrpc: "2.0", id: 1, method: "ping" }, { clientId: "other" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "mcp_client_not_allowed" });
    expect(
      (await call({ jsonrpc: "2.0", id: 1, method: "ping" }, { clientId: undefined })).status,
    ).toBe(403);
    expect(
      mcpProtectedResourceMetadata("https://worker.test", {
        OPERLOOM_WORKOS_ISSUER: "https://auth.example",
      }),
    ).toEqual({
      resource: "https://worker.test/v1/me/mcp",
      authorization_servers: ["https://auth.example"],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://worker.test/v1/openapi.json",
    });
    expect(mcpToolName("workflow", "a.b/c d")).toBe("workflow_a_b_c_d");
  });
});
