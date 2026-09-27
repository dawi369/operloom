import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { loadAccessTokenConfig, verifyWorkbenchAccessToken } from "./access-token";

const config = loadAccessTokenConfig({
  NODE_ENV: "production",
  WORKBENCH_WORKOS_ISSUER: "https://api.workos.com/user_management/client_test",
  WORKBENCH_WORKOS_JWKS_URL: "https://api.workos.com/sso/jwks/client_test",
  WORKBENCH_WORKOS_ALLOWED_CLIENT_IDS: "client_test",
});
describe("shared backend token verification", () => {
  it("preserves the exact issuer, including its path", () => {
    expect(config.issuer).toBe("https://api.workos.com/user_management/client_test");
  });
  it("rejects wrong issuers, expired tokens and unauthorized clients even with valid signatures", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    for (const claims of [
      {
        iss: "https://api.workos.com",
        exp: Math.floor(Date.now() / 1000) + 300,
        client_id: "client_test",
      },
      { iss: config.issuer, exp: 1, client_id: "client_test" },
      {
        iss: config.issuer,
        exp: Math.floor(Date.now() / 1000) + 300,
        client_id: "other",
        aud: "client_test",
      },
    ]) {
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256" })
        .setSubject("user_test")
        .setIssuedAt()
        .sign(privateKey);
      await expect(verifyWorkbenchAccessToken(token, config, publicKey)).rejects.toMatchObject({
        status: 401,
      });
    }
  });
  it("rejects a token signed by another key and derives reauthentication only from signed auth_time", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const other = await generateKeyPair("RS256");
    const authTime = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ client_id: "client_test", auth_time: authTime })
      .setIssuer(config.issuer)
      .setSubject("user_test")
      .setIssuedAt()
      .setExpirationTime("5m")
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);
    await expect(verifyWorkbenchAccessToken(token, config, other.publicKey)).rejects.toMatchObject({
      status: 401,
    });
    await expect(verifyWorkbenchAccessToken(token, config, publicKey)).resolves.toMatchObject({
      scope: { userId: "user_test" },
      verifiedAuthenticationTime: authTime * 1000,
    });
  });
});
