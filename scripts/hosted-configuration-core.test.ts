import { describe, expect, it } from "vitest";

import {
  hostedEnvironmentPolicy,
  parseCloudflareEnvironmentInventory,
  parseFlyEnvironmentInventory,
  parseRailwayEnvironmentInventory,
  parseVercelEnvironmentInventory,
  validateHostedConfiguration,
} from "./hosted-configuration-core";
import { loadWorkbenchEnvironment } from "./workbench-environment";

describe("hosted configuration inventory", () => {
  it("parses CLI metadata without requiring values for secrets", () => {
    expect(parseVercelEnvironmentInventory("WORKOS_API_KEY Encrypted Production now")).toEqual(
      new Map([["WORKOS_API_KEY", null]]),
    );
    expect(
      parseRailwayEnvironmentInventory('{"WORKBENCH_ENVIRONMENT":"demo","PORT":3000}'),
    ).toEqual(
      new Map([
        ["WORKBENCH_ENVIRONMENT", "demo"],
        ["PORT", null],
      ]),
    );
    expect(
      parseCloudflareEnvironmentInventory(
        JSON.stringify({
          resources: {
            bindings: [
              { name: "FLAG", type: "plain_text", text: "false" },
              { name: "SECRET", type: "secret_text" },
            ],
          },
        }),
      ),
    ).toEqual(
      new Map([
        ["FLAG", "false"],
        ["SECRET", null],
      ]),
    );
    expect(
      parseFlyEnvironmentInventory(
        "[env]\nFLAG = 'false'\n[http_service]\n",
        '[{"name":"SECRET"}]',
      ),
    ).toEqual(
      new Map([
        ["FLAG", "false"],
        ["SECRET", null],
      ]),
    );
  });

  it("detects forbidden production variables and drifted feature stages", () => {
    const manifest = loadWorkbenchEnvironment("production");
    const policy = hostedEnvironmentPolicy("production");
    const inventory = Object.fromEntries(
      (["web", "cloudflare", "fly"] as const).map((service) => [
        service,
        new Map(policy[service].required.map((name) => [name, null])),
      ]),
    ) as Record<"web" | "cloudflare" | "fly", Map<string, string | null>>;
    for (const [key, value] of [
      ["WORKBENCH_VAULT_BACKEND", "workos"],
      ["WORKBENCH_CONFORMANCE_MODE", "false"],
      ["WORKBENCH_RETAINED_DATA_ENABLED", "true"],
      ["WORKBENCH_CONNECTIONS_ENABLED", "true"],
      ["WORKBENCH_MUTATIONS_ENABLED", "false"],
      ["WORKBENCH_PUSH_ENABLED", "false"],
      ["WORKBENCH_RELEASE_SHA", "a".repeat(40)],
    ] as const)
      inventory.cloudflare.set(key, value);
    for (const [key, value] of [
      ["WORKBENCH_CONFORMANCE_MODE", "false"],
      ["WORKBENCH_RELEASE_SHA", "a".repeat(40)],
    ] as const)
      inventory.fly.set(key, value);
    for (const [key, value] of [
      ["WORKBENCH_ENVIRONMENT", "production"],
      ["WORKBENCH_OPERATOR_ALERT_CONFORMANCE_MODE", "false"],
      ["CLOUDFLARE_CONTROL_PLANE_URL", manifest.cloudflare.origin],
      ["LANGGRAPH_API_URL", manifest.fly.origin],
      ["NEXT_PUBLIC_WORKOS_REDIRECT_URI", `${manifest.web.origin}/auth/callback`],
    ] as const)
      inventory.web.set(key, value);
    expect(validateHostedConfiguration(manifest, inventory, "a".repeat(40))).toEqual([]);
    inventory.web.set("CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN", null);
    inventory.cloudflare.set("WORKBENCH_MUTATIONS_ENABLED", "true");
    expect(validateHostedConfiguration(manifest, inventory, "a".repeat(40))).toEqual(
      expect.arrayContaining([
        "web contains forbidden CLOUDFLARE_CONTROL_PLANE_DEV_TOKEN",
        "cloudflare WORKBENCH_MUTATIONS_ENABLED does not match the manifest policy",
      ]),
    );
  });
});
