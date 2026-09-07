# ADR-0001: Local-First Development With Fly Staging

Status: accepted

## Context

Operloom needs fast frontend iteration and a realistic hosted runtime for agent workflows. Agent projects also need stable URLs, runtime secrets, logs, scheduled work, and external callbacks.

## Decision

Develop and test locally first. Use Fly.io as a hosted dev/staging runtime after feature slices. Do not use Fly as the primary editing environment unless local development becomes a real blocker.

## Consequences

- UI work stays fast on the local machine.
- Hosted smoke tests can validate Linux/runtime behavior, HTTPS, secrets, health checks, and external signals.
- Fly Machines are not treated as durable storage by default.
- The first deployment ran Next and LangGraph together for simplicity.
- The active hosted dev topology now splits Vercel frontend, Cloudflare run control, and Fly LangGraph/executor runtime.
- Fly Machines are an execution/runtime surface, not the durable control-plane owner.
