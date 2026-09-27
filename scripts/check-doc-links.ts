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
const packageManagerBuiltins = new Set(["install", "exec", "dlx", "add", "run"]);
const packageDocs = ["examples", "agent-packs"].flatMap((root) =>
  readdirSync(join(repositoryRoot, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(repositoryRoot, root, entry.name, "README.md"))
    .filter((path) => existsSync(path)),
);
for (const markdownFile of [...markdownRoots.flatMap(collectMarkdownFiles), ...packageDocs]) {
  const file = markdownFile.slice(repositoryRoot.length + 1);
  const content = readFileSync(markdownFile, "utf8");
  for (const match of content.matchAll(/(?:^|[\s`(])pnpm ([a-z][a-z0-9:-]*)/gim)) {
    const command = match[1]!;
    if (!packageManagerBuiltins.has(command) && !packageJson.scripts?.[command]) {
      failures.push(`${file} documents missing package script ${command}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Found ${failures.length} documentation problem(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Local Markdown links are valid.");
}
