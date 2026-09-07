import { describe, expect, it } from "vitest";

import { buildDistributionManifest, validatePackageArchive } from "./pack-workbench-client";

const validArchive = {
  entries: ["package/dist/index.js", "package/dist/index.d.ts", "package/README.md"],
  manifestText: JSON.stringify({ name: "@operloom/test", version: "0.1.1" }),
  executableText: 'export * from "./client.js";',
};

describe("workbench client distribution", () => {
  it("accepts portable built packages and creates deterministic package ordering", () => {
    expect(() => validatePackageArchive(validArchive)).not.toThrow();
    const manifest = buildDistributionManifest({
      applicationVersion: "0.5.1",
      sourceCommit: "abc",
      contractText: "contract",
      packages: [
        { name: "z", version: "1", archive: "z.tgz", bytes: 2, sha256: "z" },
        { name: "a", version: "1", archive: "a.tgz", bytes: 1, sha256: "a" },
      ],
    });
    expect(manifest.packages.map((entry) => entry.name)).toEqual(["a", "z"]);
    expect(manifest.contractSha256).toHaveLength(64);
  });

  it("rejects source files, workspace links, and repository-relative imports", () => {
    expect(() =>
      validatePackageArchive({
        ...validArchive,
        entries: [...validArchive.entries, "package/src/index.ts"],
      }),
    ).toThrow("forbidden path");
    expect(() =>
      validatePackageArchive({ ...validArchive, manifestText: '{"dependency":"workspace:*"}' }),
    ).toThrow("workspace dependency");
    expect(() =>
      validatePackageArchive({ ...validArchive, executableText: 'export * from "../../app/x"' }),
    ).toThrow("repository-relative import");
  });
});
