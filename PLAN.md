# Archived D1 Live Peer Expiry Plan

Execution status: fresh-loop handover prepared after baseline reproduction and invariant recording.
Base is `52e244b8d49258ea1768580fba2042719030d884`; canonical task ID is
`harvto-d1-live-peer-expiry`. Production files remain untouched. Durable red proof is
`loop-fork/runs/harvto-d1-live-peer-expiry/artifacts/baseline-reproduction.md`; settled design is in
`loop-fork/specs/harvto-d1-live-peer-expiry/`. Claude reply to bridge
`1c929e52-f05e-4528-8beb-a2320bd14e48` cleared the patch. Current bounded action: add pane-scoped
liveness in `loop-fork/src/loop/tmux-control.ts`, retain/backpressure behavior in
`loop-fork/src/loop/bridge-store.ts`, and explicit backpressure formatting in
`loop-fork/src/loop/bridge-dispatch.ts`.

## Goal and scope

Fix Harness backlog D1 only: a durable bridge message must not become `expired` or
`dead-letter` solely because wall-clock TTL elapsed or target queue depth was reached while
its intended peer is positively live. Preserve idempotency and prove recovery does not
duplicate delivery.

Authoritative inputs:

- `loop-fork/specs/harvto-d1-live-peer-expiry.md`
- D1 section of `loop-fork/runs/harvto-supervisor-defects/artifacts/defect-matrix.md`
- `specs/constitution.md`
- `docs/architecture/system-overview.md`
- `docs/testing/commands.md`

No Harvto edits. No D2-D14 changes. No merge, rebase, push, deploy, dependency change, or
spend outside governed GLM Au Pair routes. Codex owns decisions and all primary-worktree
writes. GLM results are advisory. Claude performs zero-write paired review only.

## Working invariant

Final wording follows baseline reproduction and liveness-source tracing. Starting invariant:

1. Once accepted and durably journaled, a message addressed to a positively live peer stays
   recoverable until delivery, acknowledgement, explicit supersession, or another terminal
   condition backed by authoritative non-liveness evidence.
2. TTL and queue depth may trigger delivery pressure or recovery handling, but cannot alone
   discard a live peer's message.
3. Unknown or missing liveness fails closed; it cannot be treated as proof that discard is
   safe.
4. Repeated reads, reconciliation, and recovery produce at most one effective delivery and
   one terminal resolution for the message identity/dedupe contract.

Do not choose an API or data-model change until source tracing identifies current authoritative
peer-liveness evidence and all callers of `readPendingBridgeMessages` and
`enqueueBridgeMessage`.

## Execution plan

1. Promote and establish clean baseline.
   - Confirm branch/worktree identity and clean status; confirm no pre-existing staged paths
     and no unrelated dirty files (parallel agents share this checkout).
   - Run `cd loop-fork && ./harness promote harvto-d1-live-peer-expiry` (the executable is
     `loop-fork/harness`, not repo root). Then `cd loop-fork && ./harness status --json` to read
     the canonical task ID; do not assume the slug equals the task ID.
   - Record base SHA (`git rev-parse HEAD` plus `git rev-parse --verify <sha>^{commit}`) and
     baseline commands in the D1 run evidence.
   - Note the two distinct evidence roots: repo-root `runs/` (what `scripts/verify.sh` reads)
     and `loop-fork/runs/` (where harness promotion and the defect matrix live). Record which
     artifact goes where before writing any.

2. Gather bounded evidence in parallel.
   - Route 1-3 early, separable, read-only Au Pair packets through governed `route_task` with
     `work_shape=separable`, `kind=review`, `review_mode=utility-audit`, `inspect` capability,
     exact read scopes, no write scopes, and every authority flag false:
     source/call-graph tracing, authoritative peer-liveness tracing, and existing-test/blast-
     radius mapping.
   - Use exact read scopes and configured cost limits. Keep product decisions with Codex.
   - Review every returned artifact; route later mechanical diff/check audits when useful.

