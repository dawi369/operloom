import { describe, expect, it } from "vitest";

import { releaseIdentityFailures } from "./check-release-identity";

const valid = {
  release: {
    schemaVersion: 1 as const,
    applicationVersion: "0.5.1",
    status: "candidate" as const,
    publishedTag: null,
    acceptedForkBase: "v0.4.0",
  },
  packageVersion: "0.5.1",
  workbenchVersion: "0.5.1",
  readme: "version-0.5.1-x `0.5.1`",
  changelog: "## 0.5.1 (unreleased candidate)",
  releaseDocument: "Release state: candidate. `v0.4.0`",
};

describe("release identity", () => {
  it("accepts a truthful untagged candidate", () => {
    expect(releaseIdentityFailures(valid)).toEqual([]);
  });

  it("rejects version drift and an invented prerelease", () => {
    expect(
      releaseIdentityFailures({
        ...valid,
        packageVersion: "0.5.0",
        releaseDocument:
          "Release state: candidate. `v0.4.0` The `v0.5.1` prerelease identifies the accepted commit.",
      }),
    ).toEqual(
      expect.arrayContaining([
        "package.json version differs from config/release.json",
        "candidate release document claims an uncut prerelease tag",
      ]),
    );
  });
});

it("accepts an actual release and rejects candidate wording for it", () => {
  const released = {
    ...valid,
    release: { ...valid.release, status: "released" as const, publishedTag: "v0.5.1" },
    changelog: "## 0.5.1",
    releaseDocument: "Release state: released. `v0.4.0`",
  };
  expect(releaseIdentityFailures(released)).toEqual([]);
  expect(releaseIdentityFailures({ ...released, changelog: valid.changelog })).toContain(
    "CHANGELOG must contain ## 0.5.1",
  );
});
