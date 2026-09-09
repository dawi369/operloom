import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { crc32 } from "node:zlib";

const consumerRequire = createRequire(
  resolve("node_modules/@langchain/langgraph-cli/package.json"),
);
const extract = consumerRequire("extract-zip") as (
  file: string,
  options: { dir: string },
) => Promise<void>;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Stored ZIP entries with explicit Unix modes exercise the installed dependency,
// including duplicate filenames (the archive-based arbitrary-write vector).
function archive(entries: Array<{ name: string; data: string; mode?: number }>) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = Buffer.from(entry.data);
    const local = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(directory, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function fixture(entries: Parameters<typeof archive>[0]) {
  const root = mkdtempSync(join(tmpdir(), "operloom-zip-security-"));
  roots.push(root);
  const dir = join(root, "out"),
    zip = join(root, "input.zip"),
    outside = join(root, "outside");
  mkdirSync(dir);
  writeFileSync(zip, archive(entries));
  writeFileSync(outside, "unchanged");
  return { dir, zip, outside };
}

describe("patched extract-zip containment", () => {
  it("still extracts ordinary nested files", async () => {
    const f = fixture([{ name: "nested/file.txt", data: "safe" }]);
    await extract(f.zip, { dir: f.dir });
    expect(readFileSync(join(f.dir, "nested/file.txt"), "utf8")).toBe("safe");
  });
  it("rejects an escaping symlink followed by a duplicate file entry", async () => {
    const f = fixture([
      { name: "payload", data: "../outside", mode: 0o120777 },
      { name: "payload", data: "overwrite" },
    ]);
    await expect(extract(f.zip, { dir: f.dir })).rejects.toThrow("Out of bound symlink target");
    expect(readFileSync(f.outside, "utf8")).toBe("unchanged");
  });
  it("does not write through a pre-existing final-component symlink", async () => {
    const f = fixture([{ name: "payload", data: "overwrite" }]);
    symlinkSync(f.outside, join(f.dir, "payload"));
    await expect(extract(f.zip, { dir: f.dir })).rejects.toThrow("Refusing to overwrite symlink");
    expect(readFileSync(f.outside, "utf8")).toBe("unchanged");
  });
});
