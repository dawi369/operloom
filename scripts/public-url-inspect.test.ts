import { describe, expect, it } from "vitest";

import {
  inspectPublicUrl,
  isPublicInternetAddress,
  pinnedRequestOptions,
  validatePublicUrlPort,
} from "./public-url-inspect";

describe("public URL runner egress", () => {
  it.each([
    { egress: "none" as const },
    { egress: "broker_only" as const },
    { egress: "public_web" as const, allowedHosts: ["allowed.example"] },
    { egress: "public_web" as const, deniedHosts: ["example.com"] },
    { egress: "public_web" as const, allowedSchemes: ["http"] },
  ])("enforces signed network policy before fetching: %j", async (policy) => {
    const result = await inspectPublicUrl(new URL("https://example.com"), policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("sandbox_egress_not_allowed");
  });
  it("rejects private, metadata, documentation, multicast, and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicInternetAddress(address), address).toBe(false);
    }
    expect(isPublicInternetAddress("1.1.1.1")).toBe(true);
    expect(isPublicInternetAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("allows only standard HTTP and HTTPS ports", () => {
    expect(validatePublicUrlPort(new URL("https://example.com/path"))).toBe(true);
    expect(validatePublicUrlPort(new URL("http://example.com:80/path"))).toBe(true);
    expect(validatePublicUrlPort(new URL("https://example.com:444/path"))).toBe(false);
  });

  it("pins the resolved address while preserving Host and TLS SNI", () => {
    const options = pinnedRequestOptions(
      new URL("https://example.com/docs?q=1"),
      "93.184.216.34",
      4,
    );
    expect(options).toMatchObject({
      hostname: "93.184.216.34",
      servername: "example.com",
      path: "/docs?q=1",
      headers: expect.objectContaining({ host: "example.com" }),
    });
  });
});
