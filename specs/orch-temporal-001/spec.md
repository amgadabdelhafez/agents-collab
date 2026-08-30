# Spec: Temporal WorkflowPort adapter

## Problem

The engine-neutral workflow contract and frozen replay corpus now exist, but no
distributed workflow engine has demonstrated those semantics. Temporal is the
presumptive engine and must pass the exact corpus without changing fixtures,
expected observations, or canonical workflow types.

## Goal

Implement a Temporal TypeScript SDK adapter for `WorkflowPort` and execute the
frozen `SupervisorMessage` corpus against a real ephemeral Temporal server and
worker. Prove command idempotency, durable state across worker restarts, replay
under a new worker build identity, deterministic clock input, exact normalized
observations, and safe teardown.

## Non-goals

- Provision Temporal Cloud or production infrastructure.
- Select Temporal before the DBOS comparison.
- Change the frozen replay fixtures or their expected digests.
- Put Temporal SDK types into `WorkflowPort`, `SupervisorMessage`, or Harness
  contracts.
- Route live supervisor traffic in this slice.

## Acceptance criteria

- [x] Temporal packages are exact-version dependencies and no unrelated
      dependency changes occur.
- [x] A Temporal workflow owns canonical workflow state, revision, immutable
      history, and command receipts using JSON-safe representations.
- [x] `TemporalWorkflowPort` implements start, signal, query, cancel, and inspect
      without exposing Temporal types through its public methods.
- [x] Duplicate start and request IDs preserve identity, revision, history, and
      receipts exactly as the reference adapter does.
- [x] The adapter waits for durable signal application before returning a
      receipt and fails closed on bounded observation timeout or Temporal error.
- [x] The replay runtime uses an actual ephemeral Temporal server and worker,
      restarts the worker while preserving server state, and replaces it with a
      distinct build identity at the upgrade boundary.
- [x] The unchanged six-case corpus matches every frozen per-case digest and the
      frozen aggregate digest.
- [x] Tests prove no fixture mutation and no Temporal/DBOS type leakage into the
      canonical port, workflow, or fixture modules.
- [x] Teardown closes workers, clients, and ephemeral server resources even when
      a case fails.

## Exit condition

One exact committed candidate passes the unchanged replay corpus on a real
Temporal test server, focused/full/static gates, and independent zero-write
review. Selection remains deferred until DBOS runs the same corpus.
