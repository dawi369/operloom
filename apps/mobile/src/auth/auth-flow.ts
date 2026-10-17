export type MobileAuthStage =
  | "configuration"
  | "authorization_request"
  | "browser"
  | "authorization_response"
  | "token_exchange"
  | "session_persistence";

export type MobileAuthFailureCode =
  | "not_configured"
  | "request_failed"
  | "browser_failed"
  | "authorization_failed"
  | "token_exchange_failed"
  | "refresh_failed"
  | "session_persistence_failed";

export type MobileAuthFailure = {
  stage: MobileAuthStage;
  code: MobileAuthFailureCode;
  message: string;
  retryable: boolean;
};

export type PreparedMobileAuthorization = {
  url: string;
  codeVerifier: string;
  parseRedirect(
    url: string,
  ): { type: "success"; code: string } | { type: "cancelled" } | { type: "error" };
};

export type MobileSignInOutcome<TSession> =
  | { type: "signed-in"; session: TSession }
  | { type: "cancelled" }
  | { type: "failed"; failure: MobileAuthFailure };

type MobileSignInDependencies<TSession> = {
  configured: boolean;
  prepareAuthorization(): Promise<PreparedMobileAuthorization>;
  launchAuthorization(url: string): Promise<string | null>;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<TSession>;
  persistSession(session: TSession): Promise<void>;
  reportStage?(stage: MobileAuthStage): void;
  reportFailure?(failure: MobileAuthFailure): void;
};

export function createSingleFlight<T>() {
  let current: Promise<T> | null = null;
  return {
    run(operation: () => Promise<T>) {
      if (!current) {
        current = operation().finally(() => {
          current = null;
        });
      }
      return current;
    },
  };
}

const failureFor = (stage: MobileAuthStage, code: MobileAuthFailureCode): MobileAuthFailure => {
  const messages: Record<MobileAuthFailureCode, string> = {
    not_configured: "Mobile sign-in is not configured.",
    request_failed: "Sign-in could not be started. Please try again.",
    browser_failed: "The sign-in page could not be opened. Please try again.",
    authorization_failed: "Sign-in was not completed. Please try again.",
    token_exchange_failed: "Your sign-in could not be completed. Please try again.",
    refresh_failed: "Your session expired. Please sign in again.",
    session_persistence_failed: "Your session could not be saved securely. Please try again.",
  };
  return { stage, code, message: messages[code], retryable: code !== "not_configured" };
};

export async function executeMobileSignIn<TSession>(
  dependencies: MobileSignInDependencies<TSession>,
): Promise<MobileSignInOutcome<TSession>> {
  const fail = (stage: MobileAuthStage, code: MobileAuthFailureCode) => {
    const failure = failureFor(stage, code);
    dependencies.reportFailure?.(failure);
    return { type: "failed", failure } as const;
  };

  dependencies.reportStage?.("configuration");
  if (!dependencies.configured) return fail("configuration", "not_configured");

  let authorization: PreparedMobileAuthorization;
  try {
    dependencies.reportStage?.("authorization_request");
    authorization = await dependencies.prepareAuthorization();
  } catch {
    return fail("authorization_request", "request_failed");
  }

  let redirectUrl: string | null;
  try {
    dependencies.reportStage?.("browser");
    redirectUrl = await dependencies.launchAuthorization(authorization.url);
  } catch {
    return fail("browser", "browser_failed");
  }
  if (!redirectUrl) return { type: "cancelled" };

  let response: ReturnType<PreparedMobileAuthorization["parseRedirect"]>;
  try {
    dependencies.reportStage?.("authorization_response");
    response = authorization.parseRedirect(redirectUrl);
  } catch {
    return fail("authorization_response", "authorization_failed");
  }
  if (response.type === "cancelled") return { type: "cancelled" };
  if (response.type !== "success") {
    return fail("authorization_response", "authorization_failed");
  }

  let session: TSession;
  try {
    dependencies.reportStage?.("token_exchange");
    session = await dependencies.exchangeCode({
      code: response.code,
      codeVerifier: authorization.codeVerifier,
    });
  } catch {
    return fail("token_exchange", "token_exchange_failed");
  }

  try {
    dependencies.reportStage?.("session_persistence");
    await dependencies.persistSession(session);
  } catch {
    return fail("session_persistence", "session_persistence_failed");
  }
  return { type: "signed-in", session };
}
