import { serviceMemoryBudgetMb, startManagedProcess } from "./managed-process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const main = async () => {
  const [logPath, command, ...args] = process.argv.slice(2);

  if (!logPath || !command) {
    throw new Error("Usage: run-with-log <log-path> <command> [args...]");
  }

  await mkdir(path.dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "w" });
  const managed = startManagedProcess(command, args, {
    label: path.basename(logPath),
    maxRssMb: serviceMemoryBudgetMb(path.basename(logPath)),
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  const { child } = managed;
  let logBytes = 0;
  const countOutput = (chunk: Buffer) => {
    logBytes += chunk.length;
    if (logBytes > 10 * 1024 * 1024)
      managed.stop("Service log exceeded 10 MiB; stopping runaway output");
  };
  child.stdout!.on("data", countOutput);
  child.stderr!.on("data", countOutput);

  child.stdout!.pipe(process.stdout);
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(process.stderr);
  child.stderr!.pipe(log, { end: false });

  let signalExitCode: number | undefined;
  // Launchers can relay a signal already delivered to the process group.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      signalExitCode = signal === "SIGINT" ? 130 : 143;
      managed.stop();
    });
  }
  const result = await managed.completion;
  const summary = `${path.basename(logPath)}: peak ${result.peakProcesses} processes, ${result.peakRssMb} MiB RSS`;
  console.log(summary);
  log.write(`${summary}\n`);
  await new Promise<void>((resolve) => log.end(resolve));
  process.exitCode = result.reason ? 1 : (signalExitCode ?? result.code ?? 1);
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
