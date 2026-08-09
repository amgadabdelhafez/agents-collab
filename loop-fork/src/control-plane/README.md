# Agent Operations contracts

`contracts.ts` is the engine-neutral Phase 0A boundary. It has no broker,
workflow-engine, persistence, or runtime side effects.

## Exported surface

- Branded identifiers distinguish portfolio, project, lane, shift, work item,
  workflow execution, assignment, incident, artifact, command, and event IDs at
  compile time. Runtime IDs remain JSON strings and accept current slug,
  hierarchical, timestamp-derived, UUID, and ULID conventions.
- `PortfolioRecord`, `ProjectRecord`, `ShiftRecord`, `WorkItemRecord`,
  `WorkflowExecutionRecord`, `IncidentRecord`, `AssignmentRecord`, and
  `ArtifactRecord` define the Phase 0A management records.
- `CommandRecord` and `EventRecord` use CloudEvents 1.0 core fields plus the
  architecture's snake_case domain extensions.
- `validateManagementRecord` and `validateEnvelope` accept `unknown` and return
  a discriminated `ValidationResult`. Invalid input returns ordered
  `ContractRejection` entries and does not throw.
- `ValidationContext` binds envelope validation to the caller's declared lane
  and project. Mismatches return `LANE_MISMATCH` or `PROJECT_MISMATCH`.

## Versioning rules

Phase 0A accepts only `agentops/v1` records and CloudEvents `1.0` envelopes.
Adding optional fields is backward-compatible within `agentops/v1`. Removing a
field, changing its meaning, or changing validation of an accepted value needs
a new `agentops/vN` version and parallel validation support while older records
remain in use. Unknown schema or CloudEvents versions fail closed.

`management-state.ts` adds the approved Phase 0B pure management semantics:

- legal work-item, assignment, incident, review, and release transitions;
- dependency and WIP admission gates plus explicit release approval;
- ordered priority/severity definitions and deterministic deadline attention;
- configurable IANA portfolio shifts at local `00:00`, `08:00`, and `16:00`,
  defaulting to `America/Los_Angeles`;
- retrospective and acknowledged handoff records that require
  `workerContinuity: preserve`.

Both modules remain engine-neutral and side-effect free. They do not choose
workflow authority, delivery, storage, an evaluation backend, or an execution
engine, and they are not imported by the installed runtime.
