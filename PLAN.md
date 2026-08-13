# Current Plan — D1 Harness Closure, Then D4 Live Peer Unconsumed

## Execution update — D4 locally verified, exact-SHA review next

D1 Harness closure is committed as `0822c3546c44521ea778324d66d6c4c98f3972fb`. Canonical D4 task
`harvto-d4-live-peer-unconsumed` is promoted and reproduced red on that unchanged production base:
the exact positively live peer consumed and answered its durable request, but the utility job
remained `routed-peer` with no result.

The D4-only correction is implemented in `loop-fork/src/loop/utility-runtime.ts`. Reconciliation
now repairs a missing peer-request append with stable dedupe, requires delivery plus an exact
correlated response before completion, terminalizes from durable bridge failure evidence, and is
idempotent across replay. Three named regressions pass, as do bridge/D1/store controls, static
check, canonical typecheck, build, and all 77 serial test files.

Both Harness gates and the root verifier passed for initial review commit
`26e5cfd6998602ff7c2452c9006ad13fe26449dc`. Claude returned zero-write `REVISE` via
`c96f267b-ad2b-48ea-a273-2c8509eb2610`: acknowledgements and legacy-untyped rows could complete
before the actual decision. The corrected contract accepts only explicit `decision` responses;
the ack/untyped/decision replay regression and all proportional gates plus all 77 serial test files
pass. Harness preflight/stop-gate and the root verifier also pass after correction. Claude returned
a second zero-write `REVISE` via `46fbee8b-b835-4c03-913e-1e2d9224f19e`: the decision-only
consumer lacked a matching producer instruction. The minimal correction requires message type
`decision` in the peer review request and pins that instruction in the existing D4 superset
regression. The focused controls, check, canonical typecheck, build, both full 77-file serial
suites, Harness preflight/stop-gate, and root verifier all pass after this revision. Current step:
commit explicit correction paths and request fresh exact-SHA review. On `PASS`, record the verdict,
close Harness, commit final bookkeeping, and stop without remote or wider-defect action.

## Goal and authority

First repair only `loop-fork/runs/harvto-d1-live-peer-expiry/task-log.md` through a fresh governed
GLM utility patch. Then complete and commit legitimate D1 Harness closure evidence. Promote,
reproduce, fix, verify, exact-SHA review, and bookkeep D4
`harvto-d4-live-peer-unconsumed` without waiting between safe phases.

- Codex owns decisions, writes, tests, commits, and review corrections.
- Governed Utility uses existing `openrouter/z-ai/glm-5.2` only for bounded secondary work and patch
  proposals. No provider or model change.
- Claude is zero-write reviewer of exact committed SHA only.
- Do not merge, rebase, push, deploy, spend outside governed routes, edit Harvto, mutate preserved
  Harvto runs, delete evidence, stage `.loop/`, change dependencies, or touch D2-D3/D5-D14.
- Preserve existing untracked `.loop/` artifacts and partial D1 post-task, debt, and regression
  evidence. Automatic continuation ends after D4 bookkeeping because wider defects are forbidden.

Authoritative inputs: `specs/constitution.md`, `docs/architecture/system-overview.md`,
`docs/testing/commands.md`, `loop-fork/specs/harvto-supervisor-defects/{spec,verify}.md`, parked D4
spec `loop-fork/specs/harvto-d4-live-peer-unconsumed.md`, and canonical defect matrix.

## Preconditions verified from source (2026-08-13, read-only)

`status.md` already exists at repository root (333 lines, current entry
`2026-08-13 — D1 closure and D4 continuation plan refresh`). It is the durable handoff record and
must be refreshed at every phase boundary; it does not need to be created.

Mechanics read from `loop-fork/v2/kit/scripts/`:

- `done.sh:29,102-125` writes `specs/${TASK_ID}.md`. That path is the **tracked parked D1 spec**
  `loop-fork/specs/harvto-d1-live-peer-expiry.md` (confirmed by `git ls-files --error-unmatch`).
  `harness done` therefore OVERWRITES an authoritative input with the generated completion spec.
  This is expected Harness behavior, not corruption, but the pre-close blob must be recorded first.
- `done.sh:76-79` is the only task-log gate: `## What I changed` must be non-empty. `## Why` and
  `## Notes` are unchecked. `section()` (`done.sh:49-61`) collects lines after the exact heading
  until the next line starting `## `, then strips.
