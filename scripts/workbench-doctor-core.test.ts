import { describe, expect, it, vi } from "vitest";

import { probeWorkOSApiKey } from "./workbench-doctor-core";

describe("WorkOS credential probe", () => {
  it("checks the key server-side without sending the client ID or reading user data", async () => {
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    expect(await probeWorkOSApiKey("fixture-key", request as typeof fetch)).toBe(200);
    expect(request).toHaveBeenCalledWith(
      "https://api.workos.com/user_management/users?limit=1",
      expect.objectContaining({ headers: { authorization: "Bearer fixture-key" } }),
    );
  });

  it("reports the same unauthorized response as a revoked local key", async () => {
    const request = vi.fn(async () => new Response(null, { status: 401 }));
    expect(await probeWorkOSApiKey("fixture-key", request as typeof fetch)).toBe(401);
  });
});
