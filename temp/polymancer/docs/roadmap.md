# Polymancer: roadmap

What ships in what order, and how each milestone proves the product is working. Decisions behind the order are on the [planning map](https://github.com/dawi369/polymancer/issues/4).

## M1: Idea loop on paper (web console)

The whole loop works end to end for one user in the web console. Milestone: **M1: Idea loop on paper**.

| Ticket                                                                                              | Delivers                                                                                       |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [#28](https://github.com/dawi369/polymancer/issues/28) Operloom: web search port with dated results | Dated, cutoff-respecting search for briefs, metered, testable offline                          |
| [#29](https://github.com/dawi369/polymancer/issues/29) Idea to claims to matched markets            | Interview into Questions with committed forecasts; Polymarket and Kalshi matches with rule fit |
| [#30](https://github.com/dawi369/polymancer/issues/30) Research, edge and paper position            | Brief, price check with the book-walk fill model, paper positions, portfolio                   |
| [#31](https://github.com/dawi369/polymancer/issues/31) Thesis watch, resolution and track record    | Watch alerts, outcome proposals and confirmation, Record                                       |

The tickets say "claim"; the product term is **Question** (see the glossary). Each ticket also builds its part of the Question card ([interface.md](interface.md)).

**Exit criteria:**

- The acceptance tests cover the loop on recorded fixtures, including replay safety and two users kept isolated.
- Maya's first session in [experience.md](experience.md#first-session) works against live venue data: Kalshi from the local console, and Polymarket from the deployed Worker (the development network blocks Polymarket; see [system.md](system.md#data-sources)).
- `verify:fast` passes.

Before any public launch, even paper-only, the written data-use permission in task #33 is required.

## M2: Reach (ChatGPT app and notifications)

- Operloom: MCP adapter (OAuth, allowlist, MCP Apps widgets), notification delivery, and pack tool-result renderers for inline chat cards.
- Polymancer:
  - the Question card widget;
  - the weekly digest and check-in;
  - watch alerts by email;
  - call cards;
  - topics onboarding.
- Submit the ChatGPT app with research and paper scope only.

**Exit:** a user can run the whole paper loop inside ChatGPT, and alerts arrive outside the app.

## M3: Business (Plus and mobile)

- Billing and entitlements (Free and Plus), research allowances and pay-per-use deep research.
- Mobile app at full parity with the web console, plus push alerts. It is built on the Operloom mobile shell over `@operloom/client` and reuses the same Question card design.
- Apply to the Polymarket builder program and the Kalshi builder grants.

**Exit:** the first paying users; Free-to-Plus conversion is measured; every web flow works on mobile.

## Later

- **Live trading** (Pro). It needs:
  - the legal read (task #26);
  - session-key and API-key custody;
  - Operloom effect operations, `policy_controlled` approvals and runner signing.

  Each trade is approved by the user. The design is in the planning map decisions on credentials and autonomy.

- **Power-user track:** tracked wallets, scored cohorts and the streaming collector, reusing the copy-trading experiment.
- **Public profiles:** opt-in collections of call cards with verified records.

## Validation before scale

The weakest assumption is that non-traders value a slow, honest record enough to come back. Test it during M1 and M2, before investing in M3:

1. Recruit 10–20 idea-holders in politics, economy and tech.
2. Over 4 weeks, measure:
   - Questions saved per user;
   - the share of price checks ending in "no edge" without drop-off;
   - returns after a watch alert;
   - digest opens;
   - whether users confirm outcomes.
3. Interview each user at the end: did the record feel worth keeping, and would they pay for more research or more Questions?

**Continue if** at least half return unprompted or from an alert in week 3 or 4, and several ask for more research. **Rethink if** usage is one-shot: then the product may be a research tool (Alphascope's lane) rather than a notebook.
