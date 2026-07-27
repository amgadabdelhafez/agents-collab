# Tasks: Governess Codex Usage Refresh

## Checklist

- [x] **T-01** Refresh manifest-backed agent session bindings each tick.
- [x] **T-02** Add focused regressions for late/change/missing manifest states.
- [x] **T-03** Verify, independently evaluate, build, and deploy narrowly.

## Task detail

### T-01 — Refresh live bindings

**Goal:** A running governess adopts the current Claude/Codex session references.
**Files:** `loop-fork/src/loop/governess.ts`
**Inputs:** `spec.md`, current run manifest contract.
**Output:** Implementation evidence in `runs/governess-codex-usage-refresh/`.
**Done when:**
- [x] Refresh occurs before usage is read.
- [x] Known-good bindings survive transient manifest failures.

### T-02 — Regression coverage

**Goal:** Deterministically reproduce and prevent stale Codex bindings.
**Files:** `loop-fork/tests/loop/governess.test.ts`
**Done when:**
- [x] Initial, late, changed, empty, and malformed cases pass.

### T-03 — Verify and deploy

**Goal:** Prove the fix offline and in live run 50.
**Files:** `runs/governess-codex-usage-refresh/eval.json`
**Done when:**
- [x] Focused/full/build/verify checks pass or unrelated baselines are isolated.
- [x] Independent evaluator returns PASS.
- [x] Only the governess pane is replaced and Codex metrics populate.
