import { randomUUID } from "node:crypto";
import { rename, unlink } from "node:fs";
import { basename } from "node:path";

type Callback = (error: NodeJS.ErrnoException | null) => void;
type WriteFile = (path: string, data: string | Uint8Array, callback: Callback) => void;

/** Readers must see either complete manifest, never webpack's truncate/write window. */
export const atomicManifestWriter = (writeFile: WriteFile): WriteFile => {
  return (target, data, callback) => {
    if (!/manifest.*\.(?:json|js)$/.test(basename(target))) {
      writeFile(target, data, callback);
      return;
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFile(temporary, data, (writeError) => {
      if (writeError) {
        unlink(temporary, () => callback(writeError));
        return;
      }
      rename(temporary, target, (renameError) => {
        if (renameError) unlink(temporary, () => callback(renameError));
        else callback(null);
      });
    });
  };
};

type Compiler = {
  outputFileSystem: { writeFile: WriteFile } | null;
  hooks: { afterEnvironment: { tap(name: string, callback: () => void): void } };
};

export class AtomicDevManifestsPlugin {
  apply(compiler: Compiler) {
    compiler.hooks.afterEnvironment.tap("OperloomAtomicDevManifests", () => {
      const filesystem = compiler.outputFileSystem;
      if (!filesystem) throw new Error("Webpack output filesystem is unavailable");
      const isolatedFilesystem = Object.create(filesystem) as NonNullable<
        Compiler["outputFileSystem"]
      >;
      isolatedFilesystem.writeFile = atomicManifestWriter(filesystem.writeFile.bind(filesystem));
      compiler.outputFileSystem = isolatedFilesystem;
    });
  }
}
