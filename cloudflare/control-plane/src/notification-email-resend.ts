import type { ChannelMessage, ChannelSendResult, ChannelTransport } from "./notification-channels";

/**
 * Direct email transport over Resend's REST API. The Worker holds the API key; SMS is not
 * handled here, so callers compose this with another transport for that channel.
 */
export type ResendEmailConfig = {
  apiKey: string;
  /** RFC 5322 sender, e.g. `Operloom <notify@example.com>`; the domain must be verified in Resend. */
  from: string;
  replyTo?: string;
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Plain text is authoritative; the HTML part is the same text with paragraphs and a route link. */
export const renderEmailParts = (message: ChannelMessage, consoleOrigin?: string) => {
  const route = consoleOrigin
    ? `${consoleOrigin.replace(/\/$/, "")}/?open=${encodeURIComponent(message.data.route)}&record=${encodeURIComponent(message.data.targetId)}`
    : null;
  const text = route ? `${message.body}\n\nOpen: ${route}` : message.body;
  const paragraphs = message.body
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const html = `<!doctype html><html><body style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#172126;max-width:36rem;margin:0 auto;padding:24px">${paragraphs}${
    route ? `<p><a href="${escapeHtml(route)}">Open in the workbench</a></p>` : ""
  }</body></html>`;
  return { text, html };
};

export const createResendEmailTransport = (
  config: ResendEmailConfig,
  options: { consoleOrigin?: string; fetcher?: typeof fetch } = {},
): ChannelTransport => {
  const fetcher = options.fetcher ?? fetch;
  return {
    async send(message): Promise<ChannelSendResult> {
      if (message.channel !== "email")
        return { ok: false, code: "resend_channel_unsupported", retryable: false };
      const parts = renderEmailParts(message, options.consoleOrigin);
      try {
        const response = await fetcher("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
            // Resend deduplicates on this key, so a retried delivery row does not send twice.
            "idempotency-key":
              `${message.data.eventType}:${message.data.targetId}:${message.address}`.slice(0, 256),
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.address],
            ...(config.replyTo ? { reply_to: config.replyTo } : {}),
            subject: message.title.slice(0, 200),
            text: parts.text,
            html: parts.html,
            tags: [
              { name: "event_type", value: message.data.eventType.replace(/[^a-zA-Z0-9_-]/g, "_") },
              { name: "route", value: message.data.route.replace(/[^a-zA-Z0-9_-]/g, "_") },
            ],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          const parsed = (await response.json().catch(() => null)) as { id?: unknown } | null;
          return {
            ok: true,
            ticketId:
              typeof parsed?.id === "string" ? `resend:${parsed.id.slice(0, 190)}` : "resend",
          };
        }
        // 429 and 5xx are worth a retry; 4xx means the address or payload is wrong.
        return {
          ok: false,
          code: `resend_http_${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
        };
      } catch {
        return { ok: false, code: "resend_unreachable", retryable: true };
      }
    },
  };
};

/** Email goes to the primary transport; everything else falls through. */
export const splitEmailTransport = (
  email: ChannelTransport,
  other: ChannelTransport,
): ChannelTransport => ({
  send: (message) => (message.channel === "email" ? email.send(message) : other.send(message)),
});
