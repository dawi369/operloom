import { isWorkbenchVersionCompatible } from "./compatibility.js";

/** Capabilities are enabled only after the corresponding implementation gate passes. */
export const implementedRuntimeCapabilities = [
  "workflow.request",
  "state.atomic",
  "state.migrations",
  "context.snapshots",
  "models.structured",
  "usage.reservations",
] as const;

export type RuntimeRequirements = {
  minimumBackendVersion: string;
  capabilities: readonly string[];
};

export const negotiateRuntimeCapabilities = (
  requirements: RuntimeRequirements,
  backendVersion: string,
  capabilities: readonly string[] = implementedRuntimeCapabilities,
):
  | { ok: true }
  | {
      ok: false;
      code: "backend_version_incompatible" | "runtime_capability_missing";
      message: string;
      missingCapabilities: string[];
    } => {
  if (!isWorkbenchVersionCompatible(backendVersion, requirements.minimumBackendVersion)) {
    return {
      ok: false,
      code: "backend_version_incompatible",
      message: `Package requires backend >= ${requirements.minimumBackendVersion}; running ${backendVersion}. Upgrade the backend before executing this package.`,
      missingCapabilities: [],
    };
  }
  const missingCapabilities = [...new Set(requirements.capabilities)].filter(
    (capability) => !capabilities.includes(capability),
  );
  return missingCapabilities.length
    ? {
        ok: false,
        code: "runtime_capability_missing",
        message: `Backend does not provide: ${missingCapabilities.join(", ")}. Install a backend release supporting these capabilities before executing this package.`,
        missingCapabilities,
      }
    : { ok: true };
};
