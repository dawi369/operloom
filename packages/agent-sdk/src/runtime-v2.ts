import { isWorkbenchVersionCompatible } from "./compatibility.js";
import type { ControlPlaneRuntimeModule } from "./runtime.js";

/** Capabilities are enabled only after the corresponding implementation gate passes. */
export const implementedRuntimeCapabilities = [
  "runtime.module.v2",
  "runtime.workflow.request.v1",
  "state.atomic.v2",
  "state.migrations.v2",
  "context.snapshots.v2",
  "models.structured.v2",
  "usage.reservations.v2",
] as const;

export type RuntimeRequirements = {
  minimumBackendVersion: string;
  capabilities: readonly string[];
};

/** The versioned extension boundary; additions are negotiated, never inferred. */
export type ControlPlaneRuntimeModuleV2 = Omit<ControlPlaneRuntimeModule, "apiVersion"> & {
  apiVersion: 2;
  requirements: RuntimeRequirements;
  context?: readonly import("./context.js").RuntimeContextBinding[];
  state?: readonly import("./state.js").RuntimeStateDefinition[];
  stateMigrations?: readonly import("./state.js").RuntimeStateMigration[];
};

export type AnyControlPlaneRuntimeModule = ControlPlaneRuntimeModule | ControlPlaneRuntimeModuleV2;

export const defineControlPlaneModuleV2 = <
  const T extends Omit<ControlPlaneRuntimeModuleV2, "apiVersion" | "kind">,
>(
  value: T,
): T & Pick<ControlPlaneRuntimeModuleV2, "apiVersion" | "kind"> => ({
  ...value,
  apiVersion: 2,
  kind: "agent_control_plane_module",
});

/** Preserve functions and identities without mutating historical v1 modules. */
export const adaptControlPlaneModule = (
  module: AnyControlPlaneRuntimeModule,
): ControlPlaneRuntimeModuleV2 =>
  module.apiVersion === 2
    ? module
    : {
        ...module,
        apiVersion: 2,
        requirements: {
          minimumBackendVersion: "1.0.0",
          capabilities: ["runtime.workflow.request.v1"],
        },
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
