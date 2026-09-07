import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

type ContractManifest = {
  schemaVersion: 1;
  sdkVersion: string;
  files: Array<{ path: string; sha256: string }>;
};

const root = process.cwd();
const packageRoot = resolve(root, "packages/agent-sdk");
const manifestPath = resolve(packageRoot, "contract-manifest.json");
const normalize = (value: string) => value.replaceAll("\r\n", "\n").trimEnd() + "\n";
const hash = (value: string) => createHash("sha256").update(normalize(value)).digest("hex");

const packageMetadata = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
  version?: unknown;
};
if (typeof packageMetadata.version !== "string") {
  throw new Error("Agent SDK package version is missing.");
}

const declarations = readdirSync(resolve(packageRoot, "dist"))
  .filter((file) => file.endsWith(".d.ts"))
  .map((file) => resolve(packageRoot, "dist", file));
const schemas = [
  resolve(packageRoot, "schemas/agent-pack-v2.schema.json"),
  resolve(packageRoot, "schemas/runtime-module-v1.schema.json"),
];
const files = [...declarations, ...schemas]
  .map((file) => ({
    path: relative(packageRoot, file).split("\\").join("/"),
    sha256: hash(readFileSync(file, "utf8")),
  }))
  .sort((left, right) => left.path.localeCompare(right.path));
const current: ContractManifest = {
  schemaVersion: 1,
  sdkVersion: packageMetadata.version,
  files,
};
const serialized = `${JSON.stringify(current, null, 2)}\n`;

if (process.argv.includes("--accept")) {
  writeFileSync(manifestPath, serialized);
  console.log(`Agent SDK contract accepted: ${relative(root, manifestPath)}`);
  process.exit(0);
}

if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== serialized) {
  throw new Error(
    "Agent SDK public contract changed. Review compatibility, add a changelog entry, then run pnpm agent-sdk:contract --accept.",
  );
}
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
if (
  !changelog.includes(`@operloom/agent-sdk`) ||
  !changelog.includes(`SDK ${current.sdkVersion}`)
) {
  throw new Error(
    `CHANGELOG.md must record the @operloom/agent-sdk SDK ${current.sdkVersion} contract.`,
  );
}
console.log(`Agent SDK contract verified: ${files.length} normalized public files.`);
