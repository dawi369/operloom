import { getWorkbenchSession, WorkbenchAuthError } from "@/lib/workbench/agent-identity";
import { getWorkspaceContext } from "@/lib/workbench/cloudflare-control-plane-client";

export type WorkbenchAdminAccess = {
  ok: true;
  isAdmin: boolean;
};

const parseAllowlist = (value: string | undefined, normalize = (item: string) => item) =>
  new Set(
    (value ?? "")
      .split(",")
      .map((item) => normalize(item.trim()))
      .filter(Boolean),
  );

export const getWorkbenchAdminAccess = async (): Promise<WorkbenchAdminAccess> => {
  const session = await getWorkbenchSession();
  // The local API principal is chosen by the Worker, so ask it rather than assuming an id.
  const userId =
    session.authMode === "workos"
      ? session.userId
      : (await getWorkspaceContext()).context?.identity.userId;
  const allowedUserIds = parseAllowlist(process.env.WORKBENCH_ADMIN_USER_IDS);
  const allowedEmails = parseAllowlist(process.env.WORKBENCH_ADMIN_EMAILS, (item) =>
    item.toLowerCase(),
  );
  const userEmail = session.authMode === "workos" ? session.userEmail.toLowerCase() : undefined;

  return {
    ok: true,
    isAdmin:
      (userId ? allowedUserIds.has(userId) : false) ||
      (userEmail ? allowedEmails.has(userEmail) : false),
  };
};

export const requireWorkbenchAdminAccess = async () => {
  const access = await getWorkbenchAdminAccess();
  if (!access.isAdmin) throw new WorkbenchAuthError("Admin access is restricted", 403);
  return access;
};
