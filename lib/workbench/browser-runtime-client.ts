import { createRuntimeClient } from "@operloom/client";

/**
 * The console's runtime client. Calls go to the same-origin `/api/v1/me` bridge, which attaches
 * the signed-in user's server-side token; the placeholder bearer value is never forwarded.
 */
export const createBrowserRuntimeClient = () =>
  createRuntimeClient({
    baseUrl: `${window.location.origin}/api`,
    target: "me",
    getAccessToken: async () => "session",
    fetch: (input, init) => globalThis.fetch(input, { ...init, credentials: "same-origin" }),
  });

export type BrowserRuntimeClient = ReturnType<typeof createBrowserRuntimeClient>;
