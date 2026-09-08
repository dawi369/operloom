# Build your first agent

Start with the generated read-only example. It provides a small executable
workflow, so you can learn the extension boundary before adding credentials,
external APIs, or side effects.

## Create and check

From the repository root:

```bash
pnpm operloom pack create --id my-agent --name "My Agent"
pnpm install
pnpm operloom pack compile
pnpm operloom pack check --pack my-agent
```

The generator creates `agent-packs/my-agent/` and adds its entry to
`workbench.config.ts`. Reinstalling registers the new workspace package in the
lockfile. The compiler writes deterministic runtime registries.
Do not edit those generated files by hand.

## Make the example yours

- In `index.ts`, describe one bounded job and update the welcome text.
- Keep the exported prompt and `prompt.xml` synchronized; the manifest carries
  the behavior used by the runtime.
- In `control-plane.ts`, replace the starter inspection result with your own
  deterministic logic. Keep the input/output schemas and declarations aligned.
- Extend `control-plane.test.ts` to check a real success case and a meaningful
  failure boundary for that job.
- Recompile, check the pack, and restart the development app.

Use Admin's agent/pack controls to instantiate or activate the compiled pack
for your workspace. Existing agent snapshots are not silently rewritten by
changing source files. Then select the agent and run its workflow from Tools.
Inspect the resulting run in History.

## Where to go beyond the starter

| Need                                    | Extension point                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| Call an API in a bounded read-only tool | Control-plane binding and declared schemas                                     |
| Run repository/process tooling          | `runner.ts`, using the signed Node.js runner                                   |
| Show a structured result                | Artifact descriptor and `web.ts` renderer                                      |
| Persist domain records                  | Managed-state descriptors                                                      |
| React to external events                | Declared trigger and signed webhook/scheduler contracts                        |
| Perform a side effect                   | Connection brokerage, policy, proposal, approval, and reconciliation contracts |

Treat packs as trusted application code. Schema checks and authorization
protect runtime boundaries; they do not sandbox arbitrary code you install.

For a working repository example, read
[Repository Analyst](../agent-packs/repo-analyst/control-plane.ts). For the full
contract, read [Agent Runtime Kit](agent-runtime-kit.md). For the larger example
with managed state, connections, and recovery, read the
[Complex Agent Golden Path](complex-agent-golden-path.md).
