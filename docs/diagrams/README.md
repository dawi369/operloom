# Architecture Diagrams

The git-tracked Mermaid files are the source of truth for topology diagrams.
Excalidraw is the manual visual rendering: paste the Mermaid source into
Excalidraw's Mermaid import, then arrange or polish the editable result.

Do not reintroduce generated diagram explorers or a TypeScript graph database
for architecture diagrams. The useful invariant is smaller: keep reviewed
Mermaid topology in this directory and keep the evidence brief beside it.

## Current Diagrams

| Diagram                            | Mermaid source                                         | Brief                                                 |
| ---------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| Current implementation topology    | `docs/diagrams/current-implementation-topology.mmd`    | `docs/diagrams/operloom-overview.md`                  |
| North-star implementation topology | `docs/diagrams/north-star-implementation-topology.mmd` | `docs/diagrams/north-star-production-architecture.md` |

## How To Use This

Use this workflow whenever you want to create or update an architecture diagram:

1. Review the brief's source evidence before changing topology. The brief names
   the docs, code seams, and assumptions that justify the diagram.
2. Update the matching `.mmd` file first. Keep it as topology: ownership
   boundaries, handoffs, trust boundaries, policy gates, execution paths, and
   storage responsibilities.
3. Preserve the four primary pillars: Vercel/frontend, Cloudflare/Worker, Fly.io
   LangGraph execution, and durable data. Keep external systems as a sidecar.
4. Keep edge labels typed and meaningful, such as `request`, `trusted scope`,
   `policy decision`, `signed work`, `progress callback`, and `canonical write`.
5. Paste the Mermaid source into Excalidraw's Mermaid import when a visual
   rendering is needed. The Excalidraw canvas is an artifact, not the canonical
   source.
6. Put dense rationale, source links, and ambiguity in the brief. Keep Mermaid
   labels short enough to survive Excalidraw import.
7. Run `pnpm typecheck`, a stale-reference `rg` if diagram ownership changed,
   and a scoped format check for touched docs.

The important rule: do not treat an Excalidraw canvas as the only source of
truth. The tracked Mermaid source is reproducible; Excalidraw is where the
diagram gets polished for presentation.

## Update Workflow

1. Review the source docs and files listed in the diagram brief.
2. Update the Mermaid source and the brief together when topology changes.
3. Paste the Mermaid source into Excalidraw only after the repo source is
   correct.
4. Run the narrow docs/code checks that match the change.

## Update Triggers

Review the relevant Mermaid source and brief when a change alters:

- runtime boundaries between Next.js, LangGraph, Cloudflare, Fly, or provider
  services
- request flow through `/api`, external signals, threads, runs, interrupts, or
  workflow escalation
- tenant scope, policy enforcement, tool exposure, or secret custody
- durable state ownership across data-client contracts, D1, R2, Durable Objects,
  workflow checkpoints, audit records, artifacts, or run records
- deployment topology or the meaning of current versus target/planned systems

## Review Checklist

- The brief names the source docs/files used as evidence.
- The Mermaid source separates current implementation from target/planned
  architecture.
- The diagram uses the four primary pillars and no more than one external
  sidecar cluster.
- Labels use real repo/runtime names, not generic placeholders.
- Arrows show meaningful direction or ownership.
- Dense evidence stays in the brief, not in Mermaid node labels.
- The Excalidraw rendering is produced by pasting tracked Mermaid source, not by
  generated HTML or a TypeScript graph pipeline.
