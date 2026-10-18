import type { Env } from "./types";

const enabled = (value: string | undefined) => value?.trim().toLowerCase() === "true";

export const retainedDataEnabled = (env: Env) => enabled(env.OPERLOOM_RETAINED_DATA_ENABLED);
export const connectionsEnabled = (env: Env) => enabled(env.OPERLOOM_CONNECTIONS_ENABLED);
export const mutationsEnabled = (env: Env) => enabled(env.OPERLOOM_MUTATIONS_ENABLED);
export const pushEnabled = (env: Env) => enabled(env.OPERLOOM_PUSH_ENABLED);

export const releaseFeaturePosture = (env: Env) => ({
  retainedData: retainedDataEnabled(env),
  connections: connectionsEnabled(env),
  mutations: mutationsEnabled(env),
  push: pushEnabled(env),
});
