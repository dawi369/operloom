# Mobile — WIP / future work

The Expo iOS/Android app is preserved on
[`codex/mobile-wip`](https://github.com/dawi369/operloom/tree/codex/mobile-wip).
That branch includes its source, native configuration, tests, delivery scripts,
and the original mobile runbook. It retains the former Assistant-mk1 identity.

The supported main branch is web-focused. Native bundles, device acceptance,
Expo tooling, and mobile release gates are intentionally outside this release.
Do not merge the snapshot wholesale: port the app onto current client contracts
when native development resumes.

The framework-neutral client, React resource layer, bearer authentication,
server notification contracts, and existing database migrations remain in main.
They are shared backend capabilities; removing them would break compatibility
without making the web application simpler. See [Frontend Integration](frontend-integration.md).

Resuming mobile requires current native dependencies, device-tested WorkOS
sign-in, send/reconnect/recovery journeys, and iOS/Android evidence from the same
commit. A successful JavaScript bundle alone is not device acceptance.
