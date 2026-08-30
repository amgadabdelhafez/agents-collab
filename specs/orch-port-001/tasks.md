# Tasks: Engine-neutral workflow port and SupervisorMessage lifecycle

## Checklist

- [x] **T-01 WorkflowPort**: add canonical commands, receipts, inspection, and
      deterministic reference adapter.
- [x] **T-02 SupervisorMessage**: add validated lifecycle transitions and safe
      projection.
- [x] **T-03 Coordinator**: route new workflows through an injected idempotent
      delivery activity and record results.
- [x] **T-04 Verification**: add focused tests, run checks, and write eval.

## Task detail

### T-01 WorkflowPort

**Goal:** An executable engine-neutral orchestration boundary exists.
**Files:** `loop-fork/src/loop/workflow-port.ts`,
`loop-fork/src/loop/in-memory-workflow-port.ts`, and focused tests.
**Inputs:** `spec.md`, `plan.md`, repository TypeScript conventions.
**Output:** Focused test output in `runs/orch-port-001/`.
**Done when:** start/signal/query/cancel/inspect and idempotency tests pass.

- [x] Complete.

### T-02 SupervisorMessage

**Goal:** The complete first-message lifecycle is deterministic and replayable.
**Files:** `loop-fork/src/loop/supervisor-message-workflow.ts` and focused tests.
**Inputs:** acceptance criteria in `spec.md`.
**Output:** Lifecycle test evidence.
**Done when:** all required transitions and refusals pass.

- [x] Complete.

### T-03 Coordinator

**Goal:** New messages route exactly once through an engine-neutral delivery
activity, while duplicates reuse their existing workflow.
**Files:** `loop-fork/src/loop/supervisor-message-coordinator.ts` and focused
tests.
**Inputs:** T-01 and T-02.
**Output:** Vertical-flow test evidence.
**Done when:** accepted and failed deliveries become deterministic workflow
state without provider-specific imports.

- [x] Complete.

### T-04 Verification

**Goal:** The slice is ready to become the oracle for `ORCH-FIXTURE-001`.
**Files:** `runs/orch-port-001/eval.json`, architecture and dependency docs.
**Inputs:** all preceding tasks.
**Output:** Named focused checks, type/check/build evidence, and exact diff.
**Done when:** every check in `verify.md` passes and eval is recorded.

- [x] Complete.
