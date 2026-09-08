import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFile as writeFileCallback } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { atomicManifestWriter, AtomicDevManifestsPlugin } from "./atomic-dev-manifests";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("the plugin does not mutate a filesystem shared with other compilers", () => {
  const filesystem = { writeFile: writeFileCallback };
  let initialize: (() => void) | undefined;
  const compiler = {
    outputFileSystem: filesystem,
    hooks: {
      afterEnvironment: {
        tap: (_name: string, callback: () => void) => {
          initialize = callback;
        },
      },
    },
  };
  new AtomicDevManifestsPlugin().apply(compiler);
  initialize!();
  expect(compiler.outputFileSystem).not.toBe(filesystem);
  expect(filesystem.writeFile).toBe(writeFileCallback);
  expect(compiler.outputFileSystem.writeFile).not.toBe(writeFileCallback);
});

test.each(["app-paths-manifest.json", "page_client-reference-manifest.js"])(
  "%s stays complete while a replacement is being written",
  async (name) => {
    const directory = await mkdtemp(join(tmpdir(), "operloom-manifest-"));
    directories.push(directory);
    const target = join(directory, name);
    await writeFile(target, "old-complete-manifest");
    let finishWrite: (() => void) | undefined;
    const writer = atomicManifestWriter((temporary, data, callback) => {
      expect(temporary).not.toBe(target);
      finishWrite = () => writeFileCallback(temporary, data, callback);
    });
    const completed = new Promise<void>((resolve, reject) => {
      writer(target, "new-complete-manifest", (error) => (error ? reject(error) : resolve()));
    });
    expect(await readFile(target, "utf8")).toBe("old-complete-manifest");
    finishWrite!();
    await completed;
    expect(await readFile(target, "utf8")).toBe("new-complete-manifest");
  },
);

test("ordinary assets keep the original output writer", () => {
  let writtenPath = "";
  const writer = atomicManifestWriter((path, _data, callback) => {
    writtenPath = path;
    callback(null);
  });
  writer("/output/chunk.js", "chunk", () => {});
  expect(writtenPath).toBe("/output/chunk.js");
});

test("a failed replacement preserves the last complete manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "operloom-manifest-"));
  directories.push(directory);
  const target = join(directory, "build-manifest.json");
  await writeFile(target, "last-complete-manifest");
  const failure = new Error("write failed");
  const writer = atomicManifestWriter((_path, _data, callback) => callback(failure));
  const result = await new Promise((resolve) => writer(target, "replacement", resolve));
  expect(result).toBe(failure);
  expect(await readFile(target, "utf8")).toBe("last-complete-manifest");
});
