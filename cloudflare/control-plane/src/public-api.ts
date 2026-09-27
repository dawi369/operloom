import { matchesPublicApiRoute, publicApiOpenApi } from "../../../packages/client/src/public-api";
import { compiledWorkbenchVersion } from "../../../generated/agent-runtime/platform";
import { WorkbenchAuthError } from "../../../lib/workbench/agent-identity-types";
import { withCors } from "./cors";
import { json, type ControlPlaneAuthContext } from "./http";
import { authenticatePublicApi, publicApiCommandRequest } from "./public-api-auth";
import type { Env } from "./types";
import { agentRevisionConflict } from "./agent-execution-revisions";
import { findPublicActionContract } from "../../../packages/client/src/public-action-contracts";

export const handlePublicApi = async (
  request: Request,
  env: Env,
  dispatch: (command: Request, auth: ControlPlaneAuthContext) => Promise<Response>,
) => {
  const requestId = crypto.randomUUID();
  let response: Response;
  try {
    if (request.method === "OPTIONS")
      return withCors(new Response(null, { status: 204 }), request, env);
    const url = new URL(request.url);
    if (url.pathname === "/v1/openapi.json" && request.method === "GET") {
      response = json(publicApiOpenApi(compiledWorkbenchVersion));
    } else {
      const { principal, context } = await authenticatePublicApi(request, env);
      const match = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/agents\/([^/]+)(\/.*)$/);
      // `/v1/me` resolves the caller's active workspace and agent inside this request.
      const active = url.pathname.match(/^\/v1\/me(\/.*)$/);
      const account = url.pathname === "/v1/account" && request.method === "GET";
      const operation = match?.[3] ?? active?.[1];
      if (!account && (!operation || !matchesPublicApiRoute(request.method, operation))) {
        throw new WorkbenchAuthError(
          "Unknown public operation; use /v1/me or an explicit workspace and agent",
          404,
        );
      }
      const target = match
        ? { workspaceId: decodeURIComponent(match[1]!), agentId: decodeURIComponent(match[2]!) }
        : undefined;
      if (
        target &&
        Object.values(target).some(
          (value) =>
            !value.trim() ||
            value.length > 256 ||
            value.includes("/") ||
            value.includes("\\") ||
            [...value].some((character) => character.charCodeAt(0) < 32),
        )
      )
        throw new WorkbenchAuthError("Invalid target", 400);
      let commandSource = request;
      const actionContract = findPublicActionContract(request.method, operation ?? "");
      if (
        actionContract &&
        "query" in actionContract &&
        !actionContract.query.safeParse(Object.fromEntries(url.searchParams)).success
      ) {
        throw new WorkbenchAuthError("Invalid action query", 400);
      }
      if (
        request.method === "POST" &&
        /^\/workbench\/workspace-deletion(?:\/retry)?$/.test(operation ?? "")
      ) {
        if (
          !principal.verifiedAuthenticationTime ||
          Date.now() - principal.verifiedAuthenticationTime > 300_000
        )
          throw new WorkbenchAuthError(
            "A recently authenticated token with verified auth_time is required for deletion",
            403,
          );
        const body = (await request.json()) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new WorkbenchAuthError("Expected a JSON object", 400);
        commandSource = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: JSON.stringify({
            ...body,
            reauthenticatedAt: new Date(principal.verifiedAuthenticationTime).toISOString(),
          }),
        });
      }
      response = await dispatch(
        publicApiCommandRequest(commandSource, {
          principal,
          path: account ? "/workspace-context" : operation!,
          target,
        }),
        context,
      );
    }
    if (!response.ok && response.headers.get("content-type")?.includes("application/json")) {
      const body = (await response.json()) as Record<string, unknown>;
      const details = body.details as { code?: unknown } | undefined;
      const headers = Object.fromEntries(response.headers);
      delete headers["content-length"];
      response = json(
        {
          ...body,
          requestId,
          code:
            body.code ??
            (typeof details?.code === "string" ? details.code : `http_${response.status}`),
        },
        { status: response.status, headers },
      );
    }
  } catch (error) {
    const known = error instanceof WorkbenchAuthError;
    const conflict = agentRevisionConflict(error);
    const fenced =
      !known && error instanceof Error && error.message.includes("workspace_export_in_progress");
    response = fenced
      ? json(
          {
            ok: false,
            requestId,
            code: "workspace_export_in_progress",
            error: "Workspace writes are briefly paused while an export snapshot is captured.",
          },
          { status: 423 },
        )
      : json(
          {
            ok: false,
            requestId,
            code: conflict?.code ?? (known ? `http_${error.status}` : "internal_error"),
            error: conflict?.error ?? (known ? error.message : "Public API request failed"),
          },
          { status: conflict ? 409 : known ? error.status : 500 },
        );
  }
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  if (!/(^|,)\s*no-store\s*(,|$)/.test(headers.get("cache-control") ?? ""))
    headers.set("cache-control", "no-store");
  return withCors(new Response(response.body, { status: response.status, headers }), request, env);
};
