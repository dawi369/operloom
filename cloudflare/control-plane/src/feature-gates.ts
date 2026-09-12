import type { Env } from "./types";
import { demoConfigurationValid } from "./demo-policy";

const enabled = (value: string | undefined) => value?.trim().toLowerCase() === "true";

export const retainedDataEnabled = (env: Env) => enabled(env.WORKBENCH_RETAINED_DATA_ENABLED);
export const connectionsEnabled = (env: Env) => enabled(env.WORKBENCH_CONNECTIONS_ENABLED);
export const mutationsEnabled = (env: Env) => enabled(env.WORKBENCH_MUTATIONS_ENABLED);
export const pushEnabled = (env: Env) => enabled(env.WORKBENCH_PUSH_ENABLED);

export const releaseFeaturePosture = (env: Env) => ({
  retainedData: retainedDataEnabled(env),
  connections: connectionsEnabled(env),
  mutations: mutationsEnabled(env),
  push: pushEnabled(env),
});

export const releaseFeatureConfigurationValid = (env: Env) => {
  if (!demoConfigurationValid(env)) return false;
  const posture = releaseFeaturePosture(env);
  if (posture.connections && !posture.retainedData) return false;
  if (posture.mutations && (!posture.connections || !posture.retainedData)) return false;
  if (posture.push && (!posture.retainedData || !env.NOTIFICATIONS)) return false;
  if ((posture.connections || posture.push) && env.WORKBENCH_VAULT_BACKEND === "memory") {
    return env.WORKBENCH_E2E_MODE === "true";
  }
  if ((posture.connections || posture.push) && !env.WORKOS_API_KEY?.trim()) return false;
  return true;
};
