import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  registerAgentPackSource,
  renderAgentPackControlPlane,
  renderAgentPackIndex,
  renderAgentPackPackageJson,
  renderAgentPackPrompt,
  renderAgentPackReadme,
  renderAgentPackRunner,
  renderAgentPackTest,
  renderAgentPackWeb,
  validateAgentPackScaffoldInput,
} from "../lib/workbench/agent-pack-scaffold";

const readArg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const id = readArg("--id") ?? "";
const name = readArg("--name") ?? "";
const dryRun = process.argv.includes("--dry-run");
const input = validateAgentPackScaffoldInput({ id, name });
const root = process.cwd();
const packDirectory = resolve(root, "agent-packs", input.id);
const registryPath = resolve(root, "workbench.config.ts");
if (existsSync(packDirectory))
  throw new Error(`Agent Pack directory already exists: ${packDirectory}`);

const indexSource = renderAgentPackIndex(input);
const promptSource = `${renderAgentPackPrompt(input.name)}\n`;
const registrySource = registerAgentPackSource(readFileSync(registryPath, "utf8"), input.id);

if (dryRun) {
  console.log(
    `Would create a complete Runtime Module v1 package at agent-packs/${input.id} and configure it.`,
  );
  process.exit(0);
}

try {
  mkdirSync(packDirectory);
  writeFileSync(join(packDirectory, "index.ts"), indexSource, { flag: "wx" });
  writeFileSync(
    join(packDirectory, "manifest.ts"),
    `export { ${input.id.replace(/-([a-z0-9])/g, (_, character: string) => character.toUpperCase())}Pack as manifest } from "./index";\n`,
    { flag: "wx" },
  );
  writeFileSync(join(packDirectory, "control-plane.ts"), renderAgentPackControlPlane(input), {
    flag: "wx",
  });
  writeFileSync(join(packDirectory, "runner.ts"), renderAgentPackRunner(input.id), { flag: "wx" });
  writeFileSync(join(packDirectory, "web.ts"), renderAgentPackWeb(input.id), { flag: "wx" });
  writeFileSync(join(packDirectory, "README.md"), renderAgentPackReadme(input), { flag: "wx" });
  writeFileSync(join(packDirectory, "control-plane.test.ts"), renderAgentPackTest(input), {
    flag: "wx",
  });
  writeFileSync(join(packDirectory, "package.json"), renderAgentPackPackageJson(input), {
    flag: "wx",
  });
  writeFileSync(join(packDirectory, "prompt.xml"), promptSource, { flag: "wx" });
  writeFileSync(registryPath, registrySource);
} catch (error) {
  rmSync(packDirectory, { recursive: true, force: true });
  throw error;
}

console.log(`Created and configured Runtime Module v1 Agent Pack ${input.id}.`);
console.log(
  `Next: pnpm install && pnpm agent-packs:compile && pnpm agent-packs:validate && pnpm agent-packs:test --pack ${input.id}`,
);
