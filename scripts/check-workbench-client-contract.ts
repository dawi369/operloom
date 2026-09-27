import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

type ContractManifest = {
  schemaVersion: 2;
  runtimeSchemas: Array<{ path: string; sha256: string }>;
  packages: Array<{
    name: string;
    version: string;
    files: Array<{ path: string; sha256: string }>;
  }>;
};

const root = process.cwd();
const clientRoot = resolve(root, "packages/workbench-client");
const manifestPath = resolve(clientRoot, "contract-manifest.json");
const normalize = (value: string) => value.replaceAll("\r\n", "\n").trimEnd() + "\n";
const hash = (value: string) => createHash("sha256").update(normalize(value)).digest("hex");

const declarationFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? declarationFiles(path)
      : path.endsWith(".d.ts")
        ? [path]
        : [];
  });

const packages = ["workbench-client", "workbench-react"].map((directory) => {
  const packageRoot = resolve(root, "packages", directory);
  const metadata = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (typeof metadata.name !== "string" || typeof metadata.version !== "string") {
    throw new Error(`${directory} package metadata is incomplete.`);
  }
  return {
    name: metadata.name,
    version: metadata.version,
    files: declarationFiles(resolve(packageRoot, "dist"))
      .map((file) => ({
        path: `${directory}/${relative(packageRoot, file).split("\\").join("/")}`,
        sha256: hash(readFileSync(file, "utf8")),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
});

const runtimeSchemas = [
  "src/response-schemas.ts",
  "src/validation.ts",
  "src/public-chat-contracts.ts",
  "src/public-context-contracts.ts",
  "src/public-budget-contracts.ts",
  "src/public-state-contracts.ts",
  "src/public-upgrade-contracts.ts",
  "src/messages.ts",
  "src/public-action-contracts.ts",
].map((path) => ({
  path: `workbench-client/${path}`,
  sha256: hash(readFileSync(resolve(clientRoot, path), "utf8")),
}));
const current: ContractManifest = { schemaVersion: 2, runtimeSchemas, packages };
const serialized = `${JSON.stringify(current, null, 2)}\n`;
if (process.argv.includes("--accept")) {
  writeFileSync(manifestPath, serialized);
  console.log(`Workbench client contract accepted: ${relative(root, manifestPath)}`);
  process.exit(0);
}
if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== serialized) {
  throw new Error(
    "Workbench client public contract changed. Review compatibility, then run pnpm workbench-client:contract --accept.",
  );
}
console.log(
  `Workbench client contract verified: ${packages.reduce((count, item) => count + item.files.length, 0)} declaration files.`,
);
