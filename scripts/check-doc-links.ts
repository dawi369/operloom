import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const markdownRoots = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "COMMERCIAL_USE.md", "docs"];
const markdownLinkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

function collectMarkdownFiles(path: string): string[] {
  const absolutePath = join(repositoryRoot, path);
  if (!existsSync(absolutePath)) return [];
  if (!statSync(absolutePath).isDirectory()) return [absolutePath];

  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory()
      ? collectMarkdownFiles(child)
      : extname(entry.name) === ".md"
        ? [join(repositoryRoot, child)]
        : [];
  });
}

const failures: string[] = [];
const readRepositoryFile = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");

for (const markdownFile of markdownRoots.flatMap(collectMarkdownFiles)) {
  const content = readFileSync(markdownFile, "utf8");
  for (const match of content.matchAll(markdownLinkPattern)) {
    const destination = match[1]?.trim().replace(/^<|>$/g, "");
    if (!destination || destination.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(destination)) {
      continue;
    }

    const localPath = decodeURIComponent(destination.split("#", 1)[0]!.split("?", 1)[0]!);
    const absoluteTarget = resolve(dirname(markdownFile), localPath);
    if (!existsSync(absoluteTarget)) {
      failures.push(`${markdownFile.slice(repositoryRoot.length + 1)} -> ${destination}`);
    }
  }
}

const readme = readRepositoryFile("README.md");
if (/<!--\s*Add the .* screenshot/i.test(readme)) {
  failures.push("README.md still contains a release screenshot placeholder");
}

const packageJson = JSON.parse(readRepositoryFile("package.json")) as {
  scripts?: Record<string, string>;
};
const documentedCommandFiles = [
  "README.md",
  "CONTRIBUTING.md",
  "docs/complex-agent-golden-path.md",
];
const packageManagerBuiltins = new Set(["install", "exec", "dlx"]);
for (const file of documentedCommandFiles) {
  const content = readRepositoryFile(file);
  for (const match of content.matchAll(/^pnpm ([a-z][a-z0-9:-]*)/gim)) {
    const command = match[1]!;
    if (!packageManagerBuiltins.has(command) && !packageJson.scripts?.[command]) {
      failures.push(`${file} documents missing package script ${command}`);
    }
  }
}

const currentTopology = readRepositoryFile("docs/diagrams/current-implementation-topology.mmd");
if (currentTopology.includes("R2 artifacts planned")) {
  failures.push("current implementation topology still labels active R2 artifacts as planned");
}
if (!currentTopology.includes("R2 artifacts + exports")) {
  failures.push("current implementation topology must show active R2 artifact/export storage");
}

if (failures.length > 0) {
  console.error(`Found ${failures.length} broken local Markdown link(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Local Markdown links are valid.");
}
