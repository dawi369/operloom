import { describe, expect, it, vi } from "vitest";
import { signFacadeRequest } from "../../../lib/workbench/control-plane-signing";
import { requireControlPlaneAuth } from "./http";
import type { Env } from "./types";

const secret = "facade-integrity-regression-secret-0001";
const identity = {
  "x-assistant-mk1-user-id": "user-a",
  "x-assistant-mk1-workspace-id": "workspace-a",
  "x-assistant-mk1-account-id": "account-a",
  "x-assistant-mk1-role": "member",
  "x-assistant-mk1-permissions": "read",
};

const signedRequest = async () => {
  const signed = await signFacadeRequest({
    secret,
    method: "GET",
    pathWithQuery: "/workbench/context",
    headers: identity,
  });
  return new Request("https://control.example.test/workbench/context", {
    headers: { ...identity, ...signed },
  });
};
const environment = () => {
  const run = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn().mockReturnValue({ bind: () => ({ run }) });
  return {
    env: {
      CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET: secret,
      DB: { prepare },
    } as unknown as Env,
    prepare,
  };
};

describe("facade identity integrity after branding changes", () => {
  it("accepts an unchanged signed identity", async () => {
    const { env, prepare } = environment();
    expect((await requireControlPlaneAuth(await signedRequest(), env)).ok).toBe(true);
    expect(prepare).toHaveBeenCalled();
  });
  it.each(Object.keys(identity))("rejects changes to %s before touching D1", async (header) => {
    const { env, prepare } = environment();
    const request = await signedRequest();
    request.headers.set(header, "attacker-controlled");
    const result = await requireControlPlaneAuth(request, env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect((await result.response.json()).details.code).toBe("signature_invalid");
    }
    expect(prepare).not.toHaveBeenCalled();
  });
});
