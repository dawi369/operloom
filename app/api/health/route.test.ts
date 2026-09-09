import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

describe("public application health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports release identity without configuration or tenant data", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
    vi.stubEnv("LANGGRAPH_API_URL", "https://internal.example.test");
    vi.stubEnv("NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID", "private-assistant");

    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "operloom",
      version: "1.0.0",
      release: "a".repeat(40),
    });
  });
});
