# Agent Operations Phase 0B: Management State

## Objective

Extend the reviewed Phase 0A contracts with pure, engine-neutral management
semantics for legal lifecycle transitions, dependencies, WIP admission,
priority and severity, deadline escalation, portfolio-local shifts, and
acknowledged handoffs.

## Founder decisions

- The slice is approved as shadow-only, service-free, and non-authoritative.
- `America/Los_Angeles` is the configurable default portfolio timezone.
- The living architecture and synchronized handover record the approval on
  `codex/agent-operations-redesign` at `f585a61` and the later Evaluation and
  Optimization Plane direction at `4b3eebd`.

## Scope

- Define legal state transitions for work items, assignments, incidents,
  reviews, and releases.
- Reject illegal transitions, blocked dependencies, full WIP admission, and
  missing release approval with stable machine-readable reasons.
- Define ordered `P0` through `P4` priorities and `SEV0` through `SEV3`
  incident severities.
- Define warning, escalation, due, and overdue deadline semantics without
  mutating workflow state.
- Resolve `00:00`, `08:00`, and `16:00` shift windows in an IANA portfolio
  timezone, defaulting to `America/Los_Angeles` and handling offset changes by
  local civil time.
- Define retrospective and acknowledged handoff records that explicitly
  preserve worker process continuity.
- Add one focused executable test file covering legal behavior and the
  highest-risk fail-closed paths.

## Explicitly out of scope

- Installing or selecting Temporal, Restate, NATS, PostgreSQL, Braintrust, or
  another service.
- Implementing the Evaluation and Optimization Plane or Phase 0C adapter.
- Reading, publishing, persisting, or controlling live runtime state.
- Editing the installed-harness defect backlog from this modernization
  worktree.
- Changing bridge, Governess, tmux, model routing, product lanes, the installed
  executable, or release authority.
- Merge, install, deploy, remote push, or policy cutover.

## Safety invariants

- The module is pure and has no external I/O or runtime import edge.
- Shift boundaries transfer management attention only; they never imply a
  worker restart, cancellation, or teardown.
- Dependency and WIP checks fail closed when required policy state is missing
  or malformed.
- Model or judge output cannot authorize a transition.
- Existing Harvto and AI-CUR lanes remain authoritative and uninterrupted.

## Acceptance outcome

A caller can evaluate a proposed management transition, deadline, shift
window, or handoff and receive either a typed deterministic result or stable
rejection reasons. Focused executable evidence proves legal transition,
dependency blocking, WIP blocking, timezone offset behavior, and acknowledged
handoff without activating a service or live adapter.
