import * as Sentry from "@sentry/nextjs";

import {
  shouldInjectOperatorAlertReceiverOutage,
  verifyOperatorAlertWebhook,
} from "@/lib/workbench/operator-alert-receiver";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.WORKBENCH_OPERATOR_ALERT_SIGNING_SECRET?.trim();
  if (!secret) return Response.json({ ok: false, error: "not configured" }, { status: 503 });
  const body = await request.text();
  const verification = await verifyOperatorAlertWebhook({
    body,
    signature: request.headers.get("x-assistant-mk1-alert-signature") ?? "",
    secret,
  });
  if (!verification.ok) {
    const status = verification.code === "body_too_large" ? 413 : 401;
    return Response.json(
      { ok: false, error: "alert rejected", code: verification.code },
      { status },
    );
  }

  const { alert } = verification.payload;
  if (
    shouldInjectOperatorAlertReceiverOutage(
      verification.payload,
      process.env.WORKBENCH_OPERATOR_ALERT_CONFORMANCE_MODE === "true",
    )
  ) {
    return Response.json(
      { ok: false, code: "conformance_receiver_outage", error: "receiver unavailable" },
      { status: 503 },
    );
  }
  Sentry.captureMessage(`Operloom operator alert: ${alert.code}`, {
    level: alert.severity === "critical" ? "error" : "warning",
    fingerprint: ["operloom-operator-alert", alert.code],
    tags: {
      service: "operloom",
      "operator_alert.code": alert.code,
      "operator_alert.severity": alert.severity,
    },
    extra: {
      alertCode: alert.code,
      status: alert.status,
      deliveryStatus: alert.deliveryStatus,
      deliveryAttempts: alert.deliveryAttempts,
    },
  });
  await Sentry.flush(2_000);
  return new Response(null, { status: 204 });
}
