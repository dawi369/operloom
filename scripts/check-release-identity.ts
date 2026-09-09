import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type ReleaseIdentity = {
  schemaVersion: 1;
  applicationVersion: string;
  status: "candidate" | "released";
  publishedTag: string | null;
  acceptedForkBase: string;
  releaseDocument?: string;
};

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const readJson = <T>(path: string) => JSON.parse(read(path)) as T;

export const releaseIdentityFailures = (input: {
  release: ReleaseIdentity;
  packageVersion: string;
  workbenchVersion: string;
  readme: string;
  changelog: string;
  releaseDocument: string;
}) => {
  const failures: string[] = [];
  const { release } = input;
  if (release.schemaVersion !== 1) failures.push("unsupported release identity schema");
  if (input.packageVersion !== release.applicationVersion) {
    failures.push("package.json version differs from config/release.json");
  }
  if (input.workbenchVersion !== release.applicationVersion) {
    failures.push("workbench.config.ts version differs from config/release.json");
  }
  if (!input.readme.includes(`version-${release.applicationVersion}-`)) {
    failures.push("README version badge differs from config/release.json");
  }
  if (!input.readme.includes(`\`${release.applicationVersion}\``)) {
    failures.push("README release status omits the application version");
  }
  const heading =
    release.status === "candidate"
      ? `## ${release.applicationVersion} (unreleased candidate)`
      : `## ${release.applicationVersion}`;
  if (!input.changelog.split("\n").includes(heading)) {
    failures.push(`CHANGELOG must contain ${heading}`);
  }
  if (!input.releaseDocument.includes(`Release state: ${release.status}.`)) {
    failures.push("release document status differs from config/release.json");
  }
  const expectedTag = `v${release.applicationVersion}`;
  if (release.status === "candidate" && release.publishedTag !== null) {
    failures.push("candidate releases cannot declare a published tag");
  }
  if (
    release.status === "candidate" &&
    input.releaseDocument.includes(`The \`${expectedTag}\` prerelease identifies`)
  ) {
    failures.push("candidate release document claims an uncut prerelease tag");
  }
  if (release.status === "released" && release.publishedTag !== expectedTag) {
    failures.push(`released identity must declare ${expectedTag}`);
  }
  if (!input.releaseDocument.includes(`\`${release.acceptedForkBase}\``)) {
    failures.push("release document omits the accepted fork base");
  }
  return failures;
};

const release = readJson<ReleaseIdentity>("config/release.json");
const packageJson = readJson<{ version: string }>("package.json");
const workbenchConfig = read("workbench.config.ts");
const workbenchVersion = workbenchConfig.match(/workbenchVersion:\s*"([^"]+)"/u)?.[1] ?? "";
const failures = releaseIdentityFailures({
  release,
  packageVersion: packageJson.version,
  workbenchVersion,
  readme: read("README.md"),
  changelog: read("CHANGELOG.md"),
  releaseDocument: read(
    release.releaseDocument ??
      `docs/release-${release.applicationVersion.split(".").slice(0, 2).join(".")}.md`,
  ),
});

if (failures.length) {
  console.error("Release identity drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Release identity ${release.applicationVersion} is consistent (${release.status}, ${release.acceptedForkBase}).`,
  );
}
