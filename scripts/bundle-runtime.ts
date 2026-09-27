import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import ts from "typescript";
import { startManagedProcess } from "./managed-process";

const main = async () => {
  const root = process.cwd();
  const configFlag = process.argv.indexOf("--config");
  const source = resolve(
    root,
    configFlag < 0 ? "cloudflare/control-plane/wrangler.jsonc" : process.argv[configFlag + 1]!,
  );
  const parsed = ts.parseConfigFileTextToJson(source, readFileSync(source, "utf8"));
  if (parsed.error) throw new Error("Invalid Worker JSON configuration");
  const config = parsed.config as Record<string, unknown>;
  if (config.env || config.assets || config.build)
    throw new Error(
      "Bundle a rendered standalone Worker configuration without env, assets or custom build directives",
    );
  mkdirSync(resolve(root, "output/runtime-distribution"), { recursive: true });
  const output = mkdtempSync(resolve(root, "output/runtime-distribution/bundle-"));
  const worker = resolve(output, "worker");
  const metafile = resolve(output, "bundle-meta.json");
  const build = startManagedProcess(
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--config",
      source,
      "--outdir",
      worker,
      "--metafile",
      metafile,
    ],
    {
      label: "runtime-distribution-build",
      cwd: root,
      stdio: "pipe",
      maxRssMb: 1536,
    },
  );
  const result = await build.completion;
  if (result.code !== 0 || result.reason)
    throw new Error("Standalone Worker bundling failed; no deployment was attempted");
  const metadata = JSON.parse(readFileSync(metafile, "utf8")) as {
    inputs: Record<string, unknown>;
    outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
  };
  const externalPackages = Object.values(metadata.outputs)
    .flatMap((output) => output.imports ?? [])
    .filter(
      (entry) =>
        entry.external &&
        !entry.path.startsWith("node:") &&
        !entry.path.startsWith("cloudflare:") &&
        !entry.path.startsWith(".") &&
        !builtinModules.includes(entry.path),
    );
  if (externalPackages.length)
    throw new Error(
      `Worker retains external package imports: ${externalPackages.map((entry) => entry.path).join(", ")}`,
    );
  const frontend = Object.keys(metadata.inputs).filter((path) =>
    /node_modules\/(?:next|react|react-dom)\/|node_modules\/@assistant-ui\/|node_modules\/@workos-inc\/authkit-nextjs\//.test(
      path.replaceAll("\\", "/"),
    ),
  );
  if (frontend.length) throw new Error(`Worker imports frontend packages: ${frontend.join(", ")}`);
  const standalone: Record<string, unknown> = {
    ...config,
    main: "./worker/index.js",
    no_bundle: true,
    find_additional_modules: true,
  };
  delete standalone.$schema;
  delete standalone.tsconfig;
  const databases = (config.d1_databases ?? []) as { binding: string; migrations_dir?: string }[];
  standalone.d1_databases = databases.map((database) => {
    const destination = `migrations/${database.binding}`;
    const original = resolve(dirname(source), database.migrations_dir ?? "migrations");
    mkdirSync(resolve(output, destination), { recursive: true });
    for (const file of readdirSync(original).filter((name) => name.endsWith(".sql")))
      cpSync(resolve(original, file), resolve(output, destination, file));
    return { ...database, migrations_dir: destination };
  });
  writeFileSync(resolve(output, "wrangler.json"), JSON.stringify(standalone, null, 2) + "\n");
  const wranglerVersion = (
    JSON.parse(readFileSync(resolve(root, "node_modules/wrangler/package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  writeFileSync(
    resolve(output, "package.json"),
    JSON.stringify(
      {
        name: "operloom-runtime-deployment",
        private: true,
        type: "module",
        scripts: {
          dev: "wrangler dev --local",
          deploy: "node deploy-durable-runtime.mjs --remote",
        },
        devDependencies: { wrangler: wranglerVersion },
        packageManager: "pnpm@10.33.0",
      },
      null,
      2,
    ) + "\n",
  );
  for (const name of ["managed-process", "durable-deployment-gate", "deploy-durable-runtime"]) {
    const source = readFileSync(resolve(root, "scripts", `${name}.ts`), "utf8");
    const javascript = ts
      .transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      })
      .outputText.replaceAll('"./managed-process"', '"./managed-process.mjs"')
      .replaceAll('"./durable-deployment-gate"', '"./durable-deployment-gate.mjs"');
    writeFileSync(resolve(output, `${name}.mjs`), javascript);
  }
  const bundleSha256 = createHash("sha256")
    .update(readFileSync(resolve(worker, "index.js")))
    .digest("hex");
  writeFileSync(
    resolve(output, "runtime-manifest.json"),
    JSON.stringify(
      {
        sourceConfiguration: relative(root, source),
        bundleSha256,
        frontendDependencies: [],
        inputs: Object.keys(metadata.inputs).length,
        hostedVerified: false,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    resolve(output, "README.md"),
    `# Operloom standalone Worker\n\nThis artifact contains the bundled backend, forward D1 migrations and independent\nWrangler configuration. It needs no Next.js, React, source checkout or web host.\nResource names and IDs are copied unchanged from the source configuration.\nSecret files such as .dev.vars are not copied. No deployment has been performed.\n\nInstall Wrangler with pnpm install --ignore-workspace. Review bindings and variables, configure\nWorkOS verification and server secrets, and apply forward D1 migrations before\ndeploying with pnpm run deploy -- --origin https://<worker-origin>. Apply migration 0030 first.\nThe guarded deploy checks active handler pins and keeps an admission fence after uncertain\nuploads; retain this artifact for --resume or verified --release. Keep new capability flags off until hosted acceptance.\nFor an existing deployment, retain signing keys, resource IDs and migration history.\nFollow docs/headless-runtime.md in the source project for the acceptance runbook.\n`,
  );
  writeFileSync(
    resolve(root, "output/runtime-distribution/latest.json"),
    JSON.stringify(
      { directory: output, config: resolve(output, "wrangler.json"), bundleSha256 },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Standalone runtime bundle verified: ${relative(root, output)} (${Object.keys(metadata.inputs).length} inputs, no frontend packages). No deployment performed.`,
  );
};
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
