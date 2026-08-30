# Spec: Deterministic workflow replay corpus

## Problem

Temporal and DBOS cannot be compared fairly unless both adapters execute the
same engine-neutral commands, interruption boundaries, clock movements, and
expected observations. Unit tests written separately for each engine would
allow their behavior to drift while still appearing green.

## Goal

Provide a data-defined, deterministic `SupervisorMessage` replay corpus and a
single runner that can execute unchanged against the reference adapter,
Temporal, and DBOS. The corpus must expose behavioral divergence in workflow
identity, command idempotency, durable state, history, delivery identity,
terminal behavior, and safe projections.

## Non-goals

- Implement Temporal or DBOS adapters.
- Select an orchestration engine.
- Provision an orchestration service or database.
- Replace the current supervisor bridge transport.
- Put engine-specific state or types into `WorkflowPort`.

## Acceptance criteria

- [x] Fixture definitions are inert JSON-safe data and contain no executable
      callbacks or engine-specific values.
- [x] One runner executes every fixture through `WorkflowPort` and the existing
      `SupervisorMessageCoordinator`.
- [x] Runtime seams cover deterministic clock movement, worker restart, worker
      upgrade, delivery outcomes, and recorded delivery requests without
      expanding the canonical `WorkflowPort`.
- [x] The corpus directly covers duplicate receive, duplicate commands, worker
      crash/restart, delayed claim escalation, cancellation replay, transient
      retry, retry exhaustion, and worker upgrade.
- [x] Every case asserts final projection, execution status, revision/history,
      event sequence, delivery count, and stable delivery idempotency keys.
- [x] Every case produces a canonical structural digest so engine adapters can
      compare exact observations rather than green test counts.
- [x] Replaying the complete corpus twice against fresh runtimes yields
      identical per-case digests and one identical aggregate digest.
- [x] Projections and recorded corpus observations contain no message body or
      local filesystem paths.
- [x] Focused tests fail closed when a runtime loses durable state, duplicates a
      delivery, changes a terminal state, or returns a mismatched observation.

## Exit condition

The reference adapter passes the entire corpus twice with identical digests.
Those fixture definitions and expected digests then become the mandatory input
for `ORCH-TEMPORAL-001` and `ORCH-DBOS-001`.
