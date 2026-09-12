import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const environmentTargets = ["local", "acceptance", "production", "demo"] as const;
export type EnvironmentTarget = (typeof environmentTargets)[number];

type WebDeploymentCommon = {
  projectName: string;
  projectId: string;
  origin: string;
  framework: "nextjs";
  nodeVersion: "24.x";
};

export type WebDeployment = WebDeploymentCommon &
  (
    | { provider: "vercel"; organizationId: string }
    | {
        provider: "railway";
        workspaceId: string;
        environmentId: string;
        serviceId: string;
        serverless: true;
      }
  );

export type WorkbenchEnvironment = {
  schemaVersion: 2;
  target: EnvironmentTarget;
  conformanceMode: boolean;
  vaultBackend: "memory" | "workos";
  mutationDefaultEnabled: boolean;
  cloudflare: {
    workerName: string;
    d1DatabaseName: string;
    d1DatabaseId: string;
    r2BucketName: string;
    origin: string;
  };
  fly: { appName: string; origin: string };
  web: WebDeployment;
  workos: { applicationName: string; applicationId: string; acceptanceWorkspaceId: string };
  secretEnvironmentVariables: {
    facadeSigning: string;
    runnerSigning: string;
    callbackSigning: string;
    agentConnection: string;
    operatorAlertSigning: string;
    workosCookie: string;
    langgraphProxy: string;
    vault: string;
    openrouter: string;
  };
  observabilityEnvironmentVariables: {
    sentryDsn: string;
    sentryAuthToken: string;
  };
};

const referencePattern = /^\$\{([A-Z][A-Z0-9_]*)\}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export const isEnvironmentTarget = (value: string): value is EnvironmentTarget =>
  environmentTargets.includes(value as EnvironmentTarget);

const requireString = (value: unknown, path: string, failures: string[]) => {
  if (typeof value !== "string" || !value.trim()) {
    failures.push(`${path} must be a non-empty string`);
    return "";
  }
  return value.trim();
};

