# Queued turns and mid-turn steering

Status: implemented (migration 0011, `chat-command-admission.ts`,
`thread-chat-agent.ts`, `/v1` turns contract, `@operloom/client`
`threads.steer`, capability `chat.queue`). The current behaviour is documented
in [headless runtime](../headless-runtime.md#queued-turns-and-steering); this
note keeps the decisions and what was deliberately left out. Written after
reviewing how `nuphos/nuphos` models `pending-messages`, `queued-turn` and
`steering-history` on top of an in-process run registry; the shape below keeps
the idea and moves the authority into D1, where every other Operloom admission
already lives.

## Today

- `ThreadChatAgent` runs one turn at a time per thread. A programmatic
  (`/v1` HTTP) turn that arrives while another is in flight is refused with
  `409 Programmatic turn already in progress` (`thread-chat-agent.ts`), and
  the console composer is disabled while the stream runs.
- Chat admission is durable: `control_chat_commands` registers each turn in
  D1 before acknowledgement, links it to one `chat_runs` row, and deadline
  recovery closes abandoned work (`chat-command-admission.ts`).
- The step loop is bounded by `chatHardStepLimit` and the per-step guards in
  `chat-turn-guards.ts`. Nothing can change a turn once it has started except
  cancellation.

That is correct and safe, and it is the wrong answer for two product
situations that the driver products ([polymancer](polymancer.md),
[roofing operator](roofing-operator.md)) create:

1. A monitor-triggered or delegated turn is running when the user types. The
   user's message is lost or rejected, and they retype it after the turn ends.
2. The user sees the agent heading the wrong way mid-turn ("not that
   repository") and has no way to correct it short of cancelling and starting
   over, which throws away tool results already paid for.

## Decisions

- **Queueing is an admission outcome, not a client concern.** A turn that
  cannot start now is accepted with `status: "queued"` and a position, never
  `409`. The same `clientTurnId` idempotency applies. Clients that only
  understand `accepted` keep working because queued turns still produce the
  same events when they run.
- **The queue is a D1 state on `control_chat_commands`, not a Durable Object
  field.** Add `queued` to the status set and a `queued_at` column; the
  per-thread Durable Object drains the queue in `queued_at` order when a run
  reaches a terminal state. Nothing new is stored in memory; a Durable Object
  restart loses nothing. A new migration under
  `cloudflare/control-plane/migrations/` with `schema.sql` parity.
- **Bounded.** At most `chat.queueLimit` (default 3) queued turns per
  thread; the fourth is refused with `409 queue_full`. Queued turns expire with
  the same `expires_at` as pending ones, and `expireChatCommands` closes them
  as `cancelled` with `error_code: "queue_expired"`.
- **Steering is a queued turn with `mode: "steer"`.** Instead of waiting for
  the terminal state, a steer is injected into the running turn at the next
  `prepareStep` as a user message appended to `messages`, and the command moves
  to `running` linked to the same `chat_runs` row. This is why `prepareStep`
  (not `stopWhen`) owns step planning: it is the one hook that sees and can
  rewrite the next step's input. A steer that arrives after the final step has
  begun falls back to a normal queued turn.
- **Steers are visible.** The steer becomes a real user message in the thread
  transcript with `metadata.steeredRunId`, so the history shows what was said
  and when, and the public message contract (`packages/client/src/messages.ts`)
  renders it without a new part type.
- **Authority is re-checked at drain time.** A queued turn runs through
  `acceptChatCommand` again when it is drained, so a revoked membership, a
  pinned agent revision change, a kill switch or an export freeze between
  enqueue and start refuses it exactly as a fresh turn would be refused.
- **Budgets reserve at drain, not enqueue.** Reservation at enqueue would let a
  queue hold budget hostage; the queued turn is admitted against the workspace
  and root-run budget when it actually starts.

## Contract delta

- The programmatic turn response (`client.session.materializeTurn`, and the
  `/v1` HTTP turn that returns `commandId`) gains
  `status: "accepted" | "queued"` and, when queued, `queuePosition`. The
  request gains optional `mode: "turn" | "steer"` (default `turn`).
- `client.threads.command(commandId)` reports `queued` alongside the existing
  `pending`, `running`, `completed`, `failed` and `cancelled` outcomes.
- Session events gain `chat.turn.queued` and `chat.turn.steered` with
  `threadId`, `runId`, `clientTurnId`, `queuePosition`.
- `@operloom/client`: `steerTurn` is a thin wrapper over `materializeTurn`
  setting `mode: "steer"`. All additive.
- `implementedRuntimeCapabilities` (`packages/agent-sdk/src/capabilities.ts`)
  gains `chat.queue` so packs and clients negotiate it.

## Non-goals

- No multi-user co-driving of one turn. Operloom threads are owned by one
  user; delegation (`tasks.delegate`) is how agents share work, and the fleet
  board is how people watch it.
- No client-side queues. The console and mobile apps submit and render
  server status; they never hold unsent messages past the request.
- No LLM "stop gate" that forces continuation after a clean finish. The
  deterministic guards in `chat-turn-guards.ts` stop bad turns earlier;
  forcing more steps after a clean stop is a product decision to revisit
  with evidence from traces, not a platform default.

## Acceptance

- Unit tests for the drain order, the queue limit, expiry, steer injection at
  `prepareStep`, and re-admission refusal after a revision change.
- A conformance scenario in `tests/e2e/agent-system-conformance.spec.ts`:
  submit a slow programmatic turn, submit a second, observe `queued` then its
  own run; submit a steer and observe it in the transcript of the first run.
- `pnpm verify:fast`, `pnpm conformance:agent-system`, migration parity check.
