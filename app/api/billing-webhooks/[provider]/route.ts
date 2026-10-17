import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

const maximumWebhookBytes = 256 * 1024;

/** Public billing webhook; the Worker verifies the provider signature over the raw body. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  if (!/^[a-z]{2,32}$/.test(provider)) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  const baseUrl = process.env.OPERLOOM_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!baseUrl) {
    return NextResponse.json(
      { ok: false, error: "Webhook ingress is unavailable" },
      { status: 503 },
    );
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumWebhookBytes) {
    return NextResponse.json({ ok: false, error: "Webhook body is too large" }, { status: 413 });
  }
  const response = await fetch(`${baseUrl}/billing-ingress/${encodeURIComponent(provider)}`, {
    method: "POST",
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      "stripe-signature": request.headers.get("stripe-signature") ?? "",
      "webhook-id": request.headers.get("webhook-id") ?? "",
      "webhook-timestamp": request.headers.get("webhook-timestamp") ?? "",
      "webhook-signature": request.headers.get("webhook-signature") ?? "",
    },
    body,
  });
  const responseText = await response.text();
  return new NextResponse(responseText || null, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}