- `runs/harvto-d1-live-peer-expiry/meta.json` has `mode: "emergent"`, so the
  `investigation`/`notes.md` branch (`done.sh:66-74`) does not apply.
- `done.sh:82-84` requires `runs/<id>/memory/[0-9][0-9][0-9]-*.md`. Present: `001-initial.md`,
  `002-promoted-parked-idea.md`.
- `done.sh:45-46` raises `error: task already done` when `meta.status == "done"`. `harness done` is
  not idempotent and has no rollback; a mid-python failure leaves partial writes.
- `done.sh:135-137` deletes `.harness/current-task`, which is **tracked**. Closure therefore
  produces a staged deletion, plus `.harness/tasks.json` mark-done (`tasks-index.sh`) and a
  coordination record (`coordination.sh write ... --intent done`).
- `promote.sh:47-51` refuses to promote while `.harness/current-task` is non-empty, so D1 closure
  must land before D4 promotion. `promote.sh:64-72` derives the canonical task ID from the `^id:`
  frontmatter line of `specs/harvto-d4-live-peer-unconsumed.md` (tracked), falling back to the file
  stem; `promote.sh:200`/`task.sh` rewrites `.harness/current-task`.
- `stop-gate.sh:60+` reads `loop-fork/runs/<id>/eval.json` and checks `required` against
  `dimensions[*].status`. This is a DIFFERENT file and schema from repo-root `runs/<id>/eval.json`
  read by `scripts/verify.sh:14` and `scripts/check-baseline-allowlist.py`. D4 needs BOTH.
  D1's `loop-fork/runs/harvto-d1-live-peer-expiry/eval.json` already has `required: ["unit"]` with
  `unit.status: "pass"`, so the stop gate should pass once the task log is repaired.
- `bun run check` is `ultracite check` (biome). Never run `bun run fix`: it rewrites `runs/`
  evidence. Format only touched files by invoking biome on explicit paths.

## Execution plan

1. Repair D1 task log as one guarded atomic step.
   - Recheck HEAD, branch/worktree identity, staged/unstaged/untracked Git state, and active Harness
     identity. Record hashes of every partial D1 closure artifact before any retry.
   - Require current task-log SHA-256 exactly
     `677a977ae6b49e94d1fc3d25807e2ca496509c55dd99bdc42bc0533997e29d33`, no current Git diff, and
     final byte `0a`. Any mismatch stops this step for reconciliation.
   - Route a fresh one-file patch request to governed `openrouter/z-ai/glm-5.2`. Bind it to that
     exact preimage and require factual D1-only text under `What I changed`, `Why`, and `Notes`.
     Require preservation of existing final newline and forbid any
     `\\ No newline at end of file` marker.
   - Inspect utility metadata and patch bytes. Require only the task-log path, exact preimage hash,
     valid unified diff, no D4 content, no unrelated rewrite, and a recorded patch SHA-256.
   - Run native `git apply --check <patch>` from repository root. Do not apply with native Git.
     Apply only through guarded `apply_task_patch` using exact utility task and patch SHA.
   - Verify changed task-log content, final byte `0a`, absence of no-newline marker, exact one-file
     diff, `git diff --check`, and full Git status. Stop this atomic step if any check fails.
   - Pin the check invocation: run `git apply --check -p1 --whitespace=nowarn <patch>` from the
     repository root with `a/loop-fork/runs/...` / `b/loop-fork/runs/...` prefixes; record exit code
     and full stderr verbatim. Prior attempts failed as `corrupt patch ...:16` (task
     `76af947a-43ca-461c-9ef0-973cb44e7fee`) and `patch does not apply` from a spurious
     `\\ No newline at end of file` marker (task `bce0fe17-8172-4644-a0a6-4a9c9cc5c95c`, patch
     SHA-256 `0d8a39abb3a6ecee299564a7d6c892528f0866102562195573d0a1146339a93f`).
   - Require the patch to place non-blank text directly under `## What I changed`; that section
     alone is gated. Empty `## Why`/`## Notes` would still pass the gate but are unacceptable
     evidence, so fill all three.
   - Bound the retry: at most two further governed patch attempts. If both fail, stop and escalate
     to the human with exact task IDs, patch SHA-256s, and `git apply --check` stderr. Do not
     hand-write the task log outside guarded `apply_task_patch`.

