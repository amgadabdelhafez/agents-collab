# Task harvto-d7-handoff-identity

Created: 2026-08-17T05:19:18Z
Mode: emergent
Description: D7 P2: preserve model, effort, workspace, and run identity across handoff; reproduce the uncommanded sol-high to luna-low transition.

## What I changed

- Validated D6 terminal state at bookkeeping commit
  `2c415e124c4cb2b39d81fa19a8e977e50dba48a9`, with an empty index and no current Harness task.
- Promoted parked D7 exactly once at `2026-08-17T05:19:18Z`; Harness now names
  `harvto-d7-handoff-identity` as the active task with eval pending.
- Reconciled the immutable parked capture and frozen supervisor-drain cursor into canonical
  `spec.md`, `plan.md`, `tasks.md`, `verify.md`, and this run's `plan.md`.
- Traced the current defect boundary across run-manifest model persistence, the effective tmux model
  resolver, the handoff digest, replacement argv, and replacement acceptance.
- Sent zero-write Claude plan review request `20b7e07e-723b-49d7-8868-d5a5e42c6c7e` for exact base
  and five exact hashes. Claude returned zero-write `REVISE`
  `ad396335-a328-4c79-b32c-6a418953f663`; no source, test, red, eval, staging, commit, close, or D8
  action followed.

## Why

D7 reproduces a real missing identity boundary: handoff preserves effort but replacement launch
does not explicitly carry the source effective models, and neither the handoff digest nor
acceptance proves complete run/workspace/topology/model identity. Canonical planning and an
independent plan gate are required before a regression or implementation edit.

## Notes

- Reviewed hashes:
  - spec `95d71723fb3271dfba174ccd167a93798c0fc125521b1c68384ce9de980c9ebd`
  - plan `d43509025668409da67cac3d5864f89e430673076adb5023b9812a29b80b3471`
  - tasks `5869704f96c170f0e593467f5116388939620bed629a9499650eb15e6b79ceb1`
  - verify `a1fc5092710c25fee8975c364b0df749eb6ca05621e63a69c99cf69b5d575783`
  - run plan `96716b3565217bd264460fa0a1bfa2b647c5e10ab5d36dbb063d945cc71bb6d1`
- Claude confirmed the premise, ten-file boundary, and fresh replacement run plus exact source
  lineage interpretation. Its three blocking planning corrections are:
  1. Declare the shared launch-identity type in `src/loop/run-state.ts` so the ten-file scope remains
     truthful.
  2. Make the decisive red feed replacement argv through real parse/options/effective-model
     resolution and prove base resolves ambient `gpt-5.6-luna`, rather than asserting only a missing
     argv token.
  3. Split Claude-primary safety: parent-side rejects an already inexpressible persisted value
     before spawn; replacement-side detects binary/default drift before acceptance and parent
     teardown.
- Governess prepare decision `15901a0b-f2f0-4918-af27-74fe2d956276` arrived after review began
  because Claude crossed its context preparation threshold. The current atomic review is now
  complete. A fresh successor applies only those three planning corrections, freezes five new
  hashes, and requests a fresh zero-write review. D7 implementation remains forbidden before
  literal `PLAN PASS`.

## 2026-08-17 — Run-85 D7 implementation review timeout

D7 implementation is committed at
`ec93cd7be0c085e7320d590b344477a855042c8d` on plan-freeze parent
`3ec31c5391db12948f0e641e2094323b3a468e3e`. The commit contains exactly the approved six
production and four test paths. Final focused controls, formatter, canonical TypeScript, build, all
79 certified serial test files, both empty-baseline eval checks, Harness preflight/stop-gate, and the
repository-root verifier passed. Normal and ignore-all-space numstats match exactly. Frozen red
checksums pass, and generated `loop-fork/.gemini/settings.json` residue was removed; its fixture now
uses a temporary project cwd, and `loop-fork/.gemini` remained absent through final gates.

One zero-write exact-SHA Claude review request was accepted as
`e08e1857-a870-4bcc-8a40-44550b184bce`. It names exact implementation SHA
`ec93cd7be0c085e7320d590b344477a855042c8d`, exact scope, red evidence, final gates, eval hashes,
and residue correction. Inbox polling returned no verdict. Thirty-one empty pulls occurred before
the inherited maximum-30-poll bound was recognized; this process error is handled fail-closed.
Polling stops at `2026-08-17T08:29:21Z`. Silence is not `PASS`; no duplicate review request, Harness
close, bookkeeping commit, D8 promotion, push, merge, deploy, or release action occurred.

Current boundary: HEAD remains `ec93cd7be0c085e7320d590b344477a855042c8d`, index is empty, the
ten committed paths are clean, D7 remains active/eval-pass and unclosed, and unrelated inherited
artifacts remain preserved. A later verdict is not silently accepted after this timeout. Supervisor
must authorize how to handle any late exact-SHA response; no second request for this SHA is allowed.

## 2026-08-17 — Exact-SHA PASS accepted and D7 closed once

- The supervisor accepted Claude exact-SHA `PASS`
  `9d73c532-9149-4a13-b760-b4e9796ba251` for implementation commit
  `ec93cd7be0c085e7320d590b344477a855042c8d`. It is the sole direct reply to request
  `e08e1857-a870-4bcc-8a40-44550b184bce`; the local polling timeout does not void it.
- Pre-close proof: HEAD exact, index empty, ten implementation paths clean, D7 active with passing
  eval/preflight/stop-gate, utility `0/off/0`, `.gemini` absent, frozen red 5/5, and zero D7 terminal
  records. Snapshot SHA-256:
  `03a09e49a39e59cc82cafc793d5337f318f70b581ac7d1958c350d1d547889f3`.
- Exactly one `./harness done harvto-d7-handoff-identity` exited 0 at
  `2026-08-17T08:41:15Z`; no retry occurred. D7 is done/pass, exactly one terminal D7 record exists,
  and `.harness/current-task` is absent.
- All 62 unrelated task records retain canonical aggregate SHA-256
  `33338ab6660650d48a7a3720944a391d724da3fe5a4f3830222179740118af54`. The two unrelated active
  records retain hashes `c34334dd7512fafd928015af6b26fdbf88faca7ef00b93bea8ac8653e4ae2f02`
  and `241c85e6e4f223a4248d669d842e9c4662bea2f3ee1508df0dff7c38f6fbd3e2`.
- Post-close proof: two active, 59 done, two parked; HEAD/index and implementation scope unchanged;
  frozen red 5/5; `.gemini` absent. Snapshot SHA-256:
  `d1ad64b3ba004b8b21cda1f783f06aeed826b5f5a40463df94b6fb06559e31ff`.
- The separate bookkeeping commit is limited to the exact 32-path D7-owned manifest recorded in
  root `PLAN.md` and `status.md`. It includes both close snapshots and all preserved D7 evidence;
  it excludes implementation, frozen planning bytes, root `.loop/`, unrelated evidence, and D8.
- Reviewer notes N1-N3 are non-blocking and deferred to later isolated work. Run 85 stops after
  bookkeeping and a valid two-bundle governed handover; it does not promote or begin D8.

### Bookkeeping scope correction

- The initial 32-path staging proposal was not committed. Whole-index `git diff --cached --check`
  identified original blank-line/trailing-space bytes in frozen red command/patch/output evidence.
- The six red files were removed only from the index, not edited or deleted. Their SHA256SUMS check
  remains 5/5.
- Corrected bookkeeping scope: 26 paths, comprising seven tracked lifecycle/ledger paths and 19
  non-red D7 evidence additions. Frozen red remains untracked and checksum-governed; no check was
  weakened and no unrelated path was staged.
