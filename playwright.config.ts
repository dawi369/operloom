import { defineConfig } from "@playwright/test";

const releaseMode = process.env.E2E_RELEASE_MODE;

if (releaseMode !== "signed-out" && releaseMode !== "local-session") {
  throw new Error("E2E_RELEASE_MODE must be signed-out or local-session");
}

const appOrigin = "http://localhost:3100";
// Exercise the README topology: the facade and runner may address the same
// worker through different hostnames. Callbacks must use the configured origin.
const redirectEnv = `NEXT_PUBLIC_WORKOS_REDIRECT_URI=${appOrigin}/auth/callback`;
const syntheticAuthEnv =
  "WORKOS_API_KEY='' WORKOS_CLIENT_ID=client_e2e_synthetic NEXT_PUBLIC_WORKOS_CLIENT_ID=client_e2e_synthetic WORKOS_COOKIE_PASSWORD=e2e-cookie-password-000000000000001";
const frontendCommand =
  releaseMode === "signed-out"
    ? `${redirectEnv} ${syntheticAuthEnv} WORKBENCH_ALLOW_LOCAL_DEV_IDENTITY=false pnpm exec tsx scripts/run-with-log.ts output/playwright/frontend-signed-out.log pnpm exec next dev --webpack --disable-source-maps -p 3100`
    : `${redirectEnv} ${syntheticAuthEnv} WORKBENCH_ALLOW_LOCAL_DEV_IDENTITY=true WORKBENCH_DEV_USER_ID=e2e-owner WORKBENCH_DEV_WORKSPACE_ID=e2e-workspace WORKBENCH_DEV_AGENT_ID=e2e-agent WORKBENCH_ADMIN_USER_IDS=e2e-owner CLOUDFLARE_CONTROL_PLANE_URL=http://localhost:8788 CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN=e2e-control-plane-token CLOUDFLARE_CONTROL_PLANE_WEBHOOK_FACADE_SIGNING_SECRET=e2e-facade-signing-secret-000001 pnpm exec tsx scripts/run-with-log.ts output/playwright/frontend-local.log pnpm exec next dev --webpack --disable-source-maps -p 3100`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  globalTimeout: 10 * 60_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  // These journeys start a cold development compiler. Data-backed UI can
  // span several first-time route compilations; latency checks stay explicit.
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "output/playwright/results",
  use: {
    baseURL: appOrigin,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    ...(releaseMode === "local-session"
      ? [
          {
            command: "pnpm e2e:serve:runner",
            url: "http://127.0.0.1:3101/health/live",
            reuseExistingServer: false,
            gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5000 },
            timeout: 60_000,
          },
          {
            command: "pnpm e2e:serve:worker",
            url: "http://127.0.0.1:8788/health/live",
            reuseExistingServer: false,
            gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5000 },
            timeout: 60_000,
          },
        ]
      : []),
    {
      command: frontendCommand,
      // A health route does not establish that the page and its metadata have
      // compiled. Wait for the actual browser entry point before navigation.
      url: appOrigin,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5000 },
      timeout: 60_000,
    },
  ],
});
