# D8 Stale Utility Write Authority

## Problem

At exact implementation base `66fd1e13745832cfb959e9fb1b3fb295f2ba5ee9`,
`applyUtilityJobPatch` accepts a completed Au Pair edit, resolves its artifact and workspace, creates
`UtilityToolBroker`, and calls `broker.applyPatchProposal`. The broker correctly validates patch
and manifest hashes, target scope, two preimage checks, and Git applicability before one real
`git apply`. Only after that mutation does the runtime call
`recordUtilityPatchApplication`.

The utility store already persists a positive `routeEpoch`, an epoch-fenced claim, and the current
`utility/epoch` marker. Claiming fails when those values do not match. Patch application does not
revalidate them, so a completed edit whose actor authority was superseded can still mutate every
valid target and append `patch-applied`. This matches imported D8: utility edit lease `d161e3d6`
was ruled dead by `sup-187-util-dead` yet routed a two-file write. The frozen source is
`runs/harvto-supervisor-defects/artifacts/defect-matrix.md` at the campaign base.

"D8 stale" means stale actor authority: current Governess utility epoch, route epoch, and claim
epoch/lease identity. "D10 stale" means object-byte drift: absent, changed, mismatched, or
non-applicable target/preimage. D8 must not convert a D10 preimage rejection into evidence that
authority fencing works.

## Required behavior

1. A completed utility edit may reach guarded patch application only when it retains one positive,
   internally consistent authority tuple: current utility epoch equals the job's `routeEpoch` and
   the persisted claim's `epoch`. Missing current epoch, route epoch, or claim; a non-utility route;
   or any mismatch fails closed.
2. Completed-worker PID liveness is not the lease. A worker may exit normally after producing a
   patch. D8 fences the persisted epoch/route/claim authority and does not require a completed
   worker process to remain alive.
3. Authority validation and the real mutation use a new async-capable
   `withUtilityPatchAuthority` store section built on an awaited lock variant, not the existing
   synchronous `withStoreLock`. The owned descriptor/token remains held and non-stale for the
   complete awaited operation. An epoch change that acquires the lock first makes apply reject. An
   apply that acquires it first retains authority through broker mutation and application
   journaling; epoch activation cannot cross the validation-to-mutation section. Returning a
   Promise through synchronous `withStoreLock`, which releases in `finally` before the await,
   is explicitly forbidden.
4. Every stale, changed-epoch, missing-claim, route/claim mismatch, or authority-replay rejection
   occurs before `broker.applyPatchProposal` and before real `git apply`. It leaves both fixture
   files byte-identical and appends no `patch-applied` event.
5. The deterministic D8 regression uses two present, ordinary, valid, non-dependency files and one
   valid aggregate patch. Manifest hashes, target lists, preimages, and Git applicability remain
   unchanged. The only red variable is advancing the active utility epoch after route, claim,
   completion, and proposal creation.
6. The two-file fixture must stay byte-valid because `applyPatchProposal` calls
   `assertImagesMatch(..., "preimage")` before and after its applicability probe. Perturbing a
   fixture byte would reject through D10 object semantics and manufacture a false D8 pass.
7. A valid completed edit with current matching route and claim authority applies both files exactly
   once, records one `patch-applied` event, and preserves the existing pre/postimage journal.
   Repeating the same call while authority still matches returns `already-applied`, creates no
   second mutation, and leaves exactly one application event.
8. In-section journaling uses one internal `recordUtilityPatchApplicationLocked` helper shared by
   `withUtilityPatchAuthority` and public `recordUtilityPatchApplication`. The async section calls
   that helper directly and never re-enters `withStoreLock`; self-deadlock or a late unlocked
   journal append is forbidden. A racing `activateUtilityEpoch` waits under the existing bounded
   acquisition policy. If the apply finishes within that window, activation then acquires and
   advances normally; if not, activation throws `utility store is busy`. It never returns `false`
   merely because an apply holds the lock; `false` remains reserved for an already-newer epoch.
9. Existing patch hash, manifest hash, scope, workspace, preimage, applicability, postimage-drift,
   and artifact-deduplication checks remain fail-closed. D8 does not weaken or relocate D10's broker
   guards.
10. Utility routing, claiming, worker completion, read-only jobs, full-agent bridge authorization,
   linked-worktree selection, and hard-disabled `0/off/0` behavior remain compatible.
11. The bounded production scope is exactly `src/loop/utility-store.ts` and
    `src/loop/utility-runtime.ts`. The bounded regression scope is exactly
    `tests/loop/utility-store.test.ts` and `tests/loop/utility-runtime.test.ts`.
    `utility-tools.ts`, `bridge-utility.ts`, and `utility-workspace.ts` are control-only.
12. Every planning-byte change invalidates all five D8 contract SHA-256 values. After edits stop,
    freeze all five together, re-derive them immediately before requesting one fresh Claude
    zero-write full review at exact base `66fd1e13745832cfb959e9fb1b3fb295f2ba5ee9`, and re-derive
    them on verdict receipt. Only literal `PLAN PASS` naming that base and all five current hashes
    authorizes source/test/red work. Two consecutive `REVISE` verdicts on the same premise without
    convergence stop and escalate rather than triggering a third re-freeze.

## Compatibility and boundaries

- No Harvto, live utility worker, provider, tmux pane, external repository, remote, dependency,
  deployment, or release mutation is part of D8. All tests use temporary repositories and run
  directories.
- Utility and Au Pair controls remain exact `0/off/0` outside deterministic local fixtures. No
  helper routing or spend is authorized.
- D8 does not fix absent targets, changed target bytes, stale preimages, non-applicable patches,
  duplicate bridge emissions, composer nudges, or socket discovery. Those remain D10, D9, D11, and
  D12 respectively.
- No rendered UI changes. Screenshot and DOM capture are not required.
- Planning, Harness lifecycle, red evidence, evals, root `PLAN.md`/`status.md`, and handover
  records are bookkeeping scope and are excluded from the implementation commit.

## Acceptance

- The exact-base named regression proves unchanged production resolves a valid two-file patch after
  epoch advancement and mutates both files instead of rejecting. If that mechanism does not
  reproduce, preserve `not-reproduced` evidence and stop without production edits.
- After the fix, changed-epoch and other invalid authority cases jointly prove a pre-broker
  rejection, zero `patch-applied` events, and byte-identical files. A deterministic awaited-lock
  control proves the lock remains owned through the mutation callback: racing activation cannot
  interleave, cannot return false for contention, and either advances after release or throws the
  distinct busy error.
- Matching live authority applies both files once; same-authority replay returns
  `already-applied` and retains one journal event. Existing D10 and workspace controls stay green.
- Focused and mandatory gates pass. Both evals are honest pass records with
  `baseline_failures: []` and empty by-name allowlists.
- One implementation commit containing only the exact two-production/two-test scope receives
  Claude literal zero-write `PASS` for its exact SHA. Harness then closes D8 exactly once and
  bookkeeping is committed separately.
