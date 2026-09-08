// proxy.ts - WorkOS AuthKit proxy for Next.js 16+
import { authkit, handleAuthkitHeaders } from "@workos-inc/authkit-nextjs";
import { type NextRequest, NextResponse } from "next/server";

import { getAuthConfiguration } from "@/lib/workbench/auth-configuration";
import { applyWorkbenchClientCors } from "@/lib/workbench/client-cors";

export default async function proxy(request: NextRequest) {
  const isWorkbenchApi = request.nextUrl.pathname.startsWith("/api/workbench/");
  const origin = request.headers.get("origin");
  if (isWorkbenchApi && request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    const allowed = applyWorkbenchClientCors(response.headers, {
      configuredOrigins: process.env.WORKBENCH_CLIENT_ORIGINS,
      origin,
      preflight: true,
    });
    return allowed || !origin ? response : new NextResponse(null, { status: 403 });
  }

  if (
    getAuthConfiguration().localIdentityEnabled ||
    (isWorkbenchApi && request.headers.has("authorization"))
  ) {
    const response = NextResponse.next();
    applyWorkbenchClientCors(response.headers, {
      configuredOrigins: process.env.WORKBENCH_CLIENT_ORIGINS,
      origin,
    });
    return response;
  }

  const { headers } = await authkit(request);
  const response = handleAuthkitHeaders(request, headers);
  if (isWorkbenchApi) {
    applyWorkbenchClientCors(response.headers, {
      configuredOrigins: process.env.WORKBENCH_CLIENT_ORIGINS,
      origin,
    });
  }
  return response;
}

// Match app and API routes so server routes using WorkOS `withAuth()` receive
// AuthKit session headers. Static assets stay excluded.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
