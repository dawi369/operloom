import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { assessLocalNodeRuntime } from "./node-runtime";
import { readLocalEnvironment, type LocalEnvironment } from "./workbench-local-env";

type Values = LocalEnvironment;

export const probeWorkOSApiKey = async (
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<number> => {
  const response = await request("https://api.workos.com/user_management/users?limit=1", {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  return response.status;
};

export type WorkbenchDoctorResult = {
  checks: string[];
  failures: string[];
};

export type WorkbenchDoctorOptions = {
  root: string;
  offline: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
  allowMissingProviderKey?: boolean;
};

const readEnvFile = (root: string, file: string, checks: string[], failures: string[]): Values => {
  const values = readLocalEnvironment(root, file);
  if (!values) {
    failures.push(`${file} is missing`);
    return {};
  }
  checks.push(`${file} loaded`);
  return values;
};

export const diagnoseWorkbench = async ({
  root,
  offline,
  environment = process.env,
  allowMissingProviderKey = false,
}: WorkbenchDoctorOptions): Promise<WorkbenchDoctorResult> => {
  const failures: string[] = [];
  const checks: string[] = [];
  const nodeRuntime = assessLocalNodeRuntime();
  if (nodeRuntime.supported) checks.push(nodeRuntime.message);
  else failures.push(nodeRuntime.message);

  const frontend = {
    ...readEnvFile(root, ".env.local", checks, failures),
    ...environment,
  } as Values;
  const worker = readEnvFile(root, "cloudflare/control-plane/.dev.vars", checks, failures);
  const requireValue = (source: Values, key: string, label: string) => {
    const value = source[key]?.trim();
    if (!value || value.startsWith("replace-with-")) failures.push(`${label} is missing ${key}`);
  };

  for (const key of ["OPERLOOM_BACKEND_URL", "OPERLOOM_LOCAL_API_TOKEN"]) {
    requireValue(frontend, key, ".env.local");
  }
  for (const key of ["OPERLOOM_LOCAL_API_TOKEN", "OPERLOOM_AGENT_CONNECTION_SECRET"]) {
    requireValue(worker, key, "cloudflare/control-plane/.dev.vars");
  }
  if (!allowMissingProviderKey) {
    requireValue(worker, "OPENROUTER_API_KEY", "cloudflare/control-plane/.dev.vars");
  }
  if (frontend.OPERLOOM_LOCAL_API_ENABLED !== "true") {
    failures.push(".env.local must explicitly enable OPERLOOM_LOCAL_API_ENABLED");
  }
  if (worker.OPERLOOM_LOCAL_API_ENABLED !== "true" || worker.OPERLOOM_ENVIRONMENT !== "local") {
    failures.push(
      "cloudflare/control-plane/.dev.vars must set OPERLOOM_LOCAL_API_ENABLED=true and OPERLOOM_ENVIRONMENT=local",
    );
  }
  if (
    frontend.OPERLOOM_LOCAL_API_TOKEN &&
    worker.OPERLOOM_LOCAL_API_TOKEN &&
    frontend.OPERLOOM_LOCAL_API_TOKEN !== worker.OPERLOOM_LOCAL_API_TOKEN
  ) {
    failures.push("frontend and Worker control-plane tokens do not match");
  }
  if (worker.OPERLOOM_RUNNER_TRANSPORT === "fly") {
    requireValue(worker, "OPERLOOM_RUNNER_URL", "cloudflare/control-plane/.dev.vars");
    requireValue(worker, "OPERLOOM_RUNNER_SIGNING_SECRET", "cloudflare/control-plane/.dev.vars");
    requireValue(worker, "OPERLOOM_CALLBACK_URL", "cloudflare/control-plane/.dev.vars");
    requireValue(worker, "OPERLOOM_CALLBACK_SIGNING_SECRET", "cloudflare/control-plane/.dev.vars");
    if (
      frontend.OPERLOOM_RUNNER_SIGNING_SECRET &&
      frontend.OPERLOOM_RUNNER_SIGNING_SECRET !== worker.OPERLOOM_RUNNER_SIGNING_SECRET
    ) {
      failures.push("frontend runner signing secret does not match the Worker runner secret");
    }
  }
  if (
    frontend.OPERLOOM_CALLBACK_SIGNING_SECRET &&
    worker.OPERLOOM_CALLBACK_SIGNING_SECRET &&
    frontend.OPERLOOM_CALLBACK_SIGNING_SECRET !== worker.OPERLOOM_CALLBACK_SIGNING_SECRET
  ) {
    failures.push("frontend and Worker callback signing secrets do not match");
  }
  const alertWebhookUrl = worker.OPERLOOM_OPERATOR_ALERT_WEBHOOK_URL?.trim();
  const alertSigningSecret = worker.OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET?.trim();
  if (Boolean(alertWebhookUrl) !== Boolean(alertSigningSecret)) {
    failures.push(
      "Worker operator alert webhook URL and signing secret must be configured together",
    );
  }
  if (alertWebhookUrl) {
    try {
      const url = new URL(alertWebhookUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (url.port && url.port !== "443")
      ) {
        failures.push(
          "Worker operator alert webhook must use HTTPS on the standard port without credentials in the URL",
        );
      }
    } catch {
      failures.push("Worker operator alert webhook URL is invalid");
    }
  }
  if (
    frontend.OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET &&
    alertSigningSecret &&
    frontend.OPERLOOM_OPERATOR_ALERT_SIGNING_SECRET !== alertSigningSecret
  ) {
    failures.push("Vercel and Worker operator alert signing secrets do not match");
  }
  if (!existsSync(path.join(root, "cloudflare/control-plane/schema.sql"))) {
    failures.push("rebuildable D1 schema is missing");
  } else {
    checks.push("rebuildable D1 schema found");
  }
  const wranglerConfigPath = path.join(root, "cloudflare/control-plane/wrangler.jsonc");
  if (!existsSync(wranglerConfigPath)) {
    failures.push("Cloudflare Worker configuration is missing");
  } else if (!readFileSync(wranglerConfigPath, "utf8").includes('"binding": "ARTIFACTS"')) {
    failures.push("Cloudflare Worker configuration is missing the ARTIFACTS R2 binding");
  } else {
    checks.push("artifact R2 binding declaration found");
  }

  if (!offline && failures.length === 0) {
    const origin = frontend.OPERLOOM_BACKEND_URL.replace(/\/$/, "");
    try {
      const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!health.ok) failures.push(`Worker health returned HTTP ${health.status}`);
      else checks.push("Worker health and D1 query succeeded");

      const account = await fetch(`${origin}/v1/account`, {
        headers: { authorization: `Bearer ${frontend.OPERLOOM_LOCAL_API_TOKEN}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!account.ok) failures.push(`local API account returned HTTP ${account.status}`);
      else checks.push("local API user, workspace, membership, agent, and preferences validated");

      if (worker.OPERLOOM_RUNNER_TRANSPORT === "fly" && worker.OPERLOOM_RUNNER_URL) {
        const runnerOrigin = new URL(worker.OPERLOOM_RUNNER_URL).origin;
        const runner = await fetch(`${runnerOrigin}/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!runner.ok) failures.push(`signed runner health returned HTTP ${runner.status}`);
        else checks.push("signed runner is reachable");
      }
    } catch {
      failures.push("A local service is unreachable; start pnpm workbench dev or use --offline");
    }

    if (frontend.WORKOS_CLIENT_ID && frontend.WORKOS_API_KEY) {
      try {
        const status = await probeWorkOSApiKey(frontend.WORKOS_API_KEY);
        if (status === 200) checks.push("WorkOS API key is accepted");
        else if (status === 401)
          failures.push(
            "WorkOS rejected the local API key (HTTP 401); replace it before signing in",
          );
        else failures.push(`WorkOS credential check returned HTTP ${status}`);
      } catch {
        failures.push("WorkOS credential check is unavailable; retry when WorkOS is reachable");
      }
    }
  }

  return { checks, failures };
};