export const parseWorkbenchEnvironment = (value: unknown): WorkbenchEnvironment => {
  const failures: string[] = [];
  const root = isRecord(value) ? value : {};
  const cloudflare = isRecord(root.cloudflare) ? root.cloudflare : {};
  const fly = isRecord(root.fly) ? root.fly : {};
  const web = isRecord(root.web) ? root.web : {};
  const workos = isRecord(root.workos) ? root.workos : {};
  const secrets = isRecord(root.secretEnvironmentVariables) ? root.secretEnvironmentVariables : {};
  const observability = isRecord(root.observabilityEnvironmentVariables)
    ? root.observabilityEnvironmentVariables
    : {};
  const target = requireString(root.target, "target", failures);
  if (!isEnvironmentTarget(target)) failures.push(`target must be ${environmentTargets.join("|")}`);
  if (root.schemaVersion !== 2) failures.push("schemaVersion must be 2");
  if (typeof root.conformanceMode !== "boolean") failures.push("conformanceMode must be boolean");
  if (root.vaultBackend !== "memory" && root.vaultBackend !== "workos") {
    failures.push("vaultBackend must be memory|workos");
  }
  if (typeof root.mutationDefaultEnabled !== "boolean") {
    failures.push("mutationDefaultEnabled must be boolean");
  }

  const webCommon = {
    projectName: requireString(web.projectName, "web.projectName", failures),
    projectId: requireString(web.projectId, "web.projectId", failures),
    origin: requireString(web.origin, "web.origin", failures),
    framework: requireString(web.framework, "web.framework", failures) as "nextjs",
    nodeVersion: requireString(web.nodeVersion, "web.nodeVersion", failures) as "24.x",
  };
  const provider = requireString(web.provider, "web.provider", failures);
  const parsedWeb: WebDeployment =
    provider === "railway"
      ? {
          ...webCommon,
          provider,
          workspaceId: requireString(web.workspaceId, "web.workspaceId", failures),
          environmentId: requireString(web.environmentId, "web.environmentId", failures),
          serviceId: requireString(web.serviceId, "web.serviceId", failures),
          serverless: true,
        }
      : {
          ...webCommon,
          provider: "vercel",
          organizationId: requireString(web.organizationId, "web.organizationId", failures),
        };
  if (provider !== "vercel" && provider !== "railway")
    failures.push("web.provider must be vercel|railway");
  if (provider === "railway" && web.serverless !== true)
    failures.push("railway web.serverless must be true");

  const parsed = {
    schemaVersion: 2,
    target: target as EnvironmentTarget,
    conformanceMode: root.conformanceMode === true,
    vaultBackend: root.vaultBackend as "memory" | "workos",
    mutationDefaultEnabled: root.mutationDefaultEnabled === true,
    cloudflare: {
      workerName: requireString(cloudflare.workerName, "cloudflare.workerName", failures),
      d1DatabaseName: requireString(
        cloudflare.d1DatabaseName,
        "cloudflare.d1DatabaseName",
        failures,
      ),
      d1DatabaseId: requireString(cloudflare.d1DatabaseId, "cloudflare.d1DatabaseId", failures),
      r2BucketName: requireString(cloudflare.r2BucketName, "cloudflare.r2BucketName", failures),
      origin: requireString(cloudflare.origin, "cloudflare.origin", failures),
    },
    fly: {
      appName: requireString(fly.appName, "fly.appName", failures),
      origin: requireString(fly.origin, "fly.origin", failures),
    },
    web: parsedWeb,
    workos: {
      applicationName: requireString(workos.applicationName, "workos.applicationName", failures),
      applicationId: requireString(workos.applicationId, "workos.applicationId", failures),
      acceptanceWorkspaceId: requireString(
        workos.acceptanceWorkspaceId,
        "workos.acceptanceWorkspaceId",
        failures,
      ),
    },
    secretEnvironmentVariables: {
      facadeSigning: requireString(
        secrets.facadeSigning,
        "secretEnvironmentVariables.facadeSigning",
        failures,
      ),
      runnerSigning: requireString(
        secrets.runnerSigning,
        "secretEnvironmentVariables.runnerSigning",
        failures,
      ),
      callbackSigning: requireString(
        secrets.callbackSigning,
        "secretEnvironmentVariables.callbackSigning",
        failures,
      ),
      agentConnection: requireString(
        secrets.agentConnection,
        "secretEnvironmentVariables.agentConnection",
        failures,
      ),
      operatorAlertSigning: requireString(
        secrets.operatorAlertSigning,
        "secretEnvironmentVariables.operatorAlertSigning",
        failures,
      ),
      workosCookie: requireString(
        secrets.workosCookie,
        "secretEnvironmentVariables.workosCookie",
        failures,
      ),
      langgraphProxy: requireString(
        secrets.langgraphProxy,
        "secretEnvironmentVariables.langgraphProxy",
        failures,
      ),
      vault: requireString(secrets.vault, "secretEnvironmentVariables.vault", failures),
      openrouter: requireString(
        secrets.openrouter,
        "secretEnvironmentVariables.openrouter",
        failures,
      ),
    },
    observabilityEnvironmentVariables: {
      sentryDsn: requireString(
        observability.sentryDsn,
        "observabilityEnvironmentVariables.sentryDsn",
        failures,
      ),
      sentryAuthToken: requireString(
        observability.sentryAuthToken,
        "observabilityEnvironmentVariables.sentryAuthToken",
        failures,
      ),
    },
  } satisfies WorkbenchEnvironment;

  if (parsed.web.framework !== "nextjs") failures.push("web.framework must be nextjs");
  if (parsed.web.nodeVersion !== "24.x") failures.push("web.nodeVersion must be 24.x");

  if (failures.length) throw new Error(failures.join("; "));
  return parsed;
};

export const loadWorkbenchEnvironment = (target: EnvironmentTarget) => {
  const path = resolve(process.cwd(), "config/environments", `${target}.json`);
  return parseWorkbenchEnvironment(JSON.parse(readFileSync(path, "utf8")) as unknown);
};

export const referencedEnvironmentVariable = (value: string) =>
  referencePattern.exec(value)?.[1] ?? null;

