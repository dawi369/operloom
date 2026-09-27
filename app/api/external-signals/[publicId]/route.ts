import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

const maximumWebhookBytes = 32 * 1024;

/** Public Agent Pack webhook; the Worker verifies the per-trigger secret. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ publicId: string }> },
) {
  const { publicId } = await context.params;
  if (!/^hook-[A-Za-z0-9-]{8,160}$/.test(publicId)) {
    return NextResponse.json({ ok: false, error: "Trigger webhook not found" }, { status: 404 });
  }
  const baseUrl = process.env.OPERLOOM_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!baseUrl) {
    return NextResponse.json(
      { ok: false, error: "Webhook ingress is unavailable" },
      { status: 503 },
    );
  }
  const authorization = request.headers.get("authorization") ?? "";
  const triggerSecret = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!triggerSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumWebhookBytes) {
    return NextResponse.json({ ok: false, error: "Webhook body is too large" }, { status: 413 });
  }
  const response = await fetch(`${baseUrl}/trigger-ingress/${encodeURIComponent(publicId)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The Worker requires the sender's key to deduplicate deliveries.
      "idempotency-key": request.headers.get("idempotency-key")?.trim() ?? "",
      "x-operloom-trigger-secret": triggerSecret,
    },
    body,
  });
  const responseText = await response.text();
  return new NextResponse(responseText || null, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}
