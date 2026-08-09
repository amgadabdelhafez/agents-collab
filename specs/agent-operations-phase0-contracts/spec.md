# Agent Operations Phase 0A: Executable Contracts

## Objective

Create an additive, engine-neutral TypeScript contract layer for the future
Agent Operations Control Plane. The layer gives portfolio, project, shift,
work-item, incident, assignment, artifact, command, and event data stable IDs,
schema versions, runtime validation, and machine-readable rejection reasons.

## Why this slice comes first

Current loops, supervisors, backlog records, bridge delivery, and Governess
state use several overlapping conventions. Installing a workflow engine or
message broker before their shared contract is executable would move ambiguity
into new infrastructure. This slice establishes the boundary while the current
harness remains authoritative.

## Scope

- Add a cohesive contract module under `loop-fork/src/control-plane/`.
- Define branded or structurally distinct identifiers for portfolio, project,
  shift, work item, workflow execution, assignment, incident, artifact, command,
  and event records.
- Define schema-versioned record shapes for the Phase 0A entities.
- Define a CloudEvents-compatible command/event envelope carrying lane,
  project, source, subject, type, time, correlation, causation, idempotency,
  provenance, authority, and payload fields.
- Provide deterministic runtime validators that return structured success or
  rejection results without throwing on untrusted input.
- Reject missing identity, malformed IDs/timestamps, unsupported schema
  versions, and declared lane/project mismatches fail closed.
- Add one focused test file covering a valid round-trip and the high-risk
  cross-lane rejection.
- Document the exported contract surface and its versioning rules.

## Explicitly out of scope

- Installing or selecting Temporal, Restate, NATS, Postgres, or Graphiti.
- Publishing, consuming, replaying, or persisting live events.
- Changing bridge, xchan, Governess, tmux, supervisor, memory, or World Model
  runtime behavior.
- Editing the installed-harness defect backlog beyond independent maintenance
  performed outside this worktree.
- Changing the global executable, merging, deploying, or pushing a remote.
- Resolving any founder decision that is still open in the architecture draft.

## Safety invariants

- Existing product and harness loops remain authoritative and uninterrupted.
- This worktree uses its own tmux socket and session.
- The new module has no side effects and no dependency on a live broker or
  workflow service.
- Existing source behavior and public CLI behavior remain byte-for-byte
  unaffected outside the additive import graph needed to typecheck the module.
- Review is zero-write; the governed loop stops after a clean scoped commit and
  `eval.json` for independent root review.

## Acceptance outcome

At completion, callers can validate a core management record or command/event
envelope and receive either a typed value or a stable list of machine-readable
rejection reasons. A declared lane mismatch is rejected by executable evidence.
No live loop or installed executable is changed.
