import { scrubSentryBreadcrumb, scrubSentryEvent } from "../lib/observability/sentry-scrubber";

const sentinel = "observability-check-sensitive-value";
const candidates = [
  scrubSentryEvent({
    user: { id: sentinel, email: `${sentinel}@example.com` },
    request: {
      url: `https://example.com/callback?code=${sentinel}`,
      headers: {
        authorization: `Bearer ${sentinel}.payload.signature`,
        cookie: `session=${sentinel}`,
      },
      data: { credential: sentinel },
    },
    extra: { access_token: sentinel, nested: { client_secret: sentinel } },
    exception: { values: [{ value: `Bearer ${sentinel}.payload.signature` }] },
  }),
  scrubSentryBreadcrumb({
    message: `Bearer ${sentinel}.payload.signature`,
    data: { url: `https://example.com/path?token=${sentinel}`, password: sentinel },
  }),
];

if (JSON.stringify(candidates).includes(sentinel)) {
  throw new Error("Observability scrubber leaked a sensitive sentinel");
}
console.log("Observability privacy boundary verified.");
