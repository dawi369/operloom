# Service Desk

A conformance example for the bundled provider adapters in
`@operloom/agent-sdk/providers`. It binds a calendar read (Google Calendar
adapter) and a transactional email send (reviewed provider operation) without
writing HTTP code; hosts, client ids and credentials come from the
environment's connection provider configuration.

- `service-desk.agenda` lists events through the broker. With no calendar
  connected it returns the recorded sample and marks the result
  `source: "recorded"`.
- `service-desk.confirm` proposes an email; it is sent only after operator
  approval, and `simulate` returns a provider-shaped receipt under the
  simulation effect target.

Registered as conformance-only in `workbench.config.ts`.
