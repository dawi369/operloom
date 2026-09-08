# Swordfish Reference App

Swordfish is a reference app for production market-data operations. It is not
the Operloom product identity; it is a concrete pressure test for agents
that need live runtime health, bounded market-data reads, and inspectable
reports without exposing provider credentials.

## Current Status

The `baby-swordfish` pack is a read-only single-agent reference seed. Its
workflow, adapters, artifact contract, and tests remain packaged, but the
Swordfish backend is intentionally parked and may return `404`. It is not a
live release smoke and should not block Operloom verification.

When the backend is restored, the pack uses its public product API through fixed
server-side adapters only.

It does not use `HUB_API_KEY`, Railway tokens, Massive credentials, admin
endpoints, direct provider access, mutation routes, or browser-side secrets.

## Why This Reference App Matters

Swordfish stresses a different product shape from Polymancer:

- Live-data health: the agent can explain whether Redis, durable bars, snapshots,
  and upstream ingestion look usable before doing research.
- Runtime operations: the report is about system state and market-data freshness,
  not just a market thesis.
- Bounded reads: tools fetch compact snapshots and recent bars with strict symbol,
  timeframe, and range limits.
- Provider isolation: Operloom talks to the Swordfish product API, not to
  Massive or internal infrastructure directly.
- Auditability: workflow runs, tool calls, and generated reports land in the
  same history/artifact path as other workbench actions.

## Current Packaged Boundary

Swordfish is deliberately chat-only. Pack `baby-swordfish` version `1.2.0`
retains activation, profile, prompt, welcome, and conversation behavior while
registering no tools, workflows, triggers, connections, managed state, or
renderers. Historical `1.1.x` snapshots can still chat but are runtime
incompatible. Static health/eval evidence verifies that the parked package
continues to compile without contacting or restoring the Swordfish backend.

## Boundary

Trading, market-data adapters, order routing, admin actions, provider secrets,
infrastructure tokens, mutation tools, and private data are out of scope while
Swordfish remains parked.
