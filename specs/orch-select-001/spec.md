# Spec: workflow engine selection

## Problem

The canonical `WorkflowPort`, frozen replay corpus, Temporal adapter, and DBOS
comparison adapter are independently accepted, but production implementation
must not depend on an implicit or presumptive engine choice.

## Goal

Record one evidence-bound engine selection for the durable
`SupervisorMessage` foundation. The decision must cite exact accepted closure
commits, distinguish conformance from comparison refusal, preserve the
engine-neutral port, and state the consequences and reversal boundary.

## Non-goals

- Implement `ORCH-GOV-001` or route live messages.
- Provision Temporal Cloud, DBOS Cloud, PostgreSQL, or production credentials.
- Delete the DBOS comparison adapter or weaken its evidence.
- Change the frozen replay corpus, any engine adapter, or dependency version.
- Claim that one engine is universally superior outside this contract.

## Decision requirements

- [x] Bind the reference, corpus, Temporal, and DBOS evidence by exact closure
      commit.
- [x] Require all six frozen cases, including pending-workflow recovery across
      the named application-version boundary, for the selected engine.
- [x] State that Temporal completed all six cases twice on fresh real test
      servers with the frozen aggregate digest.
- [x] State that DBOS matched the first five cases under real same-version
      process-loss recovery, then left the v1 workflow `PENDING` when only the
      named v2 worker was live and timed out the exact command.
- [x] Select Temporal for `SupervisorMessage` and explain that DBOS remains a
      comparison implementation, not a live fallback.
- [x] Preserve `WorkflowPort` as the application boundary so reversal requires
      a new accepted engine adapter and the unchanged corpus, not canonical
      workflow rewrites.
- [x] State production gates separately: deployment topology, scoped identity,
      credentials, backup/recovery, observability, and fresh deploy authority.
- [ ] Independent zero-write review confirms that the decision does not outrun
      the accepted evidence.

## Exit condition

One exact committed decision candidate passes static/diff checks and an
independent zero-write exact-SHA review. No runtime or external state changes.
