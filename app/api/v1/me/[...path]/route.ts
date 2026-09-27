import { NextResponse, type NextRequest } from "next/server";
import { matchesPublicApiRoute } from "@operloom/client";

import { toWorkbenchApiError } from "@/lib/workbench/api-errors";
import { controlPlaneRequest } from "@/lib/workbench/control-plane-client/transport";

export const runtime = "nodejs";

type Context = { params: Promise<{ path: string[] }> };

/**
 * Same-origin bridge for the console's `@operloom/client` calls: forwards allowlisted `/v1/me`
 * operations with the signed-in user's server-side access token.
 */
const forward = async (request: NextRequest, { params }: Context) => {
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && origin && origin !== request.nextUrl.origin)
    return NextResponse.json(
      { ok: false, error: "Cross-origin request rejected" },
      { status: 403 },
    );
  const path = `/${(await params).path.map(encodeURIComponent).join("/")}`;
  if (!matchesPublicApiRoute(request.method, path))
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  try {
    const upstream = await controlPlaneRequest(`${path}${request.nextUrl.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" ? undefined : await request.text(),
    });
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return toWorkbenchApiError(error, "Control-plane request failed");
  }
};

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
