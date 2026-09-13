import { handleAuth } from "@workos-inc/authkit-nextjs";
import { getWorkOSBaseURL } from "@/lib/workbench/auth-configuration";

// Return to home page after successful authentication
export const GET = handleAuth({ baseURL: getWorkOSBaseURL(), returnPathname: "/" });
