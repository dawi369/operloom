import * as AuthSession from "expo-auth-session";

import { mobileAuthConfigured, mobileConfig } from "../config";
import {
  executeMobileSignIn,
  type MobileAuthFailure,
  type MobileAuthStage,
  type MobileSignInOutcome,
} from "./auth-flow";
import { launchSystemAuthorization } from "./system-authorization";

export type StoredMobileSession = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};

export const mobileAuthRedirectUri = AuthSession.makeRedirectUri({
  scheme: mobileConfig.authScheme,
  path: mobileConfig.authCallbackPath,
});

// WorkOS AuthKit exposes standard OIDC endpoints; the Worker verifies the resulting JWT.
const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: `${mobileConfig.workosIssuer}/oauth2/authorize`,
  tokenEndpoint: `${mobileConfig.workosIssuer}/oauth2/token`,
};

const fromTokenResponse = (
  response: AuthSession.TokenResponse,
  previousRefreshToken?: string,
): StoredMobileSession => ({
  accessToken: response.accessToken,
  refreshToken: response.refreshToken ?? previousRefreshToken,
  expiresAt:
    (response.issuedAt ?? Math.floor(Date.now() / 1000)) * 1000 +
    (response.expiresIn ?? 3_600) * 1000,
});

export async function signInWithWorkos(input: {
  persistSession(session: StoredMobileSession): Promise<void>;
  reportStage?(stage: MobileAuthStage): void;
  reportFailure?(failure: MobileAuthFailure): void;
}): Promise<MobileSignInOutcome<StoredMobileSession>> {
  return executeMobileSignIn<StoredMobileSession>({
    configured: mobileAuthConfigured,
    prepareAuthorization: async () => {
      const request = new AuthSession.AuthRequest({
        clientId: mobileConfig.workosClientId,
        redirectUri: mobileAuthRedirectUri,
        responseType: AuthSession.ResponseType.Code,
        scopes: ["openid", "profile", "email", "offline_access"],
        usePKCE: true,
      });
      const url = await request.makeAuthUrlAsync(discovery);
      if (!request.codeVerifier) throw new Error("PKCE verifier was not created");
      return {
        url,
        codeVerifier: request.codeVerifier,
        parseRedirect: (callbackUrl: string) => {
          const result = request.parseReturnUrl(callbackUrl);
          if (result.type !== "success") {
            return result.type === "dismiss" || result.type === "cancel"
              ? ({ type: "cancelled" } as const)
              : ({ type: "error" } as const);
          }
          return result.params.code
            ? ({ type: "success", code: result.params.code } as const)
            : ({ type: "error" } as const);
        },
      };
    },
    launchAuthorization: (url) =>
      launchSystemAuthorization({ authorizationUrl: url, redirectUri: mobileAuthRedirectUri }),
    exchangeCode: async ({ code, codeVerifier }) => {
      const response = await AuthSession.exchangeCodeAsync(
        {
          clientId: mobileConfig.workosClientId,
          code,
          redirectUri: mobileAuthRedirectUri,
          extraParams: { code_verifier: codeVerifier },
        },
        discovery,
      );
      return fromTokenResponse(response);
    },
    persistSession: input.persistSession,
    reportStage: input.reportStage,
    reportFailure: input.reportFailure,
  });
}

export async function refreshWorkosSession(refreshToken: string): Promise<StoredMobileSession> {
  const response = await AuthSession.refreshAsync(
    { clientId: mobileConfig.workosClientId, refreshToken },
    discovery,
  );
  return fromTokenResponse(response, refreshToken);
}
