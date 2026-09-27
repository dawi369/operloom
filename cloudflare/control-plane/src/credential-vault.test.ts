import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryCredentialVault,
  createWorkOSCredentialVault,
  resolveCredentialVault,
} from "./credential-vault";
import type { Env } from "./types";

afterEach(() => vi.restoreAllMocks());

describe("credential vault", () => {
  it("keeps deterministic test credentials isolated behind opaque references", async () => {
    const vault = createMemoryCredentialVault();
    const reference = await vault.create({
      context: { workspaceId: "workspace-a" },
      name: "broker",
      value: "secret-value",
    });
    expect(reference.id).not.toContain("secret-value");
    await expect(vault.read(reference)).resolves.toEqual({ value: "secret-value", version: "1" });
    const replaced = await vault.replace({ ...reference, value: "rotated" });
    await expect(vault.read(reference)).rejects.toThrow("vault_version_conflict");
    await expect(vault.read(replaced)).resolves.toEqual({ value: "rotated", version: "2" });
    await vault.revoke(replaced);
    await expect(vault.read(replaced)).rejects.toThrow("vault_object_not_found");
  });

  it("forbids the in-memory backend outside explicit E2E mode", () => {
    expect(() => resolveCredentialVault({ OPERLOOM_VAULT_BACKEND: "memory" } as Env)).toThrow(
      "insecure_vault_backend_forbidden",
    );
  });

  it("uses WorkOS object versions without exposing credentials in failures", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "secret-1", version_id: "v1" })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "secret-1", metadata: { version_id: "v2" } })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    const vault = createWorkOSCredentialVault({ WORKOS_API_KEY: "workos-secret" } as Env);
    const created = await vault.create({
      context: { workspaceId: "workspace-1" },
      name: "connection:test",
      value: "provider-secret",
    });
    const rotated = await vault.replace({ ...created, value: "rotated-provider-secret" });
    await vault.delete(rotated);

    const createBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(createBody).toMatchObject({
      name: "workspace-1:connection:test",
      value: "provider-secret",
    });
    expect(createBody.key_context.workspace_id).toMatch(/^[a-f0-9]{64}$/);
    expect(createBody.key_context.workspace_id).not.toContain("workspace-1");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://api.workos.com/vault/v1/kv/secret-1?version_check=v2",
    );
  });

  it("redacts WorkOS response bodies from errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "provider-secret" }), { status: 500 }),
    );
    const vault = createWorkOSCredentialVault({ WORKOS_API_KEY: "workos-secret" } as Env);
    await expect(
      vault.create({
        context: { workspaceId: "workspace-1" },
        name: "connection:test",
        value: "provider-secret",
      }),
    ).rejects.toThrow("vault_request_failed");
  });
});
