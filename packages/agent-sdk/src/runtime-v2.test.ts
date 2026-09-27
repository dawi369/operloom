import { describe, expect, it } from "vitest";
import {
  adaptControlPlaneModule,
  defineControlPlaneModuleV2,
  negotiateRuntimeCapabilities,
} from "./runtime-v2";
import { defineControlPlaneModule } from "./runtime";

const module = {
  packId: "example",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  tools: [],
  workflows: [],
  health: [],
  evals: [],
};
describe("runtime module negotiation", () => {
  it("adapts v1 without mutating its identity or original contract", () => {
    const original = defineControlPlaneModule(module);
    const adapted = adaptControlPlaneModule(original);
    expect(original.apiVersion).toBe(1);
    expect(adapted.apiVersion).toBe(2);
    expect(adapted.tools).toBe(original.tools);
    expect(negotiateRuntimeCapabilities(adapted.requirements, "1.0.0")).toEqual({ ok: true });
  });
  it("fails closed on unavailable capability and backend versions", () => {
    const v2 = defineControlPlaneModuleV2({
      ...module,
      requirements: { minimumBackendVersion: "1.0.0", capabilities: ["future.capability.v99"] },
    });
    expect(negotiateRuntimeCapabilities(v2.requirements, "1.0.0")).toMatchObject({
      ok: false,
      code: "runtime_capability_missing",
      missingCapabilities: ["future.capability.v99"],
    });
    expect(negotiateRuntimeCapabilities(v2.requirements, "0.9.0")).toMatchObject({
      ok: false,
      code: "backend_version_incompatible",
    });
  });
});
