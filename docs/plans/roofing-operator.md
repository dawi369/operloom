# Plan: Roofing operator on Operloom

A fork where several agents run a roofing business autonomously inside one
workspace: they talk to clients over email and calendar, watch weather, news
and permits, scout territory on maps, and keep job and client records, with
approval posture configured per action type. Capability ids refer to
[capabilities](../capabilities.md).

## Shape of the product

One workspace, one owner (the business), several pack-backed agents (C6):

| Agent     | Loop                                                                                                                 | Reads                             | Effects                             |
| --------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------- |
| Intake    | Webhook on each lead form or inbound email (C12) → qualify → propose first reply and a site visit slot.              | Mailbox read, calendar read (C18) | Email send, calendar write (C23)    |
| Follow-up | Monitor over open jobs (C11): quotes unanswered, visits due, invoices late → propose the next message.               | Job records (C2)                  | Email send                          |
| Watcher   | Monitor over weather, storm and permit feeds (C11, C15, C18) → fingerprint change → open a lead list for a hit area. | News/weather, public records      | Job and lead records                |
| Scout     | Monitor or user workflow: geocode an area, rank properties, draft outreach.                                          | Geocoding and routing (C18)       | Lead records; outreach as proposals |

Reads with an API stay inline on Cloudflare. Permit portals, assessor sites
and map renders without one are runner tools in each pack's `runner.ts`
(C33, W11): a headless browser or process step dispatched by the workflow
under a signed envelope, with the result back as bounded evidence or an
artifact.

Client, job, lead and quote records are namespaced managed state (C2) with
queries for the console. Every outbound message is an action proposal (C20);
policy (C21) decides which run unattended: for example first replies to
known templates auto-send within a daily count, anything with a price or a
commitment waits for a human.

The owner uses the web console (C28) today and the mobile shell (C30) with
push (C26) later.

## Platform work, in order

| Step   | Workstream                       | Why this product needs it                                                                                                                                                              |
| ------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | W1 Open provider operations      | Email send, calendar write and record writes as declared effects with receipts. Nothing else below works without it.                                                                   |
| 2      | W4 Bundled connection providers  | Mailbox read and send (OAuth), calendar read/write, geocoding and routing, news and weather search, transactional email.                                                               |
| 3      | W2 `policy_controlled` approvals | Auto-send within limits, human review otherwise, review queue for what ran. The core of "configurable per action type".                                                                |
| 4      | W3 Notification channels         | The owner is told by push or email when a proposal waits or a storm hits.                                                                                                              |
| 5      | W5 Agent delegation              | Watcher hands a hit area to Scout; Intake hands a qualified lead to Follow-up. Until then, agents coordinate through shared records and monitors, which is enough for a first version. |
| 6      | W6 Pack chat renderers           | Job, lead and quote cards inline.                                                                                                                                                      |
| 7      | W10 Mobile shell                 | Owner approves from the phone.                                                                                                                                                         |
| 8      | W8 Billing                       | Only if this becomes a multi-tenant offering rather than one business.                                                                                                                 |
| with 2 | W11 Runner recipes               | Browser recipe for permit and assessor portals, process recipe for map rendering and document OCR; Watcher and Scout use them from `runner.ts`.                                        |

W7 (MCP) and W9 (financial custody) are not needed.

## Fork work

- Four packs, each from `pnpm agent-packs:create`, sharing one state namespace
  per record type and a common `card.ts` for renderers.
- Connection descriptors per pack; the workspace owner authorizes mailbox,
  calendar and maps once through the broker (C17).
- Triggers declared but disabled; Intake installs its webhook and Watcher its
  monitors through `context.triggers.ensure` when the owner turns a feed on.
- Settings per agent: templates allowed to auto-send, daily send cap, quiet
  hours, service area polygon, storm thresholds.
- Runner tools (portal scraping, map renders, document OCR) in each pack's
  `runner.ts` on the W11 recipes; declared like any tool, so policy, budgets
  and history apply unchanged, and the packs still run when the runner is down.
- Simulation first: every effect binding has `simulate`; the fork runs the
  whole loop under the `simulation` target before any connection is
  authorized.
- Tests: domain logic pure and unit-tested; the four-agent loop on
  `createPackTestRuntime`; one acceptance pass with recorded provider
  fixtures.

## Decisions to take

- Which email account sends (the business's own by OAuth, or a transactional
  sender with a reply-to inbox) is fork-time configuration; both are covered
  by W4.
- Which action types auto-run on day one. Default: none; turn on per template
  after a week of reviewed proposals.

## Gates

Operloom's standard gates for platform work; for the fork, `verify:fast`,
`conformance:agent-system` with four agents, and a browser acceptance pass of
intake → proposal → approval → sent (simulated) → record updated.
