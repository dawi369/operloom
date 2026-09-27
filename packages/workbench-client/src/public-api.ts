import {
  publicContextOpenApiOperation,
  publicContextOpenApiQueryParameters,
} from "./public-context-contracts.js";
import {
  publicBudgetOpenApiOperation,
  publicBudgetOpenApiQueryParameters,
} from "./public-budget-contracts.js";
import {
  publicUpgradeOpenApiOperation,
  publicUpgradeOpenApiQueryParameters,
} from "./public-upgrade-contracts.js";
import { publicChatOpenApiOperation } from "./public-chat-contracts.js";
import {
  publicActionOpenApiOperation,
  publicActionOpenApiQueryParameters,
} from "./public-action-contracts.js";
import {
  publicStateOpenApiOperation,
  publicStateOpenApiQueryParameters,
} from "./public-state-contracts.js";

/** Public route metadata is shared by dispatch and OpenAPI generation. Internal routes are absent. */
export const publicApiRoutes = [
  ["GET", "/workspace-context"],
  ["GET", "/admin/workspace-summary"],
  ["GET", "/admin/operator-alerts"],
  ["PATCH", "/admin/operator-alerts/{id}"],
  ["POST", "/admin/operator-alerts/{id}/retry-delivery"],
  ["GET", "/workspaces"],
  ["POST", "/workspaces"],
  ["GET", "/workspaces/{id}/members"],
  ["POST", "/workspaces/{id}/members"],
  ["PATCH", "/workspaces/{id}/members/{memberId}"],
  ["POST", "/workbench/package-upgrades"],
  ["GET", "/workbench/package-snapshots"],
  ["GET", "/workbench/context-snapshots/{id}"],
  ["GET", "/workbench/context-snapshots"],
  ["GET", "/workbench/budgets"],
  ["GET", "/workbench/usage"],
  ["PUT", "/workbench/budgets"],
  ["GET", "/agents"],
  ["POST", "/agents"],
  ["GET", "/agent-behavior-templates"],
  ["POST", "/agent-packs/{id}/instantiate"],
  ["GET", "/chat/session"],
  ["GET", "/chat/session/stream"],
  ["GET", "/chat/session/threads"],
  ["POST", "/chat/threads"],
  ["POST", "/chat/threads/{id}/turns"],
  ["POST", "/chat/threads/{id}/cancel"],
  ["GET", "/chat/commands/{id}"],
  ["GET", "/chat/threads/{id}/messages"],
  ["GET", "/chat/threads"],
  ["GET", "/chat/threads/{id}"],
  ["GET", "/workbench/workflows"],
  ["POST", "/workbench/workflows/{id}"],
  ["GET", "/workbench/history/runs"],
  ["GET", "/workbench/history/runs/{id}"],
  ["POST", "/workbench/history/runs/{id}/cancel"],
  ["POST", "/workbench/history/runs/{id}/retry"],
  ["GET", "/workbench/history/artifacts"],
  ["GET", "/workbench/artifacts/{id}/content"],
  ["GET", "/workbench/managed-state"],
  ["GET", "/workbench/managed-state/{id}"],
  ["GET", "/workbench/state/records"],
  ["GET", "/workbench/state/migrations"],
  ["POST", "/workbench/state/migrations/{id}"],
  ["POST", "/workbench/state/migrations/{id}/advance"],
  ["POST", "/workbench/state/migrations/{id}/repair"],
  ["GET", "/workbench/state/entries"],
  ["GET", "/workbench/state/deliveries"],
  ["POST", "/workbench/state/deliveries/{id}/retry"],
  ["GET", "/tools"],
  ["POST", "/tools/runs"],
  ["POST", "/tools/policy"],
  ["GET", "/tools/approvals"],
  ["POST", "/tools/approvals/{id}/approve"],
  ["POST", "/tools/approvals/{id}/deny"],
  ["GET", "/workbench/actions"],
  ["POST", "/workbench/actions/{id}/execute"],
  ["POST", "/workbench/actions/{id}/reconcile"],
  ["GET", "/triggers"],
  ["POST", "/triggers"],
  ["PATCH", "/triggers/{id}"],
  ["GET", "/trigger-dispatches"],
  ["GET", "/trigger-dispatches/{id}"],
  ["POST", "/trigger-dispatches/{id}/replay"],
  ["POST", "/triggers/{id}/dispatches"],
  ["GET", "/triggers/{id}"],
  ["GET", "/workbench/connections"],
  ["POST", "/workbench/connections/{id}/authorize"],
  ["POST", "/workbench/connections/{id}/credentials"],
  ["POST", "/workbench/connections/{id}/refresh"],
  ["POST", "/workbench/connections/{id}/health"],
  ["DELETE", "/workbench/connections/{id}"],
  ["POST", "/workbench/connections/oauth/callback"],
  ["GET", "/workbench/devices"],
  ["POST", "/workbench/devices"],
  ["DELETE", "/workbench/devices/{id}"],
  ["GET", "/workbench/notification-preferences"],
  ["PUT", "/workbench/notification-preferences"],
  ["GET", "/workbench/kill-switches"],
  ["PUT", "/workbench/kill-switches"],
  ["GET", "/workbench/retention-policy"],
  ["PATCH", "/workbench/retention-policy"],
  ["GET", "/workbench/data-deletion-plan"],
  ["POST", "/workbench/data-exports"],
  ["GET", "/workbench/data-exports/{id}"],
  ["GET", "/workbench/data-exports/{id}/download"],
  ["POST", "/workbench/workspace-deletion"],
  ["GET", "/workbench/workspace-deletion"],
  ["DELETE", "/workbench/workspace-deletion"],
  ["POST", "/workbench/workspace-deletion/retry"],
  ["GET", "/events"],
  ["GET", "/events/latest"],
  ["GET", "/events/stream"],
] as const;

