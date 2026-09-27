import { withAuth } from "@workos-inc/authkit-nextjs";

import { getAuthConfiguration } from "./auth-configuration";
import { WorkbenchAuthError } from "./agent-identity-types";

export { WorkbenchAuthError } from "./agent-identity-types";

/** The bundled console's only credential for the Worker `/v1` API. */
export type WorkbenchSession =
  | {
      authMode: "workos";
      accessToken: string;
      userId: string;
      userEmail: string;
      organizationId?: string;
    }
  | { authMode: "local-dev"; accessToken: string };

export const getWorkbenchSession = async (): Promise<WorkbenchSession> => {
  const { workOsConfigured, localApiEnabled } = getAuthConfiguration();
  if (workOsConfigured) {
    const auth = await withAuth();
    if (!auth.user) throw new WorkbenchAuthError("Authentication required", 401);
    return {
      authMode: "workos",
      accessToken: auth.accessToken,
      userId: auth.user.id,
      userEmail: auth.user.email,
      organizationId: auth.organizationId,
    };
  }
  if (!localApiEnabled) {
    throw new WorkbenchAuthError(
      "WorkOS is not configured and local development access is disabled",
      500,
    );
  }
  const accessToken = process.env.OPERLOOM_LOCAL_API_TOKEN?.trim();
  if (!accessToken) {
    throw new WorkbenchAuthError("OPERLOOM_LOCAL_API_TOKEN is not configured", 500);
  }
  return { authMode: "local-dev", accessToken };
};
