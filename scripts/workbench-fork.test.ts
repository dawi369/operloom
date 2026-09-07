import { cpSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { configureForkIdentity, validateForkIdentity } from "./workbench-fork";

const fixture = (withMobile = true) => {
  const root = mkdtempSync(join(tmpdir(), "operloom-fork-"));
  for (const path of ["config/product.json", "package.json"]) {
    const destination = resolve(root, path);
    cpSync(resolve(process.cwd(), path), destination, { recursive: true });
  }
  if (withMobile) {
    mkdirSync(resolve(root, "apps/mobile"), { recursive: true });
    writeFileSync(resolve(root, "apps/mobile/app.json"), JSON.stringify({ expo: {} }));
  }
  return root;
};

describe("fork identity configurator", () => {
  it("configures and checks a web-only checkout", () => {
    const root = fixture(false);
    configureForkIdentity({
      root,
      mode: "init",
      values: { id: "my-system", displayName: "My System" },
    });
    expect(() => configureForkIdentity({ root, mode: "check" })).not.toThrow();
  });
  it("updates the public package and mobile identity without renaming SDK packages", () => {
    const root = fixture();
    configureForkIdentity({
      root,
      mode: "init",
      values: {
        id: "founder-workbench",
        displayName: "Founder Workbench",
        webOrigin: "https://agents.example.com/",
        mobileBundle: "com.example.founder",
      },
    });
    expect(() => configureForkIdentity({ root, mode: "check" })).not.toThrow();
    const mobile = JSON.parse(readFileSync(resolve(root, "apps/mobile/app.json"), "utf8"));
    const product = JSON.parse(readFileSync(resolve(root, "config/product.json"), "utf8"));
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(product.webTitle).toBe("Founder Workbench");
    expect(packageJson.name).toBe("founder-workbench");
    expect(packageJson.dependencies["@operloom/agent-sdk"]).toBe("workspace:*");
    expect(mobile.expo).toMatchObject({
      name: "Founder Workbench",
      slug: "founder-workbench",
      scheme: "founderworkbench",
      ios: {
        bundleIdentifier: "com.example.founder",
        associatedDomains: ["applinks:agents.example.com"],
      },
      android: { package: "com.example.founder" },
    });
  });

  it("fails closed on malformed ids, origins, and bundle identifiers", () => {
    const base = JSON.parse(readFileSync(resolve(process.cwd(), "config/product.json"), "utf8"));
    expect(() => validateForkIdentity({ ...base, id: "Invalid ID" })).toThrow("DNS-style");
    expect(() => validateForkIdentity({ ...base, webOrigin: "http://example.com" })).toThrow(
      "HTTPS",
    );
    expect(() =>
      validateForkIdentity({ ...base, mobile: { ...base.mobile, bundleIdentifier: "invalid" } }),
    ).toThrow("reverse-DNS");
  });
});
