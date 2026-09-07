import { execFile, execFileSync, spawn, type SpawnOptions } from "node:child_process";

export type ManagedProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason?: string;
  peakProcesses: number;
  peakRssMb: number;
};

export const serviceMemoryBudgetMb = (label: string) => {
  if (label.startsWith("frontend")) return 5120;
  if (label.startsWith("worker")) return 1536;
  return 1024;
};

type Options = Pick<SpawnOptions, "cwd" | "env" | "stdio"> & {
  label?: string;
  maxProcesses?: number;
  maxRssMb?: number;
};

// Development services get their own process group. Killing only pnpm leaves
// Next/Worker grandchildren running after a timeout or an interrupted test.
export const startManagedProcess = (command: string, args: string[], options: Options = {}) => {
  const { label = command, maxProcesses = 24, maxRssMb = 1024, ...spawnOptions } = options;
  const posix = process.platform !== "win32";
  const child = spawn(command, args, {
    ...spawnOptions,
    detached: posix,
    env: {
      ...process.env,
      ...spawnOptions.env,
      RAYON_NUM_THREADS: "2",
      NODE_OPTIONS:
        `${spawnOptions.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? ""} --max-old-space-size=3072`.trim(),
    },
  });
  let reason: string | undefined;
  let peakProcesses = 0;
  let peakRssMb = 0;
  let stopping = false;
  let checking = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;

  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    if (!posix) {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      // Darwin may report EPERM for a process group that has already disappeared.
      // Verify absence rather than treating a successful short-lived command as a failure.
      if (code === "EPERM") {
        try {
          const groups = execFileSync("ps", ["-axo", "pgid="], { encoding: "utf8", timeout: 1000 });
          if (!groups.split("\n").some((group) => Number(group.trim()) === child.pid)) return;
        } catch {
          // If inspection fails, retain the cleanup failure below.
        }
      }
      reason ??= `${label}: could not stop service group (${code ?? "unknown error"})`;
      console.error(reason);
    }
  };

  const onParentExit = () => signalGroup("SIGKILL");
  process.once("exit", onParentExit);

  const stop = (failure?: string) => {
    if (stopping) return;
    stopping = true;
    reason = failure ?? reason;
    if (failure) console.error(failure);
    clearInterval(timer);
    signalGroup("SIGTERM");
    // Keep this timer alive even if the group leader exits before its children.
    forceTimer = setTimeout(() => signalGroup("SIGKILL"), 1000);
  };

  const completion = new Promise<ManagedProcessResult>((resolve) => {
    child.once("error", (error) => {
      reason = `${label} could not start: ${error.message}`;
    });
    child.once("close", (code, signal) => {
      clearInterval(timer);
      if (!stopping) stop();
      // stop() gives any orphaned grandchildren a bounded cleanup window.
      setTimeout(() => {
        clearTimeout(forceTimer);
        signalGroup("SIGKILL");
        process.removeListener("exit", onParentExit);
        resolve({ code, signal, peakProcesses, peakRssMb, ...(reason ? { reason } : {}) });
      }, 1050);
    });
  });

  if (posix && child.pid) {
    timer = setInterval(() => {
      if (checking || stopping) return;
      checking = true;
      execFile("ps", ["-axo", "pgid=,rss="], { timeout: 1000 }, (error, stdout) => {
        checking = false;
        if (stopping) return;
        if (error) {
          stop(`${label}: resource monitor failed; stopping the service`);
          return;
        }
        const group = stdout.split("\n").flatMap((line) => {
          const [pgid, rss] = line.trim().split(/\s+/).map(Number);
          return pgid === child.pid && Number.isFinite(rss) ? [rss!] : [];
        });
        const rssMb = group.reduce((sum, rss) => sum + rss, 0) / 1024;
        peakProcesses = Math.max(peakProcesses, group.length);
        peakRssMb = Math.max(peakRssMb, Math.ceil(rssMb));
        if (group.length > maxProcesses || rssMb > maxRssMb) {
          stop(
            `${label}: resource limit exceeded (${group.length}/${maxProcesses} processes, ${Math.ceil(rssMb)}/${maxRssMb} MiB RSS); stopped the entire service group`,
          );
        }
      });
    }, 200);
  }

  return { child, completion, stop };
};
