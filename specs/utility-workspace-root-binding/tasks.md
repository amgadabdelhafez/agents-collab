# Tasks: Explicit Utility Workspace Binding

## Checklist

- [x] **T-01 Request contract** — Persist and advertise optional `workspace_root`.
- [x] **T-02 Verified resolution** — Bind relative packet paths to an exact verified
      root and classify failures accurately.
- [x] **T-03 Regression proof** — Cover routing, rejection, request identity, and a
      guarded new-file patch in tests.
- [ ] **T-04 Release evidence** — Record focused/full verification, independent
      review, build, smoke, and preflight evidence.

## Task detail

### T-01 — Request contract

**Goal:** Callers can name one intended registered workspace without long absolute
scope lists.
**Files:** `loop-fork/src/loop/task-router.ts`,
`loop-fork/src/loop/bridge-utility.ts`, matching tests.
**Inputs:** `spec.md`, existing `route_task` schema and request factory.
**Output:** Persisted optional `workspaceRoot` included in deterministic request
identity and explicit bridge guidance.
**Done when:** schema, parsing, normalization, and round-trip tests pass.

### T-02 — Verified resolution

**Goal:** Relative scopes bind only beneath the exact requested verified root.
**Files:** `loop-fork/src/loop/utility-workspace.ts`,
`loop-fork/src/loop/utility-runtime.ts`, matching tests.
**Inputs:** existing Git worktree verifier and exact edit-scope rules.
**Output:** verified workspace decision or actionable `workspace-unverified` route.
**Done when:** registered roots pass; aliases, unrelated roots, mixed/absolute scopes,
directory writes, and symlink escapes fail without worker spawn.

### T-03 — Regression proof

**Goal:** Prove the run-102 failure and the new-file write path cannot recur.
**Files:** `loop-fork/tests/loop/utility-workspace.test.ts`,
`loop-fork/tests/loop/bridge*.test.ts`,
`loop-fork/tests/loop/utility-tools.test.ts`.
**Inputs:** run-102-shaped relative packet and existing guarded apply APIs.
**Output:** focused regression tests and Harness verification records.
**Done when:** linked root routes safely, omission fails actionably for the replay,
new file is created only in the linked worktree, and preimage drift fails closed.

### T-04 — Release evidence

**Goal:** Produce evidence sufficient for a binary deployment decision.
**Files:** `loop-fork/runs/utility-workspace-root-binding/`.
**Inputs:** `verify.md`, repository verification commands.
**Output:** `eval.json`, review verdict, build/smoke/preflight logs.
**Done when:** all checks pass, baseline failures are empty, and an independent
reviewer concurs on the exact candidate commit.
