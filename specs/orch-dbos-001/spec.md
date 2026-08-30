# Spec: DBOS WorkflowPort adapter

## Problem

Temporal has passed the frozen `SupervisorMessage` replay corpus, but the
required DBOS comparison has not. Engine selection would be unsupported until
DBOS executes the identical fixtures and normalized observations on its real
durable runtime.

## Goal

Implement a DBOS TypeScript SDK adapter for `WorkflowPort` and execute the
unchanged frozen six-case corpus against a real DBOS runtime backed by an
isolated PostgreSQL database. Prove stable workflow IDs, idempotent commands,
same-version recovery, the exact behavior at a distinct application-version
boundary, normalized observations, and complete teardown. A reproducible
engine-level refusal is valid comparison evidence and must not be hidden behind
a same-version relaunch mislabeled as an upgrade.

## Non-goals

- Select DBOS or Temporal in this slice.
- Change the frozen corpus, expected observations, or aggregate digest.
- Provision DBOS Cloud or persistent production infrastructure.
- Put DBOS SDK types into canonical workflow or Harness contracts.
- Route live supervisor traffic.

## Acceptance criteria

- [x] `@dbos-inc/dbos-sdk` is pinned to one exact stable version.
- [x] Tests use a real DBOS runtime and isolated PostgreSQL database, not a
      mocked SDK or in-memory reference adapter.
- [x] A registered DBOS workflow durably owns canonical state, immutable
      history, command receipts, and JSON-safe public observations.
- [x] `DbosWorkflowPort` implements the engine-neutral public port without SDK
      type leakage.
- [x] Duplicate starts and request IDs preserve canonical identity, revision,
      history, receipts, and delivery count.
- [x] Every command is durably accepted before the adapter returns, and bounded
      observation fails closed.
- [x] Restart terminates and relaunches a real DBOS worker process over the same database and stable
      executor identity; upgrade uses the distinct version named by the frozen
      fixture and records whether DBOS lawfully recovers or refuses the pending
      prior-version workflow.
- [x] Every fixture before an engine-level refusal matches its exact expected
      digest. If all six pass, require aggregate digest
      `5f1bd79af5217d60339a50996d6f3bc04c6f745e9a0c2a832d09cfe0caf8abdd`;
      otherwise require the exact failing fixture, pending workflow status,
      stored prior application version, current application version, and
      bounded command timeout.
- [x] Canonical modules contain no DBOS or Temporal SDK imports.
- [x] Teardown terminates the isolated DBOS worker and PostgreSQL runtime after success or
      failure.

## Exit condition

One exact committed comparison candidate passes focused, full, static, and
independent zero-write review gates. The result may be conformance or a proven
engine incompatibility. Engine selection remains a separate next slice.
