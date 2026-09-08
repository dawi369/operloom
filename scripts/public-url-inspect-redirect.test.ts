import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: network.request }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));

import { inspectPublicUrl } from "./public-url-inspect";

describe("signed runner redirect policy", () => {
  it("blocks an allowed host redirecting outside the signed host list", async () => {
    network.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    network.request.mockImplementation((_options, callback) => {
      const request = new EventEmitter();
      return Object.assign(request, {
        destroy: vi.fn(),
        end() {
          const response = Object.assign(new EventEmitter(), {
            statusCode: 302,
            statusMessage: "Found",
            headers: { location: "https://blocked.example/private" },
          });
          callback(response);
          response.emit("end");
        },
      });
    });
    const result = await inspectPublicUrl(new URL("https://allowed.example/start"), {
      egress: "public_web",
      allowedSchemes: ["https"],
      allowedHosts: ["allowed.example"],
      deniedHosts: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("sandbox_egress_not_allowed");
    expect(network.request).toHaveBeenCalledTimes(1);
    expect(network.lookup).toHaveBeenCalledTimes(1);
  });
});
