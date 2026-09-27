import { describe, expect, it } from "vitest";

import { resolveWorkbenchCommand } from "./workbench-cli";

describe("workbench command facade", () => {
  it("maps the task-oriented developer commands onto stable package scripts", () => {
    expect(resolveWorkbenchCommand(["dev"])).toEqual({ script: "workbench:dev", args: [] });
    expect(resolveWorkbenchCommand(["doctor", "--offline"])).toEqual({
      script: "workbench:doctor",
      args: ["--offline"],
    });
    expect(resolveWorkbenchCommand(["pack", "test", "--pack", "repo-analyst"])).toEqual({
      script: "agent-packs:test",
      args: ["--pack", "repo-analyst"],
    });
    expect(resolveWorkbenchCommand(["pack", "check", "--pack", "repo-analyst"])).toEqual({
      script: "agent-packs:check",
      args: ["--pack", "repo-analyst"],
    });
    expect(resolveWorkbenchCommand(["verify", "release"])).toEqual({
      script: "release:check",
      args: [],
    });
    expect(
      resolveWorkbenchCommand(["fork", "init", "--id", "my-workbench", "--name", "Mine"]),
    ).toEqual({
      script: "workbench:fork",
      args: ["--id", "my-workbench", "--name", "Mine"],
    });
    expect(resolveWorkbenchCommand(["fork", "--check"])).toEqual({
      script: "workbench:fork",
      args: ["--check"],
    });
    expect(resolveWorkbenchCommand(["client", "pack"])).toEqual({
      script: "client:pack",
      args: [],
    });
  });

  it("prints help for an empty command and rejects unknown command paths", () => {
    expect(resolveWorkbenchCommand([])).toBeNull();
    expect(() => resolveWorkbenchCommand(["pack", "publish"])).toThrow("Unknown workbench command");
  });
});