export const resolveEnvironmentReferences = (
  manifest: WorkbenchEnvironment,
  source: NodeJS.ProcessEnv = process.env,
): { manifest: WorkbenchEnvironment; unresolved: string[] } => {
  const unresolved = new Set<string>();
  const resolveValue = (value: string) => {
    const variable = referencedEnvironmentVariable(value);
    if (!variable) return value;
    const resolved = source[variable]?.trim();
    if (!resolved) {
      unresolved.add(variable);
      return value;
    }
    return resolved;
  };
  return {
    manifest: {
      ...manifest,
      cloudflare: {
        ...manifest.cloudflare,
        d1DatabaseId: resolveValue(manifest.cloudflare.d1DatabaseId),
        origin: resolveValue(manifest.cloudflare.origin),
      },
      fly: { ...manifest.fly, origin: resolveValue(manifest.fly.origin) },
      web:
        manifest.web.provider === "vercel"
          ? {
              ...manifest.web,
              organizationId: resolveValue(manifest.web.organizationId),
              projectId: resolveValue(manifest.web.projectId),
              origin: resolveValue(manifest.web.origin),
            }
          : {
              ...manifest.web,
              workspaceId: resolveValue(manifest.web.workspaceId),
              projectId: resolveValue(manifest.web.projectId),
              environmentId: resolveValue(manifest.web.environmentId),
              serviceId: resolveValue(manifest.web.serviceId),
              origin: resolveValue(manifest.web.origin),
            },
      workos: {
        ...manifest.workos,
        applicationId: resolveValue(manifest.workos.applicationId),
        acceptanceWorkspaceId: resolveValue(manifest.workos.acceptanceWorkspaceId),
      },
    },
    unresolved: [...unresolved].sort(),
  };
};

const resourceValues = (manifest: WorkbenchEnvironment) => ({
  worker: manifest.cloudflare.workerName,
  d1Name: manifest.cloudflare.d1DatabaseName,
  d1Id: manifest.cloudflare.d1DatabaseId,
  r2: manifest.cloudflare.r2BucketName,
  cloudflareOrigin: manifest.cloudflare.origin,
  flyApp: manifest.fly.appName,
  flyOrigin: manifest.fly.origin,
  webProject: manifest.web.projectId,
  webProjectName: manifest.web.projectName,
  webOrigin: manifest.web.origin,
  workosApplication: manifest.workos.applicationId,
  workosApplicationName: manifest.workos.applicationName,
});

export const validateEnvironmentSet = (manifests: WorkbenchEnvironment[]) => {
  const failures: string[] = [];
  const targets = new Set(manifests.map((manifest) => manifest.target));
  if (targets.size !== manifests.length) failures.push("environment targets must be unique");

  for (const manifest of manifests) {
    if (manifest.target === "production") {
      if (manifest.conformanceMode) failures.push("production cannot enable conformance mode");
      if (manifest.vaultBackend === "memory") failures.push("production cannot use memory Vault");
    }
    if (manifest.mutationDefaultEnabled) {
      failures.push(`${manifest.target} cannot default mutations on`);
    }
    const secretNames = Object.values(manifest.secretEnvironmentVariables);
    if (new Set(secretNames).size !== secretNames.length) {
      failures.push(`${manifest.target} secret references must be role-distinct`);
    }
  }

  const keyed = manifests.map((manifest) => [manifest.target, resourceValues(manifest)] as const);
  const resourceKeys = Object.keys(keyed[0]?.[1] ?? {}) as (keyof ReturnType<
    typeof resourceValues
  >)[];
  for (const key of resourceKeys) {
    const owners = new Map<string, string>();
    for (const [target, resources] of keyed) {
      const value = resources[key];
      const existing = owners.get(value);
      if (existing) failures.push(`${key} is shared by ${existing} and ${target}`);
      owners.set(value, target);
    }
  }

  const secretOwners = new Map<string, string>();
  for (const manifest of manifests) {
    for (const variable of Object.values(manifest.secretEnvironmentVariables)) {
      const existing = secretOwners.get(variable);
      if (existing)
        failures.push(
          `secret reference ${variable} is shared by ${existing} and ${manifest.target}`,
        );
      secretOwners.set(variable, manifest.target);
    }
  }
  return failures;
};

export const validateEnvironmentSecretValues = (
  manifests: readonly WorkbenchEnvironment[],
  source: NodeJS.ProcessEnv = process.env,
) => {
  const failures: string[] = [];
  const owners = new Map<string, string>();
  for (const manifest of manifests) {
    const values = Object.entries(manifest.secretEnvironmentVariables).map(([role, variable]) => {
      const value = source[variable]?.trim() ?? "";
      if (!value) failures.push(`${manifest.target} ${role} secret is missing`);
      else if (value.length < 32) failures.push(`${manifest.target} ${role} secret is too short`);
      return { role, variable, value };
    });
    const targetValues = values.filter((item) => item.value);
    if (new Set(targetValues.map((item) => item.value)).size !== targetValues.length) {
      failures.push(`${manifest.target} secret roles must use distinct values`);
    }
    for (const item of targetValues) {
      const existing = owners.get(item.value);
      if (existing) {
        failures.push(`${manifest.target} ${item.role} secret is shared with ${existing}`);
      } else {
        owners.set(item.value, `${manifest.target} ${item.role}`);
      }
    }
  }
  return failures;
};
