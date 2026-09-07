import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["@sentry/nextjs"],
  turbopack: {},
  experimental: {
    cpus: 2,
    webpackMemoryOptimizations: true,
  },
  webpack(config, { dev }) {
    if (dev) config.parallelism = 2;
    return config;
  },
};

const instrumentedConfig = withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG ?? "t23",
  project: process.env.SENTRY_PROJECT ?? "assistant-mk1",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
});

export default process.env.NODE_ENV === "development" ? nextConfig : instrumentedConfig;
