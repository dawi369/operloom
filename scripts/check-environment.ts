import {
  environmentTargets,
  isEnvironmentTarget,
  loadWorkbenchEnvironment,
  resolveEnvironmentReferences,
  validateEnvironmentSet,
  validateEnvironmentSecretValues,
} from "./workbench-environment";

const args = process.argv.slice(2);
const targetValue = args[args.indexOf("--target") + 1];
const configurationOnly = args.includes("--configuration-only");
const verifySecrets = args.includes("--verify-secrets");
const verifyAllSecrets = args.includes("--verify-all-secrets");

if (!targetValue || !isEnvironmentTarget(targetValue)) {
  throw new Error(`--target must be one of ${environmentTargets.join("|")}`);
}

const manifests = environmentTargets.map(loadWorkbenchEnvironment);
const failures = validateEnvironmentSet(manifests);
const selected = manifests.find((manifest) => manifest.target === targetValue)!;
const resolved = resolveEnvironmentReferences(selected);

if (verifySecrets || verifyAllSecrets) {
  failures.push(...validateEnvironmentSecretValues(verifyAllSecrets ? manifests : [selected]));
}

if (!configurationOnly && resolved.unresolved.length) {
  failures.push(`missing required variables: ${resolved.unresolved.join(", ")}`);
}
if (!configurationOnly && resolved.unresolved.length === 0) {
  const selectedResolved = resolved.manifest;
  if (
    targetValue !== "local" &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      selectedResolved.cloudflare.d1DatabaseId,
    )
  ) {
    failures.push("hosted D1 database ID must be a UUID");
  }
  for (const [name, value] of Object.entries({
    cloudflare: selectedResolved.cloudflare.origin,
    fly: selectedResolved.fly.origin,
    web: selectedResolved.web.origin,
  })) {
    try {
      const url = new URL(value);
      if (targetValue !== "local" && url.protocol !== "https:") {
        failures.push(`${name} origin must use https`);
      }
      if (url.origin !== value.replace(/\/$/, "")) failures.push(`${name} must be an origin`);
    } catch {
      failures.push(`${name} origin is invalid`);
    }
  }
}
if (targetValue !== "local" && process.env.CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN) {
  failures.push(`${targetValue} rejects CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN`);
}
if (targetValue === "production" && process.env.WORKBENCH_CONFORMANCE_MODE === "true") {
  failures.push("production rejects WORKBENCH_CONFORMANCE_MODE=true");
}
if (targetValue === "production" && process.env.WORKBENCH_VAULT_BACKEND === "memory") {
  failures.push("production rejects WORKBENCH_VAULT_BACKEND=memory");
}
if (
  targetValue === "production" &&
  process.env.WORKBENCH_OPERATOR_ALERT_CONFORMANCE_MODE === "true"
) {
  failures.push("production rejects operator-alert conformance mode");
}
if (process.env.WORKBENCH_MOBILE_CLIENTS_ENABLED === "true") {
  const allowedClientIds = process.env.WORKBENCH_WORKOS_ALLOWED_CLIENT_IDS?.trim();
  if (!allowedClientIds) failures.push("mobile clients require allowed WorkOS client IDs");
  for (const [name, value] of Object.entries({
    WORKBENCH_WORKOS_ISSUER: process.env.WORKBENCH_WORKOS_ISSUER,
    WORKBENCH_WORKOS_JWKS_URL: process.env.WORKBENCH_WORKOS_JWKS_URL,
  })) {
    try {
      const url = new URL(value ?? "");
      if (targetValue !== "local" && url.protocol !== "https:") {
        failures.push(`${name} must use https for hosted mobile clients`);
      }
    } catch {
      failures.push(`${name} must be configured for mobile clients`);
    }
  }
}

if (failures.length) {
  console.error(`Environment ${targetValue} is invalid:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Environment ${targetValue} passed ${configurationOnly ? "configuration" : "resolved"} checks.`,
  );
}
