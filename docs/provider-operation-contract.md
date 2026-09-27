# Provider Operation Contract

Document status: additive Runtime Module v2 implementation in progress. Hosted
acceptance is required before enabling provider operations in production.

## Implementation decisions

External action bindings declare a named `providerOperation` instead of an
executable action callback. The approved preview is the operation input; the
server derives scope and idempotency identity from the canonical proposal.
Packages cannot supply a URL, authentication headers, credentials or a different
proposal through this interface. The existing v1 callback contract stays intact.

The broker stores dispatch receipts and validated outcomes in platform-owned D1
records before the action projection. Existing action rows combine dispatch and
application projection, so they cannot independently recover a failed projection.
The new receipts use the same D1 transactional authority and lifecycle boundaries;
no additional service or package-owned SQL is needed. A dispatch receipt is never
automatically reclaimed for another mutation. Uncertain requests require a
registered read-only reconciliation operation.

If admission failed before a receipt existed, recovery proves absence and fences
the exact proposal version in one D1 transaction before recording
`dispatchStatus: "not_dispatched"`. A competing receipt aborts this transition;
reconciliation then observes that receipt. A paused old dispatcher cannot acquire
authority after the fence. The associated run remains failed because no effect
occurred. Payload retention preserves terminal reconciliation identity.

The initial non-financial provider contract allocates a bounded amount of
capacity. Two checked-in operations exercise bearer authentication and HMAC
signing against a platform-configured service. They share validated input/output
schemas and a read-only lookup by server-owned request identity. They are
reference integrations, not evidence of compatibility with unrelated providers.

## Problem

The current connection broker supports provider requests whose credentials can
be injected as bearer or `x-api-key` authentication. Some providers require a
trusted adapter to construct multiple authentication headers, sign a payload,
or use a wallet key. Exposing that credential to Agent Pack or generic Fly code
would break the workbench custody boundary.

Polymarket is the reference pressure: public market data fits normal read-only
tools, while authenticated order creation requires provider-specific signing.

## Boundary

The conceptual operation envelope is shown below. The implemented mutation seam
is declarative `action.providerOperation`: the broker derives this envelope from
the approved proposal. A general callable `ConnectionPort.operate` is not exposed.

```ts
type ProviderOperationRequest = {
  connectionId: string;
  operation: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
};

type ProviderOperationResult = {
  status: "succeeded" | "failed" | "outcome_unknown";
  summary: string;
  externalReference?: string;
  output?: Record<string, unknown>;
};
```

The operation implementation is platform-reviewed and provider-specific. It
runs inside a credential-isolated broker boundary and may:

1. resolve the workspace connection and current Vault version;
2. verify workspace, pack, tool, run, proposal, and tool-call scope;
3. validate the named operation against a checked-in provider registry;
4. read the credential without returning it;
5. build authentication headers or sign the bounded payload;
6. dispatch only to the registered host and method;
7. redact and schema-check the result;
8. append provider reference and outcome evidence through the action lifecycle.

The generic Runtime Module receives only the redacted result. The Fly envelope,
callback body, artifact, audit payload, runtime trace, and model context never
contain signing material.

## Provider Declaration

A provider module declares:

- provider and operation ids;
- input and output JSON Schemas;
- allowed connection credential classes;
- allowed hosts and HTTP methods;
- timeout and response-size ceilings;
- whether idempotency is required;
- whether an ambiguous outcome is possible;
- reconciliation operation, when ambiguity is possible;
- redaction fields and safe operational metadata;
- health and deterministic test adapters.

Agent Packs can reference operations but cannot register new credential handlers
at runtime or grant themselves authority.

## Polymancer Mapping

A future reviewed provider module could expose:

```text
polymarket.credentials.derive
polymarket.balance.read
polymarket.orders.read
polymarket.order.preview
polymarket.order.submit
polymarket.order.cancel
polymarket.order.reconcile
```

The product must choose its wallet model before implementing these operations:
user-confirmed signing, a narrowly funded delegated wallet, or custodial key
storage. The workbench must not infer that decision from an Agent Pack.

## Non-Goals

- No general remote-code or provider-plugin installation.
- No raw secret-returning API.
- No signing inside model or browser code.
- No credentials in ordinary runner inputs.
- No automatic retry after `outcome_unknown`.
- No claim that cancellation reverses an accepted external action.

## Acceptance criteria

Before adding the runtime API, write provider-neutral tests proving:

- packages cannot select a different workspace, connection, tool, or host;
- unauthorized operation ids fail closed;
- credential material cannot enter result or observability payloads;
- idempotent duplicate submission dispatches externally once;
- timeout after dispatch becomes `outcome_unknown`;
- reconciliation is required before operator retry;
- revocation and every applicable kill switch block new dispatch;
- cross-tenant operation lookup returns `404`.

## Capacity service protocol v1

The deployment configures `capacity-service` (bearer) or
`signed-capacity-service` (HMAC) through the existing provider registry.
`actionUrl` must be HTTPS, belong to `permittedHosts`, end in `/allocations`, and
have no userinfo, query or fragment. Local fixture HTTP requires explicit E2E
mode. Packages cannot override it. Both operations require an API-key credential.

- `capacity.allocate@1` uses bearer authentication.
- `capacity.allocate-signed@1` signs with HMAC-SHA-256.
- POST input is `{ resource, units }`; units are an integer from 1 to 1,000,000.
- `idempotency-key` is the platform-generated request identity. A service must
  bind that identity to one body and return the same external resource on replay.
- Signed requests contain `x-capacity-timestamp` and a lowercase hexadecimal
  `x-capacity-signature`. Sign the UTF-8 concatenation of method, absolute URL,
  lowercase SHA-256 body digest, request identity and timestamp, separated by
  newlines. The service must verify the signature and timestamp freshness.
- A successful JSON response supplies matching `requestId`, bounded `resourceId`
  and `lifecycle` (`pending`, `active` or `rejected`). Extra response fields are
  discarded. Allowed fields containing credential material are rejected.
- Reconciliation uses GET `/allocations/<requestId>` with the same authentication
  scheme; 404 or other unconfirmed responses preserve uncertainty. It never POSTs.
- Responses are bounded to 64 KiB and calls to five seconds or the lower action
  timeout. Redirects are not followed. Transport/schema errors produce uncertainty.

An accepted pending resource is not proof that its lifecycle has completed.
Read-only reconciliation may run after review expiry, but still requires current
workspace administration and the pinned provider configuration and credential
version. Cached terminal outcomes can repair projection without credential access.
Changing an operation's signing/response semantics requires a new registry version.
Resolved receipt payloads follow retention; unresolved receipts remain available
for recovery. Export omits credential references, and workspace deletion removes
receipts without attempting to reverse external effects.

## Local native acceptance

`pnpm conformance:provider-operations` starts an isolated supervised Worker/D1 and
a local HTTP capacity service. The conformance-only package is registered through
the normal package compiler, with no registry or Fetch mocks. The service verifies
bearer credentials and HMAC independently. The public API/Fetch client journey
asserts four effects, concurrent approval admission, one GET after a lost response,
projection repair without provider requests, redacted receipt inspection/export,
quarantine/recovery and populated receipt deletion. The package also passes the
SDK external archive consumer path.

SQLite concurrency tests additionally exercise both orderings of the no-dispatch
recovery race and all admission kill switches. These local results do not prove
hosted interruption behavior, ongoing observation of pending resources, domain
resource reservations or state projection. Hosted provider operations stay off.

The implementation uses [D1 transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/)
and [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).
