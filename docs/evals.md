# Evals

Operloom treats real-session evals as runtime contract checks, not offline
prompt grading.

Real-session evals should drive the same HTTP/session/runtime surfaces that a
user or operator hits and assert on durable product state: messages, runs,
threads, tool calls, approvals, HITL state, events, traces, artifacts, and
tenant isolation.

## Operational and Authority Gates

The release gate executes the required unit and real service/browser boundaries:

```bash
pnpm conformance:level2
pnpm conformance:level3
pnpm conformance:data-lifecycle
pnpm conformance:connections
pnpm conformance:actions
```

The registry lives in `lib/workbench/level2-conformance.ts`. The runner writes
`output/conformance/level2.json` and fails unless every required guarantee is
covered by a suite that actually passed. `eval:real-session-posture` remains a
legacy manifest diagnostic and is not a release gate.

Additional opt-in service smokes:

- `pnpm smoke:cloudflare-chat-session-lifecycle`
- `pnpm smoke:cloudflare-membership-policy`
- `pnpm smoke:cloudflare-tool-admin`
- `pnpm smoke:cloudflare-runtime-traces`
- `pnpm smoke:cloudflare-event-stream`
- `pnpm smoke:fly-tool-runner`

Provider-dependent smokes and Swordfish remain outside the deterministic gate.

## Not In v0

- No LLM judge.
- No new eval service.
- No production schedule replay harness.
- No LLM-judged browser grading loop.
- No stored prompt/message corpus.

Add those only after the runtime contract gaps are visible in the current smoke
suite.
