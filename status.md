# Session Status

## 2026-08-12 — D1 fresh-loop handover

Result: D1 premise reproduced and exact invariant recorded. Production fix not started.

Current state:

- Canonical task `harvto-d1-live-peer-expiry` promoted after parking passing umbrella Harness task.
- Base SHA remains `52e244b8d49258ea1768580fba2042719030d884`.
- Three governed Au Pair audits mapped bridge call graph, target liveness, tests, and blast radius.
- Named regression covers TTL and queue-depth terminalization with injected positive liveness.
- Production `loop-fork/src/loop/bridge-store.ts` remains unchanged.
- Durable proof: `loop-fork/runs/harvto-d1-live-peer-expiry/artifacts/baseline-reproduction.md`.
- D1 feature contract now exists at `loop-fork/specs/harvto-d1-live-peer-expiry/` with peer-scoped
  liveness, state transitions, journal compatibility, `maxRetained = maxOutstanding + 1`, typed
  pre-accept `backpressure`, and full acceptance commands.
- Claude cleared production patch in reply to bridge `1c929e52-f05e-4528-8beb-a2320bd14e48`,
  conditional on non-colliding status, explicit formatter output, and pane-probe fail-closed controls.

Proof/checks run:

- Existing file baseline: 8 pass, 0 fail.
- Named regression: 0 pass, 1 fail; `Expected length: 1`, `Received length: 0`.
- TTL journal contains message then `expired`; queue journal contains overflow message then
  `dead-letter` with `target queue limit 1 reached`.
- Harness preflight passes; stop-gate blocks only because unit evidence remains pending.
- `git diff -- src/loop/bridge-store.ts src/loop/bridge-dispatch.ts` is empty.
- Current tracked diff is Harness promotion metadata plus the 51-line named regression. New D1 run
  and spec directories, `PLAN.md`, and `status.md` are untracked pending completion.

Open questions:

- N4 audit confirmed no parsed `BridgeMessage` is rewritten as `kind: "message"`; optional
  `retainedReason` cannot be lost through a rewrite path.
- Helper artifact directory `.loop/` is untracked and must not be staged or committed.

Risks:

- Exact pane probing must stay lazy and memoized; two sequential 2-second-bounded tmux commands
  can add up to 4 seconds for a terminalization-eligible target.
- Existing TTL and QoS tests encode old behavior. Preserve assertions by injecting confirmed-dead
  liveness, then add live/unknown controls.
- Pressure metadata must not create a new event kind or queue-health schema change.
- First live pressure slot can priority-invert later backpressured work; spec records this accepted D1 tradeoff.

Next bounded action: review/apply scoped Au Pair proposals for `loop-fork/src/loop/tmux-control.ts`,
`loop-fork/src/loop/bridge-store.ts`, and `loop-fork/src/loop/bridge-dispatch.ts`. Then extend
`loop-fork/tests/loop/governess-p0-runtime.test.ts` with dead/unknown/ceiling/no-duplicate controls.
Do not touch Harvto, D2-D14, dependencies, remote state, or git history.

## 2026-08-12 — D1 post-fix checkpoint

Result: narrow production behavior implemented; named baseline regression now passes unchanged.

Changed scope:

- `loop-fork/src/loop/bridge-store.ts`: tri-state target resolver, lazy per-target memoization,
  optional `retainedReason`, confirmed-dead-only terminalization, retained-count ceiling, and
  typed pre-accept `backpressure`.
- `loop-fork/src/loop/tmux-control.ts`: bounded exact-pane probe; session dead/unknown, timeout,
  throw, and malformed output fail closed to unknown.
- `loop-fork/src/loop/bridge-dispatch.ts`: explicit `backpressure` status and non-queued formatter.
- `loop-fork/src/loop/governess.ts`: backpressure throws before the existing status cast.
- `loop-fork/tests/loop/tmux-control.test.ts`: 6 pass, 0 fail, including whole-server-down and
  malformed-pane controls.

Checks/results:

- Named D1 test: 1 pass, 0 fail after fix; assertions unchanged.
- `governess-p0-runtime.test.ts`: 16 pass, 0 fail, including confirmed-dead legacy controls,
  live/unknown retention, ceiling, later-dead, supersession, compatibility, and one-delivery proof.
- `bridge.test.ts`: 109 pass, 0 fail; backpressure formatter and `appendBridgeMessage` rejection
  are explicit and do not report queued success.
- `tmux-control.test.ts`: 6 pass, 0 fail.
- Generic `bunx tsc --noEmit -p tsconfig.json` reports repository-wide type debt outside the
  canonical gate. The exact documented/verify typecheck command passes with exit 0.
- `bun run check` passes across 865 files. `bun run build` passes.
- `bun run test:ci` passes all 77 serial test files. `scripts/verify.sh
  harvto-d1-live-peer-expiry harvto-d1-live-peer-expiry` passes through the empty baseline
  allowlist. Harness preflight and stop-gate both pass.

Risks/open work:

- Default manifest evidence composition and reconstructed-journal one-delivery behavior now have
  passing focused controls.
- Claude decision remains pending on whether Utility-runtime's redundant post-transition bridge
  notifications need explicit backpressure handling; route decisions are durably transitioned
  before those sends.
- `.loop/` helper artifacts remain untracked and must never be staged.

Next bounded action: settle Utility-runtime scope with Claude, prove D1-only diff containment, commit
explicit paths, and request exact-SHA zero-write review. Do not touch Harvto, D2-D14, dependencies,
remote state, or git history.

## 2026-08-12 — D1 exact-SHA review requested

Result: explicit-path D1 commit created and sent for zero-write peer review.