2. Close D1 Harness lifecycle without losing partial evidence.
   - Compare current partial post-task/debt/regression artifacts to recorded hashes; retain all
     files and the existing deduplicated `debt/register.jsonl` row.
   - Before running `done`, record the pre-close blob of the parked D1 spec:
     `git rev-parse HEAD:loop-fork/specs/harvto-d1-live-peer-expiry.md` plus its working-tree
     SHA-256, and confirm it is recoverable from Git history. `harness done` will overwrite it with
     the generated completion spec.
   - Confirm the two memory files exist and `meta.json` status is still `active` before invoking
     `done`; both are hard preconditions.
   - Re-run D1 `preflight` and `stop-gate`, then run
     `./harness done harvto-d1-live-peer-expiry` once. `done.sh` reruns post-task checks before
     closure; expect timestamp-bearing files to refresh, but never delete prior paths. Debt scan
     must report zero duplicate append for existing fingerprint.
   - If `harness done` fails, do not rerun blindly: read `meta.json` status first. Status `done`
     means the python block completed and a rerun will abort with `error: task already done`;
     status `active` with partial writes requires manual reconciliation before any retry.
   - Require successful task-log gate, generated completion spec, `meta.json` status `done`, task
     index/coordination closure, cleared `.harness/current-task`, and preserved post-task/debt/
     regression evidence. Inspect exact Git state immediately afterward.
   - Classify every changed/untracked path. Legitimate D1 closure evidence may include task log,
     post-task/debt/regression outputs, generated completion spec, run metadata, task index,
     coordination records, and the existing debt-register row only when directly produced by
     Harness and internally consistent. Exclude `.loop/`, D4 planning, unrelated generated files,
     and any unexplained path.
   - The accepted set must explicitly include the tracked deletion `.harness/current-task`
     (`git add -- .harness/current-task`), the `.harness/tasks.json` mark-done edit, the
     coordination record, the overwritten `loop-fork/specs/harvto-d1-live-peer-expiry.md`, and
     `loop-fork/runs/harvto-d1-live-peer-expiry/{task-log.md,meta.json}`.
   - Stage each accepted D1 closure path explicitly. Require cached path list, `git diff
     --cached --check`, no `.loop/`, no Harvto path, no D2-D14 content, and matching normal versus
     `--ignore-all-space` numstats. Commit legitimate D1 closure evidence only; record exact SHA.
   - After the commit, re-run `git status --porcelain` and prove `.loop/` and every preserved D1
     artifact path are still present and still untracked or committed as intended. Nothing was
     deleted.

3. Promote D4 canonically.
   - Confirm `.harness/current-task` is absent/empty (promotion refuses otherwise), then run
     `cd loop-fork && ./harness promote harvto-d4-live-peer-unconsumed`.
   - Pre-read the `^id:` frontmatter line of `loop-fork/specs/harvto-d4-live-peer-unconsumed.md` to
     predict the canonical ID, then confirm it against `./harness status --json`. Do not assume the
     slug.
   - Read `./harness status --json`; record canonical task ID and D4 base as D1 closure commit.
     Do not hand-create promoted artifacts if promotion fails.
   - Read generated run/spec files and refine promoted `spec.md`, `plan.md`, `tasks.md`, and
     `verify.md` before production edits. Keep repo-root `runs/` verification evidence distinct
     from `loop-fork/runs/` Harness evidence.

4. Reproduce D4 before production change.
   - Trace utility `routed-peer` transition, durable bridge append/delivery, exact-peer inbox
     consumption, response correlation, and terminal utility state. Treat liveness, notification,
     delivery, consumption, and completion as separate evidence.
   - Use bounded zero-write GLM audits where useful. Starting anchors are
     `utility-store.ts`, `utility-runtime.ts`, `native-subagent.ts`, bridge dispatch, and worker
     wake/reconciliation tests.
   - Add smallest deterministic named regression at existing utility-runtime/bridge boundary.
     Assert exact target, positive live evidence, durable journal sequence, bounded consumption or
     terminal outcome, restart/replay behavior, and no duplicate. Avoid sleeps, real tmux, and real
     provider calls.
   - Run test against unchanged D4 base and save command, exact SHA, decisive failure, journal rows,
     and controls under D4 evidence. If invariant already holds, record `already-fixed` or
     `not-reproduced` with exact proof and skip production patch.

