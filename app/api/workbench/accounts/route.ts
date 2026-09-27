import { getWorkOS } from "@workos-inc/authkit-nextjs";

import { toWorkbenchApiError } from "@/lib/workbench/api-errors";
import { getWorkbenchSession } from "@/lib/workbench/agent-identity";
import { getWorkspaceContext } from "@/lib/workbench/cloudflare-control-plane-client";
import type { WorkbenchAccountContextResponse } from "@/lib/workbench/workbench-types";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getWorkbenchSession();
    if (session.authMode === "local-dev") {
      const accountId = (await getWorkspaceContext()).context?.account?.id;
      return Response.json({
        ok: true,
        currentAccountId: accountId,
        accounts: accountId
          ? [
              {
                id: accountId,
                name: "Local development",
                source: "local-dev",
                role: "owner",
                roles: ["owner"],
                isCurrent: true,
              },
            ]
          : [],
      } satisfies WorkbenchAccountContextResponse);
    }

    const organizationMemberships = await getWorkOS().userManagement.listOrganizationMemberships({
      userId: session.userId,
      statuses: ["active"],
      limit: 100,
    });
    const accounts: NonNullable<WorkbenchAccountContextResponse["accounts"]> =
      organizationMemberships.data.map((membership) => ({
        id: `workos-org:${membership.organizationId}`,
        organizationId: membership.organizationId,
        name: membership.organizationName,
        source: "workos-organization" as const,
        role: membership.role?.slug,
        roles: membership.roles?.map((role) => role.slug),
        isCurrent: membership.organizationId === session.organizationId,
      }));

    const currentAccountId = session.organizationId
      ? `workos-org:${session.organizationId}`
      : `workos-personal:${session.userId}`;
    if (!session.organizationId) {
      accounts.unshift({
        id: currentAccountId,
        organizationId: undefined,
        name: "Personal",
        source: "workos-personal",
        role: "owner",
        roles: ["owner"],
        isCurrent: true,
      });
    }

    return Response.json({
      ok: true,
      currentAccountId,
      currentOrganizationId: session.organizationId,
      accounts,
    } satisfies WorkbenchAccountContextResponse);
  } catch (error) {
    return toWorkbenchApiError(error, "Failed to load account context");
  }
}
