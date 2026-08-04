# Tasks: Utility Task Admission

## Checklist

- [x] **T-01** Add fail-closed work-shape routing to `task-router.ts`.
- [x] **T-02** Enforce work shape at every source producer and in guidance.
- [x] **T-03** Add pure and producer-backed regression coverage.
- [ ] **T-04** Verify, record eval evidence, commit, and request exact-SHA review.

## Task detail

### T-01 — Durable admission fact

**Goal:** Persist normalized work shape and reject non-separable utility work.
**Files:** `loop-fork/src/loop/task-router.ts`
**Done when:** Pure router tables prove all three shapes and legacy absence.

### T-02 — Producer enforcement

**Goal:** Require explicit bridge input and mark trusted hook requests.
**Files:** `bridge-utility.ts`, `hooks/emit.ts`, `bridge-guidance.ts`
**Done when:** No production request producer relies on an implicit separable
default.

### T-03 — Regression coverage

**Goal:** Exercise the public bridge producer and existing route gates.
**Files:** `tests/loop/task-router.test.ts`, `tests/loop/bridge.test.ts`,
`tests/loop/bridge-guidance.test.ts`
**Done when:** Missing/invalid input is rejected and valid separable work is
persisted and routed correctly.

### T-04 — Evidence and review

**Goal:** Produce replayable verification and independent evaluation.
**Files:** `runs/utility-task-admission/**`
**Done when:** Required commands pass, `eval.json` is independently authored,
and the committed exact SHA is sent to the supervisor for review.