3. Reproduce before production patch.
   - Add the smallest D1 regression fixture in the existing bridge test boundary selected by
     source tracing.
   - Prove baseline failure for both reported terminal paths: TTL expiry
     (`loop-fork/src/loop/bridge-store.ts:371-379`) and queue-limit dead-letter in
     `enqueueBridgeMessage`, while intended peer is live.
   - Time must be injected, not slept: drive expiry through the existing `nowMs`/clock seam so
     the regression is deterministic under `bun test`. Same for liveness: the test supplies the
     liveness source, it does not probe real tmux/processes.
   - If reproduction fails to show the reported behavior, stop and report a refutation of the
     D1 premise as the deliverable. Do not patch to fit the ticket.
   - Include controls for confirmed-dead handling and unknown-liveness fail-closed behavior if
     those states share the changed predicate.
   - Capture exact command, failure names, output summary, base SHA, and journal events in
     durable D1 Harness evidence before changing production code.

4. Derive and record invariant.
   - Reconcile reproduction, current liveness authority, journal semantics, and architecture
     fail-closed rules.
   - Update promoted D1 spec/plan/verify artifacts with exact state transitions and acceptance
     checks. Reject any design that relies on pane notification or heartbeat as delivery proof.

5. Apply narrow D1 fix.
   - Change only bridge/liveness integration required by reproduced D1 paths.
   - Preserve journal compatibility in both directions: journals written by the pre-fix code
     must still parse, and journals written by the fixed code must not break older readers
     (new fields optional, unknown fields ignored).
   - Preserve ordering, priority, dedupe, supersession, acknowledgement, status reporting, and
     unrelated queue behavior.
   - Retention must stay bounded. Name and test the bound that prevents unbounded growth when a
     peer is live but never drains (for example: pressure escalation, retained-count ceiling, or
     terminalization on an authoritative non-liveness transition). Unbounded retention is a
     rejected design, not an accepted tradeoff.
   - Do not apply Au Pair patches automatically; Codex reviews proposals and performs writes.

6. Verify in increasing scope.
   - Re-run the new regression and selected controls.
   - Run full affected bridge test files and any liveness test file touched by the call path.
   - Run `cd loop-fork && bun run check`, `bunx tsc --noEmit ...` (typecheck; `scripts/verify.sh`
     runs it as a separate gate), `bun run build`, and `bun run test:ci`. `test:ci` iterates every
     `tests/**/*.test.ts` serially under `LOOP_TEST_CERTIFICATION_MODE=single-file` and is slow;
     budget for it and never substitute a filtered run for the full gate.
   - Write the eval to repo-root `runs/<task-id>/eval.json`, NOT `loop-fork/runs/...`.
     `scripts/verify.sh:14` sets `ARTIFACTS_DIR="runs/${TASK_ID}"` relative to repository root,
     so an eval under `loop-fork/runs/` fails the gate as missing.
   - The eval must satisfy `scripts/check-baseline-allowlist.py`: top-level `verdict` (or
     `result`) exactly `"pass"`, a `baseline_failures` key present and an empty list, and no
     other key matching baseline+fail with a truthy value anywhere in the document.
   - Run `scripts/verify.sh <feature> <task-id>` from repository root using the canonical task ID
     read in step 1, not an assumed slug.
   - Confirm no UI change; screenshots are not required unless implementation unexpectedly
     changes rendered UI.

7. Update durable Harness evidence.
   - Update only D1 in `defect-matrix.md`: reproduction, invariant, exact fix, named tests,
     focused/full results, no-duplicate proof, commit SHA, review request ID, and verdict.
   - Keep promoted D1 spec/task/verify/run artifacts consistent with actual proof.
   - Update `PLAN.md` and `status.md` before commit/handoff. `status.md` already exists at repo
     root and is the durable handoff record; refresh it at every phase boundary (post-repro,
     post-fix, post-verify, post-review), not only at the end.

8. Commit explicit paths only.
   - Review `git status`, staged diff, unstaged diff, and path list.
   - Prove scope containment before committing: `git diff --name-only` must contain zero paths
     under any Harvto tree and zero D2-D14 artifacts; the only `defect-matrix.md` hunk must be
     inside the D1 section (`loop-fork/runs/harvto-supervisor-defects/artifacts/defect-matrix.md:19`
     onward, up to the D2 heading).
   - Compare `git diff --numstat` against `git diff --numstat --ignore-all-space`; a disagreement
     means an unintended reformat and blocks the commit.
   - Stage with `git add -- <each D1 path>`; never use broad staging.
   - Commit only D1 source, tests, promoted Harness artifacts, `PLAN.md`, and `status.md` with a
     D1-specific message. Record exact base and commit SHAs.

