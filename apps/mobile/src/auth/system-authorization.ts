import { AppState, Linking, type AppStateStatus } from "react-native";

import { mobileAuthorizationCallbackMatches } from "./auth-redirect";

export async function launchSystemAuthorization(input: {
  authorizationUrl: string;
  redirectUri: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const timeoutMs = input.timeoutMs ?? 5 * 60_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let leftApplication = false;
    let returnTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let linkSubscription: { remove(): void } | undefined;
    let stateSubscription: { remove(): void } | undefined;

    const finish = (result: string | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (returnTimer) clearTimeout(returnTimer);
      linkSubscription?.remove();
      stateSubscription?.remove();
      if (error) reject(error);
      else resolve(result);
    };

    linkSubscription = Linking.addEventListener("url", ({ url }) => {
      if (mobileAuthorizationCallbackMatches(url, input.redirectUri)) finish(url);
    });
    stateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (nextState === "inactive" || nextState === "background") {
        leftApplication = true;
        if (returnTimer) clearTimeout(returnTimer);
        return;
      }
      if (nextState === "active" && leftApplication) {
        // Deep-link delivery and foreground notification can arrive in either order.
        returnTimer = setTimeout(() => finish(null), 1_500);
      }
    });
    timeoutTimer = setTimeout(() => finish(null), timeoutMs);

    void Linking.openURL(input.authorizationUrl).catch((error: unknown) => finish(null, error));
  });
}