export const matchesPublicApiRoute = (method: string, path: string) =>
  publicApiRoutes.some(
    ([verb, template]) =>
      method === verb && new RegExp(`^${template.replace(/\{\w+\}/g, "[^/]+")}$`).test(path),
  );

export const publicApiScopePath = (target: { workspaceId: string; agentId: string }) =>
  `/v1/workspaces/${encodeURIComponent(target.workspaceId)}/agents/${encodeURIComponent(target.agentId)}`;

export const publicApiOpenApi = (version: string) => ({
  openapi: "3.1.0",
  info: {
    title: "Operloom public API (experimental)",
    version,
    description:
      "Explicitly scoped operations. Response and body contracts remain the existing workbench contracts during migration.",
  },
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
  },
  paths: Object.fromEntries(
    [...new Set(publicApiRoutes.map(([, path]) => path))].map((path) => [
      `/v1/workspaces/{workspaceId}/agents/{agentId}${path}`,
      Object.fromEntries(
        publicApiRoutes
          .filter(([, candidate]) => candidate === path)
          .map(([method]) => [
            method.toLowerCase(),
            {
              parameters: [
                [
                  "workspaceId",
                  "agentId",
                  ...[...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]),
                ].map((name) => ({
                  name,
                  in: "path",
                  required: true,
                  schema: { type: "string", minLength: 1 },
                })),
                publicStateOpenApiQueryParameters(method, path),
                publicUpgradeOpenApiQueryParameters(method, path),
                publicBudgetOpenApiQueryParameters(method, path),
                publicContextOpenApiQueryParameters(method, path),
                publicActionOpenApiQueryParameters(method, path),
              ].flat(),
              responses: {
                "200": { description: "Canonical result" },
                default: { description: "Failure with code, error and requestId" },
              },
              ...publicChatOpenApiOperation(method, path),
              ...publicStateOpenApiOperation(method, path),
              ...publicUpgradeOpenApiOperation(method, path),
              ...publicContextOpenApiOperation(method, path),
              ...publicBudgetOpenApiOperation(method, path),
              ...publicActionOpenApiOperation(method, path),
            },
          ]),
      ),
    ]),
  ),
});
