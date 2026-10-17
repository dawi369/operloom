import * as WebBrowser from "expo-web-browser";

/**
 * Presents the authorization page as an in-app auth sheet (ASWebAuthenticationSession on
 * iOS, Custom Tabs on Android). It shares the system browser's cookies, so a returning user
 * is one tap, and dismisses itself when the redirect URI is reached.
 */
export async function launchSystemAuthorization(input: {
  authorizationUrl: string;
  redirectUri: string;
}): Promise<string | null> {
  const result = await WebBrowser.openAuthSessionAsync(input.authorizationUrl, input.redirectUri, {
    preferEphemeralSession: false,
  });
  return result.type === "success" ? result.url : null;
}
