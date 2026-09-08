import { describe, expect, it } from "vitest";
import { startManagedProcess } from "./managed-process";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Never construct a recursive spawner here: exactly three idle grandchildren
// exercise the same process-group boundary without stressing the host.
const fixture = `
const { spawn } = require('node:child_process');
for (let i = 0; i < 3; i++) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  console.log(child.pid);
}
setInterval(() => {}, 1000);
`;

describe.skipIf(process.platform === "win32")("managed development processes", () => {
  it("terminates a whole process group when its process budget is exceeded", async () => {
    const managed = startManagedProcess(process.execPath, ["-e", fixture], {
      stdio: ["ignore", "pipe", "pipe"],
      maxProcesses: 2,
    });
    let output = "";
    managed.child.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    try {
      const result = await managed.completion;
      expect(result.reason).toContain("resource limit exceeded");
      const pids = output.trim().split("\n").map(Number);
      expect(pids).toHaveLength(3);
      expect(pids.every((pid) => !alive(pid))).toBe(true);
    } finally {
      managed.stop();
    }
  });

  it("cleans up grandchildren when the service is stopped", async () => {
    const managed = startManagedProcess(process.execPath, ["-e", fixture], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    await new Promise<void>((resolve) => {
      managed.child.stdout!.on("data", (chunk) => {
        output += chunk;
        if (output.trim().split("\n").length === 3) resolve();
      });
    });
    managed.stop();
    await managed.completion;
    expect(
      output
        .trim()
        .split("\n")
        .map(Number)
        .every((pid) => !alive(pid)),
    ).toBe(true);
  });

  it("reports success when a short-lived command leaves no process group", async () => {
    const managed = startManagedProcess(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const result = await managed.completion;
    expect(result.code).toBe(0);
    expect(result.reason).toBeUndefined();
  });

  it("cleans up an orphan after its service leader exits normally", async () => {
    const managed = startManagedProcess(
      process.execPath,
      [
        "-e",
        `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(child.pid);
      child.unref();
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    managed.child.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    const result = await managed.completion;
    expect(result.code).toBe(0);
    expect(alive(Number(output.trim()))).toBe(false);
  });

  it("enforces the RSS budget without allocating large memory", async () => {
    const managed = startManagedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      maxRssMb: 1,
    });
    const result = await managed.completion;
    expect(result.reason).toContain("MiB RSS");
    expect(alive(managed.child.pid!)).toBe(false);
  });
});
