import * as Sentry from "@sentry/nextjs";

import { scrubSentryBreadcrumb, scrubSentryEvent } from "./lib/observability/sentry-scrubber";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
const isDevelopment = process.env.NODE_ENV === "development";
const enabled = Boolean(dsn) && (!isDevelopment || process.env.SENTRY_ENABLE_LOCAL === "true");

const parseSampleRate = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
};

if (enabled) {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: parseSampleRate(
      process.env.SENTRY_TRACES_SAMPLE_RATE,
      isDevelopment ? 1.0 : 0.02,
    ),
    initialScope: {
      tags: {
        service: "operloom",
        "runtime.surface": "vercel-next",
        "runtime.target": "edge",
      },
    },
  });
}
