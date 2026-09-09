import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalFacadeRequest,
  facadeContentSha256Header,
  facadeSignatureHeader,
  facadeSignatureNonceHeader,
  facadeSignatureTimestampHeader,
  hmacSha256Base64Url,
} from "../../../../lib/workbench/control-plane-signing";
import { GET } from "./route";
import { GET as getHealth } from "../route";

describe("signed facade health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(["git", "cli"])(
    "proves the deployed signing contract for a %s deployment",
    async (source) => {
      const release = "a".repeat(40);
      const secret = "facade-health-secret-that-is-long-enough";
      vi.stubEnv("CLOUDFLARE_CONTROL_PLANE_URL", "https://worker.example.test");
      vi.stubEnv("CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET", secret);
      vi.stubEnv("VERCEL_GIT_COMMIT_SHA", source === "git" ? release : "");
      vi.stubEnv("WORKBENCH_RELEASE_SHA", source === "cli" ? release : "");
      expect((await getHealth().json()).release).toBe(release);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          expect(String(input)).toBe("https://worker.example.test/health/facade");
          const headers = new Headers(init?.headers);
          const timestamp = headers.get(facadeSignatureTimestampHeader) ?? "";
          const nonce = headers.get(facadeSignatureNonceHeader) ?? "";
          const bodyHash = headers.get(facadeContentSha256Header) ?? "";
          const canonical = canonicalFacadeRequest({
            method: "GET",
            pathWithQuery: "/health/facade",
            timestamp,
            nonce,
            bodyHash,
            headers,
          });
          expect(headers.get(facadeSignatureHeader)).toBe(
            await hmacSha256Base64Url(secret, canonical),
          );
          return Response.json({
            ok: true,
            service: "operloom-control-plane-facade",
            version: "1.0.0",
            release,
          });
        }),
      );

      const response = await GET();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        service: "operloom-facade",
        version: "1.0.0",
        release,
      });
    },
  );

  it("fails closed without exposing signing or upstream details", async () => {
    vi.stubEnv("CLOUDFLARE_CONTROL_PLANE_URL", "https://worker.example.test");
    vi.stubEnv("CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, service: "operloom-facade" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts a rejected signature response", async () => {
    vi.stubEnv("CLOUDFLARE_CONTROL_PLANE_URL", "https://worker.example.test");
    vi.stubEnv(
      "CLOUDFLARE_CONTROL_PLANE_FACADE_SIGNING_SECRET",
      "facade-health-secret-that-is-long-enough",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            ok: false,
            error: "Signed facade request is invalid.",
            details: { code: "signature_invalid" },
          },
          { status: 401 },
        ),
      ),
    );

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, service: "operloom-facade" });
  });
});
