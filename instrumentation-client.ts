import * as Sentry from "@sentry/nextjs";

import { scrubSentryBreadcrumb, scrubSentryEvent } from "./lib/observability/sentry-scrubber";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const isDevelopment = process.env.NODE_ENV === "development";
const enabled =
  Boolean(dsn) && (!isDevelopment || process.env.NEXT_PUBLIC_SENTRY_ENABLE_LOCAL === "true");

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
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: parseSampleRate(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
      isDevelopment ? 1.0 : 0.02,
    ),
    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],
    replaysSessionSampleRate: parseSampleRate(
      process.env.NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE,
      isDevelopment ? 1.0 : 0,
    ),
    replaysOnErrorSampleRate: parseSampleRate(
      process.env.NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE,
      1.0,
    ),
    initialScope: {
      tags: {
        service: "operloom",
        "runtime.surface": "vercel-next",
      },
    },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
