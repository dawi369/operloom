import { pathToFileURL } from "node:url";
import { startManagedProcess, serviceMemoryBudgetMb } from "./managed-process";

/** Only Worker configuration is read by Wrangler; no .env.local, Next or React startup. */
export const runtimeDevCommand = (port = 8787) => ({
  command: "pnpm",
  args: [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "cloudflare/control-plane/wrangler.jsonc",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--var",
    "WORKBENCH_PUBLIC_API_ENABLED:true",
    "--var",
    "WORKBENCH_LOCAL_API_ENABLED:true",
    "--var",
    "WORKBENCH_ENVIRONMENT:local",
  ],
});

const main = async () => {
  const config = runtimeDevCommand();
  const managed = startManagedProcess(config.command, config.args, {
    label: "worker-runtime",
    stdio: "inherit",
    maxRssMb: serviceMemoryBudgetMb("worker"),
  });
  process.once("SIGINT", () => managed.stop());
  process.once("SIGTERM", () => managed.stop());
  const result = await managed.completion;
  process.exitCode = result.reason ? 1 : (result.code ?? 0);
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
