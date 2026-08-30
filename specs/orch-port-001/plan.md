# Plan: Engine-neutral workflow port and SupervisorMessage lifecycle

## Approach

Define a small JSON-safe `WorkflowPort` whose receipts and inspection records
are independent of any orchestration SDK. Add a deterministic in-memory
reference engine that persists snapshots and append-only history for the port's
lifetime, then implement `SupervisorMessage` as a registered workflow
definition plus a coordinator that invokes an abstract delivery activity.

## Sequence

1. Define canonical workflow commands, receipts, status, history, errors, and
   workflow-definition seams.
2. Implement the deterministic reference adapter with atomic per-command state
   replacement, start deduplication, idempotent signal/cancel request IDs, query,
   and inspection.
3. Define `SupervisorMessage` input, policy, state, signals, projection, and
   transition invariants.
4. Add the coordinator that starts once, routes only new workflows through an
   injected delivery port, and records delivery success or failure as signals.
5. Verify every required lifecycle branch and inspect the exact diff for engine
   leakage and body/path exposure.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Canonical payload | Recursive JSON value | Temporal and DBOS adapters can serialize it without SDK types. |
| Deduplication key | Caller-derived stable workflow ID | Both candidate engines support deterministic workflow identity. |
| Reference implementation | Deterministic in-memory engine | Gives the fixture and adapter contracts an executable oracle without selecting a production engine. |
| Side effects | Injected delivery port outside transition reducers | Pure transitions remain replayable; real delivery becomes an engine activity later. |
| Public projection | Metadata and artifact references only | Attention OS can triage without copying message bodies or leaking local paths. |

## Affected subsystems

- Orchestration contract: new engine-neutral port and reference engine.
- Supervisor communication: new message state machine and delivery activity
  boundary.
- Tests: deterministic workflow and lifecycle regression coverage.
- Architecture/dependency map: new boundary documented after behavior passes.

## Risks

- Adapter semantics diverge before the bakeoff. Mitigation: one shared port and
  an inspectable history model become the fixture oracle.
- Duplicate external delivery after a crash. Mitigation: routing receives the
  workflow ID as its idempotency identity; distributed adapters must preserve
  that activity contract.
- Status projection leaks message content. Mitigation: projection is constructed
  from an explicit metadata allowlist and tested against body/path sentinels.

## Not doing

No Temporal/DBOS imports, network calls, deployment, migration of the existing
bridge store, UI, or provider selection is included.
