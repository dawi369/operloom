import { NextResponse } from "next/server";

import { compiledWorkbenchVersion } from "../../../../generated/agent-runtime/platform";
import { signFacadeRequest } from "../../../../lib/workbench/control-plane-signing";

export const runtime = "nodejs";

const service = "operloom-facade";

const unavailable = () => NextResponse.json({ ok: false, service }, { status: 503 });

export async function GET() {
  const baseUrl = process.env.CLOUDFLARE_CONTROL_PLANE_URL?.trim().replace(/\/$/, "");
  const secret = process.env.CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET?.trim();
  const release =
    process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.WORKBENCH_RELEASE_SHA?.trim() ||
    "development";
  if (!baseUrl || !secret) return unavailable();

  const path = "/health/facade";
  const headers = await signFacadeRequest({
    secret,
    method: "GET",
    pathWithQuery: path,
    headers: {},
  });

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !response.ok ||
      body?.ok !== true ||
      body.service !== "operloom-control-plane-facade" ||
      body.version !== compiledWorkbenchVersion ||
      body.release !== release
    ) {
      return unavailable();
    }
    return NextResponse.json({
      ok: true,
      service,
      version: compiledWorkbenchVersion,
      release,
    });
  } catch {
    return unavailable();
  }
}