- Base: `52e244b8d49258ea1768580fba2042719030d884`.
- Commit: `bcabd31b551f3adbf5dbeccd39439a6a84edfe1d`.
- Review request: bridge `ba1ee254-7043-4291-b179-fb2140a50d31`, no TTL, exact base/head and
  32 committed paths supplied.
- Pre-commit proof: no unstaged tracked diff; no Harvto or D2-D14 path; only D1 matrix hunk;
  normal/ignore-space numstats identical; `git diff --cached --check` passed.
- Post-commit status before this evidence refresh contained only untracked `.loop/` helper artifacts.

Next bounded action: wait for Claude `PASS` or `REVISE`. On `REVISE`, fix D1 only and rerun gates.
On `PASS`, record verdict and bridge ID, then stop without merge, rebase, push, or deploy.

## 2026-08-12 — D1 exact-SHA review superseded

Result: post-commit utility audit found one fail-closed defect; old review SHA must not pass.

- Superseded commit: `bcabd31b551f3adbf5dbeccd39439a6a84edfe1d`.
- Finding: `tmuxPaneLiveness` classified every nonzero pane-probe exit as `dead` after a live
  session check. A nonzero probe failure does not positively prove pane death and could
  terminalize retained live/unknown-peer messages.
- Decision: nonzero pane-probe exit is `unknown`; only successful exact parsed
  `pane_dead=1` evidence is `dead`.
- Claude supersession notice: bridge `216fbb8d-9ddd-42b5-9d64-1a8033909ef0`.
- Scoped edit task: `170c3bf1-01d9-4d27-9b1d-8cdc4b29e608`; only
  `loop-fork/src/loop/tmux-control.ts` and `loop-fork/tests/loop/tmux-control.test.ts`.

Next bounded action: review and apply the scoped correction, rerun focused and required full
gates, create a replacement explicit-path commit, then request a new exact-SHA Claude verdict.

## 2026-08-12 — D1 fail-closed correction verified

Result: nonzero pane-probe exits now remain `unknown`; replacement verification is green.

- Source: only successful exact pane output with `pane_dead=1` proves dead. Nonzero exit, timeout,
  throw, malformed output, and session/pane mismatch remain unknown.
- Focused tmux test: 6 pass, 0 fail, 21 expectations. Named D1 regression: 1 pass, 0 fail.
- `bun run check`, canonical typecheck, and `bun run build`: pass.
- `bun run test:ci`: all 77 sorted files pass serially.
- Harness preflight and stop-gate: pass.
- Root `scripts/verify.sh harvto-d1-live-peer-expiry harvto-d1-live-peer-expiry`: pass through
  all 77 files and empty baseline allowlist.
- Replacement scope proof: nine explicit D1 paths; no Harvto or D2-D14 path; one matrix hunk
  wholly inside D1; normal and ignore-space numstats identical; diff check passes.
- Claude's historical `bcabd31b` PASS included the same ambiguity as non-blocking F4; Codex had
  already superseded that review because D1 requires positive dead evidence.

Next bounded action: commit the nine explicitly proven D1 paths, request exact-SHA zero-write
review, and stop only after final `PASS` is recorded.

## 2026-08-12 — D1 replacement exact-SHA review requested

Result: fail-closed follow-up committed and sent for final zero-write peer review.

- Base: `52e244b8d49258ea1768580fba2042719030d884`.
- Final head: `2986c38c4499cdd27162801880d5e4aef0f173c0`.
- Review request: bridge `6e16287c-28d3-494e-9026-be1bf8df0a3e`, no TTL, exact base/head,
  invariant, reproduction, all gate results, and 32 explicit base-to-head paths supplied.
- Post-commit tracked tree was clean; only untracked `.loop/` helper artifacts remained before this
  evidence refresh.

Next bounded action: wait for Claude `PASS` or `REVISE`. On `REVISE`, address D1 only and rerun
required gates. On `PASS`, record verdict and bridge ID, then stop without merge, rebase, push,
deploy, or PR creation.

## 2026-08-12 — D1 final exact-SHA review PASS

Result: D1 complete. Claude returned zero-write `PASS` on final exact SHA.

- Final commit: `2986c38c4499cdd27162801880d5e4aef0f173c0`.
- Review request: `6e16287c-28d3-494e-9026-be1bf8df0a3e`.
- PASS response: `c0c49af4-e3ed-4f7d-ada2-7fc562e28e23`.
- Claude independently reran tmux, D1 Governess runtime, bridge tests, and root verifier; all passed.
- Claude independently counted all 77 serial files, confirmed empty baseline failures, re-derived
  32-path D1-only scope, and found no blocking findings.
- Historical `bcabd31b` verdict remains superseded; final verdict applies only to `2986c38c`.
- No merge, rebase, push, deploy, dependency change, Harvto edit, D2-D14 work, or PR creation was
  performed.

Stop condition reached. No next action in this run.

## 2026-08-12 — Governess fresh-loop handover

Result: ready for handover epoch `1786599609309218`; current atomic step complete.

- Reviewed head remains `2986c38c4499cdd27162801880d5e4aef0f173c0`.
- Final Claude zero-write `PASS`: bridge `c0c49af4-e3ed-4f7d-ada2-7fc562e28e23`.
- Uncommitted tracked files are post-review evidence only: `PLAN.md`, `status.md`, D1
  `verification.md`, and D1 `defect-matrix.md`; untracked `.loop/` helper artifacts remain.
- Preserve all changes. No commit, push, merge, rebase, deploy, discard, or new work slice.

Next: fresh loop remains stopped until human provides new scope.
