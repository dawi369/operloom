import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type ResolvedCommand = { script: string; args: string[] };

const help = `Operloom developer commands

  pnpm operloom init [--check|--no-migrate]
  pnpm operloom fork init --id <id> --name <name> --origin <url>
  pnpm operloom fork --check
  pnpm operloom dev
  pnpm operloom doctor [--offline]
  pnpm operloom verify [fast|full|release]
  pnpm operloom pack create --id <id> --name <name>
  pnpm operloom pack <compile|validate|inspect|test|check> [arguments]
  pnpm operloom client pack
  pnpm operloom env check [--target <local|acceptance|production>]

Existing package-script aliases remain supported for CI and automation.`;

export const resolveWorkbenchCommand = (arguments_: string[]): ResolvedCommand | null => {
  const [group, action, ...rest] = arguments_;
  if (!group || group === "help" || group === "--help" || group === "-h") return null;
  if (group === "init") return { script: "workbench:init", args: arguments_.slice(1) };
  if (group === "fork" && (action === "init" || action === "check" || action === "--check")) {
    return {
      script: "workbench:fork",
      args: action === "init" ? rest : ["--check", ...rest],
    };
  }
  if (group === "dev") return { script: "workbench:dev", args: arguments_.slice(1) };
  if (group === "doctor") return { script: "workbench:doctor", args: arguments_.slice(1) };
  if (group === "verify") {
    if (!action || action === "fast") return { script: "verify:fast", args: rest };
    if (action === "full") return { script: "verify", args: rest };
    if (action === "release") return { script: "release:check", args: rest };
  }
  if (group === "pack" && action) {
    const scripts: Record<string, string> = {
      create: "agent-packs:create",
      compile: "agent-packs:compile",
      validate: "agent-packs:validate",
      inspect: "agent-packs:inspect",
      test: "agent-packs:test",
      check: "agent-packs:check",
    };
    if (scripts[action]) return { script: scripts[action], args: rest };
  }
  if (group === "client" && action === "pack") {
    return { script: "workbench-client:pack", args: rest };
  }
  if (group === "env" && action === "check") {
    return { script: "environment:check", args: rest };
  }
  throw new Error(`Unknown workbench command: ${arguments_.join(" ")}\n\n${help}`);
};

const main = () => {
  const command = resolveWorkbenchCommand(process.argv.slice(2));
  if (!command) {
    console.log(help);
    return;
  }
  const result = spawnSync("pnpm", ["--silent", command.script, ...command.args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
