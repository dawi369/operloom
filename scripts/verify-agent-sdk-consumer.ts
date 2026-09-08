import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { compileAgentPacks } from "./agent-pack-compiler";

const run = (command: string, args: string[], cwd: string) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  return result.stdout;
};

const findArchive = (directory: string, prefix: string) => {
  const archive = readdirSync(directory).find(
    (file) => file.startsWith(prefix) && file.endsWith(".tgz"),
  );
  if (!archive) throw new Error(`Package archive ${prefix} was not produced.`);
  return resolve(directory, archive);
};

const main = async () => {
  const root = process.cwd();
  const output = resolve(root, "output/sdk-consumer");
  const consumer = resolve(output, "consumer");
  rmSync(output, { recursive: true, force: true });
  mkdirSync(consumer, { recursive: true });

  run("pnpm", ["pack", "--pack-destination", output], resolve(root, "packages/agent-sdk"));
  run(
    "pnpm",
    ["pack", "--pack-destination", output],
    resolve(root, "tests/fixtures/external-agent-package"),
  );
  const sdkArchive = findArchive(output, "operloom-agent-sdk-");
  const packArchive = findArchive(output, "operloom-external-agent-fixture-");
  const sdkArchiveEntries = run("tar", ["-tzf", sdkArchive], root).split("\n").filter(Boolean);
  for (const required of [
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/manifest.js",
    "package/dist/manifest.d.ts",
    "package/dist/control-plane.js",
    "package/dist/control-plane.d.ts",
    "package/dist/runner.js",
    "package/dist/runner.d.ts",
    "package/dist/web.js",
    "package/dist/web.d.ts",
    "package/schemas/agent-pack-v2.schema.json",
    "package/schemas/runtime-module-v1.schema.json",
    "package/README.md",
  ]) {
    if (!sdkArchiveEntries.includes(required)) {
      throw new Error(`Agent SDK archive is missing ${required}.`);
    }
  }
  if (sdkArchiveEntries.some((entry) => entry.startsWith("package/src/"))) {
    throw new Error("Agent SDK archive must execute from dist without published source files.");
  }

  writeFileSync(
    resolve(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "agent-sdk-zero-context-consumer",
        private: true,
        type: "module",
        dependencies: {
          "@operloom/agent-sdk": `file:${relative(consumer, sdkArchive)}`,
          "@operloom/external-agent-fixture": `file:${relative(consumer, packArchive)}`,
        },
        pnpm: {
          overrides: {
            "@operloom/agent-sdk": `file:${relative(consumer, sdkArchive)}`,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  run("pnpm", ["install", "--ignore-workspace", "--offline"], consumer);

  writeFileSync(
    resolve(consumer, "consumer.mjs"),
    `import { defineWorkbenchConfig } from "@operloom/agent-sdk";
import { defineAgentPack } from "@operloom/agent-sdk/manifest";
import { defineControlPlaneModule } from "@operloom/agent-sdk/control-plane";
import { defineRunnerModule } from "@operloom/agent-sdk/runner";
import { defineWebModule } from "@operloom/agent-sdk/web";

for (const value of [defineWorkbenchConfig, defineAgentPack, defineControlPlaneModule, defineRunnerModule, defineWebModule]) {
  if (typeof value !== "function") throw new Error("SDK runtime export is not executable");
}
`,
  );
  run("node", [resolve(consumer, "consumer.mjs")], consumer);

  writeFileSync(
    resolve(consumer, "consumer.ts"),
    `import { defineWorkbenchConfig } from "@operloom/agent-sdk";
import { defineAgentPack } from "@operloom/agent-sdk/manifest";
import { defineControlPlaneModule } from "@operloom/agent-sdk/control-plane";
import { defineRunnerModule } from "@operloom/agent-sdk/runner";
import { defineWebModule } from "@operloom/agent-sdk/web";
void [defineWorkbenchConfig, defineAgentPack, defineControlPlaneModule, defineRunnerModule, defineWebModule];
`,
  );
  writeFileSync(
    resolve(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          types: [],
          skipLibCheck: false,
        },
        include: ["consumer.ts", "workbench.config.ts", "generated/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    resolve(consumer, "workbench.config.ts"),
    `import { defineWorkbenchConfig } from "@operloom/agent-sdk";

export default defineWorkbenchConfig({
  runtimeApiVersion: 1,
  workbenchVersion: "0.5.0",
  modules: [{ package: "@operloom/external-agent-fixture" }],
});
`,
  );
  run("pnpm", ["exec", "tsc", "-p", resolve(consumer, "tsconfig.json")], root);

  const compiled = await compileAgentPacks(consumer, { check: false });
  if (compiled.modules.length !== 1 || compiled.modules[0]?.entry.source) {
    throw new Error("External package did not compile through the package-only registry path.");
  }
  const generatedManifest = readFileSync(
    resolve(consumer, "generated/agent-runtime/manifests.ts"),
    "utf8",
  );
  if (
    !generatedManifest.includes("@operloom/external-agent-fixture/manifest") ||
    generatedManifest.includes("tests/fixtures")
  ) {
    throw new Error("Generated registry did not preserve the external package boundary.");
  }
  run("pnpm", ["exec", "tsc", "-p", resolve(consumer, "tsconfig.json")], root);

  console.log(
    `Agent SDK archive, runtime imports, declarations, and package-only compiler verified: ${relative(root, sdkArchive)}`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
