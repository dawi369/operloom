# A fast tool inside a slow workflow

During hosted 1.0 acceptance, Repository Analyst failed after roughly 30 seconds.
The repository snapshot itself took 240 ms and produced an artifact. The workflow
still timed out before it could finish the report.

## Diagnosis

The test started with the Fly runner stopped, matching the minimal deployment.
The runner began booting almost immediately but took about 20 seconds to start
listening. Dispatch, execution, and result callbacks used the rest of the pack's
30-second `maxRunSeconds` budget. Measuring only the tool hid the actual limit:
the deadline covered the whole workflow, including the cold start.

The failure stayed visible in the dialog, with the entered inputs and a link to
the failed run. An intermediate artifact was not proof of a completed workflow;
the terminal run status was the source of truth.

## Fix and tradeoff

[The fix](https://github.com/dawi369/operloom/commit/f2ecc166cef511b15da31841ca4067ca2cfb43cb)
raised the repository and Polymancer demo budgets from 30 to 90 seconds and bumped
their pack patch versions. It did not add warm-up traffic, scheduled jobs, or an
always-on runner. The tradeoff is a longer wait before declaring a stalled demo
workflow failed, while retaining the ability to stop compute when idle.

Agent instances keep immutable pack snapshots, including their saved limits.
Selecting the updated pack creates a new instance with the larger budget;
existing conversations keep their original configuration. Changing a pack's
source is deliberately not a silent migration of every running agent.

The [deadline contract](../runtime-deadlines.md) documents browser, facade,
execution, and recovery limits together. Durable alarms eventually finalize
abandoned runs even when scheduling is disabled. Failed work is not automatically
replayed; the user decides whether to retry.

## Verification

Targeted pack/compiler checks passed. On the final 1.0 commit, a second hosted
repository run from a stopped runner reached `completed` and produced both the
snapshot and readiness report. The snapshot covered 80 files; its tool timing was
341 ms. [Release CI](https://github.com/dawi369/operloom/actions/runs/34330781367)
also passed. The runner was stopped again after acceptance.

This verifies the tested cold-start path, not a throughput benchmark or an
availability guarantee. The useful distinction is between tool time and the
end-to-end budget a user actually waits on.