9. Request exact-SHA zero-write review and stop on PASS.
   - Send Claude a no-TTL `review_request` naming exact commit SHA, base SHA, explicit paths,
     D1 invariant, reproduction evidence, verification results, and required zero-write verdict.
   - Require independent diff inspection and focused reruns, with verdict exactly `PASS` or
     `REVISE` plus findings.
   - On `REVISE`, address D1-only findings, rerun gates, commit explicit paths, and request
     review of the new exact SHA.
   - On `PASS`, record verdict and bridge ID in durable evidence and `status.md`, then stop.
     Do not merge, rebase, push, or deploy.

## Acceptance criteria

- Baseline reproduction proves current TTL and queue-depth terminalization against a live
  intended peer before production code changes.
- Live-peer messages remain recoverable across elapsed TTL and queue pressure.
- Confirmed-dead behavior remains explicit and tested; unknown liveness fails closed.
- Recovery/read/reconciliation cannot duplicate effective delivery or terminal resolution.
- Existing dedupe, supersede, ordering, acknowledgement, and status contracts stay green.
- Focused tests, `bun run check`, `bun run build`, `bun run test:ci`, and Harness verify pass
  with durable, exact-command evidence.
- Retention bound is named and tested; no unbounded queue growth for a live, non-draining peer.
- Journal round-trips both directions across the fix boundary.
- Git diff contains D1 paths only and no Harvto changes, proven by `git diff --name-only`.
- `runs/<task-id>/eval.json` exists at repository root with `verdict: "pass"` and empty
  `baseline_failures`.
- Claude returns zero-write `PASS` for exact final SHA. Work stops immediately after recording
  PASS.

## Open questions resolved during execution

- Which existing process/tmux evidence is authoritative for each `BridgeTarget` at read and
  enqueue time?
- Should live-peer retention defer terminalization, convert it to a non-terminal pressure
  event, or move terminalization to a liveness-aware owner? Reproduction and journal
  compatibility decide.
- Which promoted Harness task ID and exact test files are canonical? Promotion/source tracing
  decide; no human action needed.

## Current execution state — 2026-08-12 post-fix

- Baseline promotion, source tracing, deterministic reproduction, and invariant recording are
  complete at base `52e244b8d49258ea1768580fba2042719030d884`.
- Production fix is implemented in the bridge store, dispatch formatter, Governess consumer,
  and pane-scoped tmux liveness seam. Named D1 regression passes with assertions unchanged.
- Retention uses `maxRetained = maxOutstanding + 1`; live and unknown pressure retain one extra
  durable slot, then return pre-accept `backpressure` without a journal or transcript event.
- Confirmed-dead, unknown, ceiling, later-dead, supersession, formatter, journal compatibility,
  and no-duplicate controls pass in existing bridge boundaries. Remaining sequence: settle the
  Utility-runtime notification scope is documented as redundant after durable job transition.
  All 77 serial test files and Harness gates pass; explicit-path commit
  `bcabd31b551f3adbf5dbeccd39439a6a84edfe1d` review was superseded after a utility audit found
  nonzero pane-probe exits were not authoritative dead evidence. Apply the scoped
  nonzero-to-`unknown` correction. Correction now passes focused tests, check, canonical typecheck,
  build, all 77 serial test files, Harness preflight/stop-gate, and root verifier. Remaining:
  replacement commit `2986c38c4499cdd27162801880d5e4aef0f173c0` received final Claude
  zero-write `PASS` via bridge `c0c49af4-e3ed-4f7d-ada2-7fc562e28e23`. D1 is complete; stop
  without merge, rebase, push, deploy, or PR creation.

## Handover epoch 1786599609309218

D1 stop condition is reached. Preserve reviewed head
`2986c38c4499cdd27162801880d5e4aef0f173c0` and uncommitted post-review evidence. Fresh loop
must not start another slice unless human supplies new scope.
