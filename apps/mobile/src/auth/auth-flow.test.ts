import { describe, expect, it, vi } from "vitest";

import {
  createSingleFlight,
  executeMobileSignIn,
  type PreparedMobileAuthorization,
} from "./auth-flow";
import { mobileAuthorizationCallbackMatches } from "./auth-redirect";

const prepared = (type: "success" | "cancelled" | "error" = "success") =>
  ({
    url: "https://auth.example/authorize?redacted=true",
    codeVerifier: "verifier-that-must-not-enter-errors",
    parseRedirect: () => (type === "success" ? { type, code: "authorization-code" } : { type }),
  }) satisfies PreparedMobileAuthorization;

const dependencies = () => ({
  configured: true,
  prepareAuthorization: vi.fn(async () => prepared()),
  launchAuthorization: vi.fn(async () => "assistantmk1://auth/callback?code=secret"),
  exchangeCode: vi.fn(async () => ({ accessToken: "secret", expiresAt: 1 })),
  persistSession: vi.fn(async () => undefined),
  reportFailure: vi.fn(),
  reportStage: vi.fn(),
});

describe("mobile authentication flow", () => {
  it("persists a successful PKCE exchange", async () => {
    const input = dependencies();
    const result = await executeMobileSignIn(input);
    expect(result.type).toBe("signed-in");
    expect(input.exchangeCode).toHaveBeenCalledWith({
      code: "authorization-code",
      codeVerifier: "verifier-that-must-not-enter-errors",
    });
    expect(input.persistSession).toHaveBeenCalledOnce();
    expect(input.reportStage.mock.calls.flat()).toEqual([
      "configuration",
      "authorization_request",
      "browser",
      "authorization_response",
      "token_exchange",
      "session_persistence",
    ]);
  });

  it.each([
    [
      "request_failed",
      (input: ReturnType<typeof dependencies>) =>
        input.prepareAuthorization.mockRejectedValue(new Error("request secret")),
    ],
    [
      "browser_failed",
      (input: ReturnType<typeof dependencies>) =>
        input.launchAuthorization.mockRejectedValue(new Error("browser secret")),
    ],
    [
      "token_exchange_failed",
      (input: ReturnType<typeof dependencies>) =>
        input.exchangeCode.mockRejectedValue(new Error("token secret")),
    ],
    [
      "session_persistence_failed",
      (input: ReturnType<typeof dependencies>) =>
        input.persistSession.mockRejectedValue(new Error("storage secret")),
    ],
  ])("returns a sanitized %s failure", async (code, arrange) => {
    const input = dependencies();
    arrange(input);
    const result = await executeMobileSignIn(input);
    expect(result).toMatchObject({ type: "failed", failure: { code } });
    expect(JSON.stringify(result)).not.toMatch(
      /request secret|browser secret|token secret|storage secret/,
    );
    expect(input.reportFailure).toHaveBeenCalledWith(expect.objectContaining({ code }));
  });

  it("treats browser cancellation as a normal outcome", async () => {
    const input = dependencies();
    input.launchAuthorization.mockResolvedValue(null);
    await expect(executeMobileSignIn(input)).resolves.toEqual({ type: "cancelled" });
    expect(input.reportFailure).not.toHaveBeenCalled();
  });

  it("rejects an authorization response without exchanging credentials", async () => {
    const input = dependencies();
    input.prepareAuthorization.mockResolvedValue(prepared("error"));
    await expect(executeMobileSignIn(input)).resolves.toMatchObject({
      type: "failed",
      failure: { code: "authorization_failed" },
    });
    expect(input.exchangeCode).not.toHaveBeenCalled();
  });

  it("coalesces repeated sign-in taps into one operation", async () => {
    const flight = createSingleFlight<string>();
    let complete: ((value: string) => void) | undefined;
    const operation = vi.fn(() => new Promise<string>((resolve) => (complete = resolve)));
    const first = flight.run(operation);
    const second = flight.run(operation);
    expect(first).toBe(second);
    expect(operation).toHaveBeenCalledOnce();
    complete?.("done");
    await expect(first).resolves.toBe("done");
  });

  it("accepts only the registered callback boundary", () => {
    const redirect = "assistantmk1://auth/callback";
    expect(
      mobileAuthorizationCallbackMatches(
        "assistantmk1://auth/callback?code=secret&state=opaque",
        redirect,
      ),
    ).toBe(true);
    expect(mobileAuthorizationCallbackMatches("assistantmk1://attacker/callback", redirect)).toBe(
      false,
    );
    expect(mobileAuthorizationCallbackMatches("https://auth/callback", redirect)).toBe(false);
    expect(mobileAuthorizationCallbackMatches("not-a-url", redirect)).toBe(false);
  });
});
