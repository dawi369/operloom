/**
 * Lightweight runtime health endpoint for local and Fly staging checks.
 *
 * This verifies that the Next server is serving and reports non-secret runtime
 * wiring. It deliberately does not call the model provider or validate durable
 * persistence.
 */
import { NextResponse } from "next/server";
import { compiledWorkbenchVersion } from "../../../generated/agent-runtime/platform";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "operloom",
    version: compiledWorkbenchVersion,
    release:
      process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.WORKBENCH_RELEASE_SHA ?? "development",
  });
}
