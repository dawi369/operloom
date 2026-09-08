import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const defaultOutput = resolve(repositoryRoot, "output/workbench-client-distribution");

type PackageManifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};

type DistributionPackage = {
  name: string;
  version: string;
  archive: string;
  bytes: number;
  sha256: string;
};

export type WorkbenchClientDistributionManifest = {
  schemaVersion: 1;
  applicationVersion: string;
  sourceCommit: string;
  contractSha256: string;
  packages: DistributionPackage[];
};

const run = (command: string, args: string[], cwd = repositoryRoot) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
};

const sha256 = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");

export const validatePackageArchive = (input: {
  entries: string[];
  manifestText: string;
  executableText: string;
}) => {
  const { entries, manifestText, executableText } = input;
  const required = ["package/dist/index.js", "package/dist/index.d.ts", "package/README.md"];
  for (const entry of required) {
    if (!entries.includes(entry)) throw new Error(`Package archive is missing ${entry}.`);
  }
  const forbiddenEntry = entries.find(
    (entry) =>
      entry.startsWith("package/src/") ||
      entry.includes("node_modules") ||
      entry.includes(".env") ||
      entry.includes(".assistant-mk1"),
  );
  if (forbiddenEntry) throw new Error(`Package archive contains forbidden path ${forbiddenEntry}.`);
  if (manifestText.includes("workspace:")) {
    throw new Error("Package archive contains an unresolved workspace dependency.");
  }
  const forbiddenImport = [
    /(?:from|import\()\s*["']\.\.\/\.\.\//,
    /(?:from|import\()\s*["']@\//,
    /(?:from|import\()\s*["'](?:apps|cloudflare|packages)\//,
    /\/Users\//,
  ].find((pattern) => pattern.test(executableText));
  if (forbiddenImport) {
    throw new Error(`Package archive contains a repository-relative import (${forbiddenImport}).`);
  }
};

const archiveFor = (output: string, prefix: string) => {
  const archive = readdirSync(output).find(
    (entry) => entry.startsWith(prefix) && entry.endsWith(".tgz"),
  );
  if (!archive) throw new Error(`Missing packed archive for ${prefix}.`);
  return resolve(output, archive);
};

const inspectArchive = (archive: string): DistributionPackage => {
  const entries = run("tar", ["-tzf", archive]).split("\n").filter(Boolean);
  const manifestText = run("tar", ["-xOf", archive, "package/package.json"]);
  const executableEntries = entries.filter(
    (entry) => entry.startsWith("package/dist/") && /\.(?:js|d\.ts)$/.test(entry),
  );
  const executableText = executableEntries
    .map((entry) => run("tar", ["-xOf", archive, entry]))
    .join("\n");
  validatePackageArchive({ entries, manifestText, executableText });
  const manifest = JSON.parse(manifestText) as PackageManifest;
  const contents = readFileSync(archive);
  return {
    name: manifest.name,
    version: manifest.version,
    archive: basename(archive),
    bytes: statSync(archive).size,
    sha256: sha256(contents),
  };
};

export const buildDistributionManifest = (input: {
  applicationVersion: string;
  sourceCommit: string;
  contractText: string;
  packages: DistributionPackage[];
}): WorkbenchClientDistributionManifest => ({
  schemaVersion: 1,
  applicationVersion: input.applicationVersion,
  sourceCommit: input.sourceCommit,
  contractSha256: sha256(input.contractText),
  packages: [...input.packages].sort((left, right) => left.name.localeCompare(right.name)),
});

const main = () => {
  const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
  const output = outputArgument
    ? resolve(repositoryRoot, outputArgument.slice("--output=".length))
    : defaultOutput;
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });

  run(
    "pnpm",
    ["pack", "--pack-destination", output],
    resolve(repositoryRoot, "packages/workbench-client"),
  );
  run(
    "pnpm",
    ["pack", "--pack-destination", output],
    resolve(repositoryRoot, "packages/workbench-react"),
  );

  const packages = [
    inspectArchive(archiveFor(output, "operloom-workbench-client-")),
    inspectArchive(archiveFor(output, "operloom-workbench-react-")),
  ];
  const application = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const contractText = readFileSync(
    resolve(repositoryRoot, "packages/workbench-client/contract-manifest.json"),
    "utf8",
  );
  const manifest = buildDistributionManifest({
    applicationVersion: application.version,
    sourceCommit: run("git", ["rev-parse", "HEAD"]),
    contractText,
    packages,
  });
  writeFileSync(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Packed ${packages.length} frontend packages with checksums in ${output}.`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
