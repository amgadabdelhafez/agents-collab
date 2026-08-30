# Spec: governed SupervisorMessage delivery

## Problem

The selected Temporal adapter durably executes `SupervisorMessage`, but there is
not yet an application boundary that authorizes supervisor operations, resolves
an exact destination bridge without accepting caller-supplied paths, maps
durable delivery outcomes, and records governance receipts. The founder still
has to relay messages manually.

## Goal

Implement the governed application and delivery layer around the accepted
engine-neutral coordinator. A caller presents an exact supervisor identity and
operation. A deny-by-default authority port decides it. A trusted directory
resolves the destination supervisor to one run-owned bridge route. The delivery
activity durably enqueues into that bridge using the workflow attempt's exact
idempotency key. Every allowed or denied operation emits a body-free governance
receipt.

## Non-goals

- Provision or deploy Temporal infrastructure.
- Add a second message journal, workflow state machine, or bridge transport.
- Put credentials, local paths, message bodies, or raw transcripts in public
  projections or governance receipts.
- Accept a destination path, bridge target, authority decision, or identity
  claim from the message body.
- Implement the message board, Attention projection, KB read model, or live
  cross-supervisor rollout in this slice.

## Acceptance criteria

- [x] `GovernedSupervisorMessageService` wraps the accepted coordinator and
      authorizes `receive`, `claim`, `acknowledge`, `tick`, and `cancel` before
      any workflow or bridge mutation.
- [x] Authority is an injected deny-by-default port. Decisions bind principal,
      operation, source supervisor, destination supervisor, thread, and one
      stable grant/denial reference.
- [x] Denied or malformed operations produce no workflow, bridge, or route
      mutation and emit a body-free denied receipt.
- [x] A trusted injected directory resolves the exact destination supervisor to
      a run directory and declared local bridge target; messages never supply a
      filesystem path or local bridge target.
- [x] Bridge delivery uses existing `dispatchBridgeMessage`, exact workflow
      idempotency key, artifact references, message/thread identity, and
      work-request metadata. No parallel queue is introduced.
- [x] `delivered`, `accepted`, `queued`, and `duplicate` are accepted durable
      outcomes; `expired` and `dead-letter` are permanent failures; thrown or
      unresolved routes are transient failures.
- [x] Retries reuse the workflow's delivery-attempt idempotency key and existing
      bridge deduplication. A duplicate activity call cannot create a second
      pending bridge message.
- [x] Governance receipts expose only IDs, operation, decision, reason code,
      stable authority reference, workflow ID when known, and canonical time.
      They never expose body, local path, credentials, or raw transcript.
- [x] Public workflow projections remain unchanged and body-free.
- [x] Focused tests prove allow, deny, duplicate delivery, unresolved route,
      expired/dead-letter mapping, claim/ack authority, receipt redaction, and
      zero mutation on refusal.

## Exit condition

One exact committed candidate passes focused, full, static, diff, and
independent zero-project-write exact-SHA review. It adds implementation
authority only; live routing and deployment remain separate gates.
