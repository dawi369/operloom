export function mobileAuthorizationCallbackMatches(candidate: string, redirectUri: string) {
  try {
    const callback = new URL(candidate);
    const expected = new URL(redirectUri);
    return (
      callback.protocol === expected.protocol &&
      callback.hostname === expected.hostname &&
      callback.port === expected.port &&
      callback.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}