5. Fix only reproduced D4 branch.
   - Set contract from reproduction: owner of transition out of `routed-peer`, bounded retry and
     reconciliation, live/dead/unknown behavior, idempotent completion, and durable evidence.
   - Use governed GLM for bounded audit or patch proposal only. Codex applies smallest scoped
     correction.
   - Preserve D1 retention/liveness, journal compatibility, routing policy, ordering, dedupe,
     acknowledgement, fail-closed unknown liveness, and Claude zero-write isolation.

6. Verify and write D4 evidence.
   - Re-run unchanged named regression plus dead/unknown peer, duplicate wake/reconciliation,
     restart/replay, unrelated target, and routed-driver/requester/utility controls.
   - Run affected full test files, then `bun run check`, canonical `bunx tsc --noEmit ...`,
     `bun run build`, and serial `bun run test:ci` from `loop-fork`.
   - Create BOTH evals: `loop-fork/runs/<canonical-task-id>/eval.json` with `required` plus
     `dimensions[*].status` acceptable to `stop-gate.sh`, and repo-root
     `runs/<canonical-task-id>/eval.json` with top-level `verdict: "pass"` and empty
     `baseline_failures`. Run `scripts/verify.sh <feature> <canonical-task-id>` from repo root.
   - If `bun run check` flags Harness-generated files, format only those exact paths with biome
     directly. Never run `bun run fix`.
   - Update only D4 promoted/run artifacts and D4 matrix scope. Move D4 from backlog row to one
     confirmed-defect section after D3, or record exact `already-fixed`/`not-reproduced` result.
     Never alter D1-D3 or D5-D14 text.

7. Commit, review, correct, and bookkeep D4.
   - Prove exact path scope, matrix hunk bounds, `git diff --check`, matching normal versus
     ignore-space numstats, no Harvto, no `.loop/`, no D1, and no other defect.
   - Stage explicit D4 paths and commit. Send Claude exact base/head SHA, path list, invariant, red
     proof, verification evidence, and no-TTL zero-write review request.
   - On `REVISE`, correct D4 only, rerun proportional and mandatory gates, commit explicit paths,
     and request fresh review of new exact SHA. Repeat until `PASS` or genuine blocker.
   - On `PASS`, record verdict, bridge ID, exact SHA, tests, and final status in D4 evidence,
     matrix, `PLAN.md`, and `status.md`; commit bookkeeping explicitly. Stop without remote,
     release, or wider-defect action.

## Acceptance criteria

- Fresh utility patch is pinned to exact task-log preimage, passes native `git apply --check`, and
  is applied only through guarded `apply_task_patch`; final newline remains present.
- D1 closes successfully; partial and refreshed closure evidence remains available; only legitimate
  D1 closure paths are committed; `.loop/` remains untracked.
- D4 is promoted from parked spec and reproduced red on exact base, or closed with exact contrary
  proof before any production patch.
- Confirmed fix yields bounded, replay-safe live-peer consumption/completion with no duplicate;
  dead and unknown behavior fails closed; D1 regressions remain green.
- Focused tests, affected files, check, canonical typecheck, build, serial full suite, Harness gates,
  root verifier, and eval pass.
- Claude returns zero-write `PASS` for exact final D4 SHA after all corrections.
- The pre-close blob of `loop-fork/specs/harvto-d1-live-peer-expiry.md` is recorded before `harness
  done` overwrites it, and the overwrite is committed as intended closure evidence.
- After every commit, `.loop/` and all preserved D1 artifacts still exist; `.loop/` remains
  untracked.
- Final commits contain only explicit D1 closure or D4 paths. No Harvto, `.loop/`, D2-D3/D5-D14,
  dependency, provider, model, remote, deployment, or release changes.

## Open questions resolved during execution

- Which D1 closure files refresh versus remain byte-identical on safe `harness done` retry?
- Does D4 “unconsumed” occur in bridge pending state, peer intake, response correlation, utility
  `routed-peer` terminalization, or several boundaries?
- Which component owns bounded terminal transition after exact live peer consumes routed work?

---

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
