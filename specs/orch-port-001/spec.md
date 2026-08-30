# Spec: Engine-neutral workflow port and SupervisorMessage lifecycle

## Problem

Supervisor-to-supervisor messages currently depend on humans or runtime-specific
bridge delivery loops. There is no canonical workflow boundary that can be run
unchanged on Temporal and DBOS, so deduplication, claims, retries, escalation,
dead-letter handling, cancellation, and Attention OS projection cannot be
replayed or compared consistently.

## Goal

Provide an engine-neutral `WorkflowPort` and a complete `SupervisorMessage`
workflow model that deterministically receives, deduplicates, persists, routes,
claims, acknowledges, retries, escalates, dead-letters, cancels, and projects a
message without importing Temporal- or DBOS-specific types.

## Non-goals

- Implement or select Temporal or DBOS.
- Provision orchestration infrastructure or credentials.
- Replace the existing bridge transport in this slice.
- Build the message-board or Attention OS UI.
- Copy message bodies into status projections.

## Background

`bridge-store.ts` already provides local durable queue primitives, but its
delivery lifecycle is tied to the Loop runtime. The shared backlog requires a
canonical workflow contract first, followed by one identical replay corpus and
then Temporal and DBOS adapters. `SupervisorMessage` is the first workflow
because eliminating manual cross-supervisor relaying is the immediate product
objective.

## User journeys

1. A supervisor submits a message once or repeatedly with the same stable
   deduplication key. One workflow is created, duplicates return its identity,
   and the intended supervisor can claim and acknowledge it.
2. A transient route failure schedules a bounded retry. An unclaimed routed
   message escalates after policy time, while repeated delivery failure reaches
   a durable dead-letter state.
3. An operator cancels a non-terminal message and can inspect immutable workflow
   history or project its status without exposing the message body or local
   paths.

## Acceptance criteria

- [x] `WorkflowPort` exposes start, signal, query, cancel, and inspect using
      engine-neutral data and errors only.
- [x] No canonical ORCH source imports Temporal or DBOS packages or types.
- [x] The reference adapter persists workflow state and immutable history for
      the lifetime of the port and deduplicates starts by workflow ID.
- [x] `SupervisorMessage` validates stable identity, sender, intended recipient,
      body, timestamps, artifact references, and bounded delivery policy.
- [x] Receive produces one persisted routed workflow; duplicate receive returns
      the existing workflow without rerouting it.
- [x] Claim is restricted to the intended supervisor and acknowledge is
      restricted to the current claimant.
- [x] Transient delivery failure schedules bounded retries; policy exhaustion
      dead-letters the message.
- [x] A deterministic clock tick escalates an unclaimed message once and does
      not duplicate escalation on replay.
- [x] Cancellation is idempotent and terminal.
- [x] The status projection contains lifecycle metadata and artifact references
      but never the message body or local filesystem paths.
- [x] Focused tests cover the happy path, duplicate receive, transient retry,
      exhaustion, delayed claim escalation, invalid claim, cancellation,
      replay, and projection redaction.

## Out-of-scope risks

The reference adapter is not a distributed engine. Temporal and DBOS adapters
must later prove durable crash recovery and worker-upgrade replay against the
same fixture corpus before either can be selected.

## Open questions

None for this slice. Provider selection remains explicitly deferred to
`ORCH-SELECT-001`.
