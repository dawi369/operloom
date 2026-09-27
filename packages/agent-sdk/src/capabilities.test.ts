import { describe, expect, it } from "vitest";
import { negotiateRuntimeCapabilities } from "./capabilities";
import { defineControlPlaneModule } from "./runtime";

describe("runtime module negotiation", () => {
  it("defines the single control-plane contract", () => {
    const module = defineControlPlaneModule({
      packId: "example",
      runtimeVersion: "1.0.0",
      compatiblePackVersions: "^1.0.0",
      requirements: { minimumBackendVersion: "2.0.0", capabilities: ["workflow.request"] },
      tools: [],
      workflows: [],
      health: [],
      evals: [],
    });
    expect(module).toMatchObject({ apiVersion: 2, kind: "agent_control_plane_module" });
    expect(negotiateRuntimeCapabilities(module.requirements, "2.0.0")).toEqual({ ok: true });
  });
  it("fails closed on unavailable capability and backend versions", () => {
    const requirements = {
      minimumBackendVersion: "2.0.0",
      capabilities: ["future.capability"],
    };
    expect(negotiateRuntimeCapabilities(requirements, "2.0.0")).toMatchObject({
      ok: false,
      code: "runtime_capability_missing",
      missingCapabilities: ["future.capability"],
    });
    expect(negotiateRuntimeCapabilities(requirements, "1.9.0")).toMatchObject({
      ok: false,
      code: "backend_version_incompatible",
    });
  });
});
