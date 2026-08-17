# Current Plan — D6 Gate Correction, Follow-up Review, Then D7-D12

## Run-83 authoritative continuation — handover epoch `1786912909823827`

This section is current authority. It supersedes earlier next-action and run-identity wording while
preserving all tighter frozen-contract, evidence-integrity, exact-SHA, one-close, utility-ban, and
isolated-lifecycle rules below. This session is plan-only: only `PLAN.md` may change. Do not run D6
gates, regenerate evidence, update `status.md`, request review, close Harness, stage, commit, route a
helper, or begin D7 in this step.

### Validated starting boundary

- Both handover files at
  `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/82/handoff/1786912909823827/{claude,codex}.json`
  were read completely, parse as `status: "ready"`, agree on epoch `1786912909823827` and
  `gitHead: ef17eb08139a7300316a3564782c216e7f19cfaf`, and hash to Claude
  `71f3ea1bdd698d8d8835f1cd6ed7a1d71ff900872e50009f7a79491581dda3d7` and Codex
  `bba79e5993906b1a5db3f163b81ffc0192abd9083990707a73532baae05a6a19`.
- Run-82 `transcript.jsonl` was read. Claude verdict
  `3ef105fc-210f-4b56-8dcb-1903fc05406d` is literal `REVISE` for unchanged D6 SHA
  `254e1749ca67ad1d81cd434ef01db0aeabae5827`: code, formatter discharge, and disclosed red
  provenance are approved; only fresh mandatory gates and dual passing D6 evals remain.
- Supervisor decisions `e12c4ffc-e4f1-4abc-be93-64b58ce46f17` and
  `4662cdff-a52a-47ef-86fc-97c3ca2e56b7` authorize exactly one follow-up same-SHA review after
  materially new green evidence exists. They authorize no D6 code, contract, frozen-red, Harness,
  or close mutation before that review.
- HEAD is `ef17eb08139a7300316a3564782c216e7f19cfaf`; the index is empty; D6 commit
  `254e1749ca67ad1d81cd434ef01db0aeabae5827` resolves and contains only
  `loop-fork/src/loop/tmux.ts` and `loop-fork/tests/loop/tmux.test.ts`. Neither source nor tests are
  dirty. Their commit blob hashes remain source
  `e9fdabb8c367bfbec9998bb3601e9d35183173f472a994e5922c905b895d009e` and test
  `5e11287a399647fb516d5d3fdbdcb609273ce9d59409b49076ed1e5335971db1`.
- Harness reports D6 as sole active task, `meta.status: active`, eval `pending`. Hashes remain
  `tasks.json` `42b30be61071b60a8e9d6838565d25a2abf36d7a2d8fc35499516f5f415f214d` and
  `current-task` `f15fd0c0490dece3829ff14cb75706c5f696cca66d3bae8485b4a30a632a4e4e`.
- Five frozen contract hashes remain
  `aaa58574cce19e466cafd8b5d7a51c03ea052457611b91d21170bc461106dfaa`,
  `67fd510c0034378fcb83ef7ff7b99bdbb91ab92835d3de5d88299f2ce19b48d2`,
  `0bf974e3769aad738e7f3e56ac3fe377ca4697ff836c444bacc0283ddf3f2f6b`,
  `5b4532f5011e5366a0735341a6861da11962d5a42abe917eb0b6e78669b29a9e`, and
  `4b840882ffee189649c31b7011e9fc48b0f997e5070140493cde86eef73a7baf`. Frozen red hashes remain
  README `5fee6e797037c3a078fd6d36824baaee4c7cb08ac0720fc145125b1f2c25d8ed`, command
  `b80df25d87d06408fe45a5e4a7f1dec14f21d5f61d0ae0c5bcc4ed49f994883e`, fixture
  `a1585cccf9f57a1806a75f59ef5fdafc5ee17f5e5205c25fdb24c4d6aa389aca`, and output
  `8103e398ecb891565fcd4b4fa3c93b35fa28c099cc3b358d1273d216fe766c03`.
- Both D6 evals exist but do not pass: loop-fork eval is `pending`; root eval is `fail`; both carry
  the stale inherited formatter baseline. Root `.loop/` remains 60 files and zero tracked files.
  Utility is positively `0/off/0`; helper routing remains prohibited even though run-83 bridge
  `loop-bridge-agents-collab-83` is available for peer/supervisor coordination.
- Existing uncommitted work is preserved. Handover hashes for the inherited dirty files match
  `PLAN.md` `a67a1cae05aa13876d86bcf9d3c15148292456ab36e79301c000054a76201975` and
  `status.md` `c442b2eea8d0a9de4f6e5096d7541307eb87b135173fe148273efa3fe80ffa85`
  before this plan-only amendment.

### D6 correction lifecycle

1. **Fail-closed preflight before execution writes.** Revalidate both run-82 bundles and hashes,
   HEAD/index/dirty scope, D6 commit paths and blob hashes, all frozen contract/red hashes, D15
   protected evidence, formatter terminal and bookkeeping proof, D6 sole-active/eval-pending state,
   Harness hashes, root `.loop/`, and utility `0/off/0`. Capture pre-write hashes and key sets for
   every authorized D6 evidence surface. Any mismatch stops before gates or writes.
2. **Run fresh mandatory gates first.** From `loop-fork/`, run in order:
   `bun run check`; canonical
   `bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts`;
   `bun run build`; `LOOP_TEST_CERTIFICATION_MODE=single-file bun run test:ci`;
   `./harness preflight --json`; and `./harness stop-gate --json`. Do not run `bun run fix`.
   Preserve exact command, exit, summary, certified file count, and baseline allowlist result in D6
   evidence. A failed or incomplete command stops; never convert tolerated counts into green.
3. **Regenerate only bounded non-frozen D6 surfaces from actual results.** Authorized execution
   writes are limited to both D6 `eval.json` files, D6 `task-log.md`, D6
   `artifacts/green/verification.md` and any predeclared sibling command-output files under that
   same `artifacts/green/` directory, plus append-only root `status.md`. Preserve existing useful
   history. Both evals must truthfully read pass with `baseline_failures: []` and an empty by-name
   allowlist. Do not edit D6 source/test, canonical contracts, run plan, `meta.json`, Harness state,
   frozen `artifacts/red/`, D15 evidence, formatter evidence, or unrelated dirty files.
4. **Run root verifier after dual eval regeneration.** From repository root run exactly
   `./scripts/verify.sh harvto-d6-readonly-attach harvto-d6-readonly-attach`. Record actual output
   in the bounded green evidence/status surfaces. If it fails, leave evals honest, record the
   failure, and stop without review or lifecycle action.
5. **Prove zero implementation or frozen-state change.** Recheck D6 source/test dirty count, exact
   implementation object and blob hashes, five contract hashes, four red hashes, D15 protected
   hashes/inventories, Harness state/hashes, formatter terminal counts, bundle hashes, root
   `.loop/`, utility `0/off/0`, and normal versus ignore-all-space numstats for every written file.
   Freeze the exact follow-up-review evidence inventory. Do not stage or commit before review.
6. **Submit exactly one follow-up review through loop bridge.** Send one zero-write Claude
   `review_request` for unchanged SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827`, naming prior
   `REVISE` `3ef105fc-210f-4b56-8dcb-1903fc05406d`, supervisor authorization, formatter `PASS`
   `fed87397-a1a1-4e36-a984-2775a643b648`, fresh gate outputs, both green evals, root verifier,
   frozen hashes, and zero-change proof. No duplicate request, timeout retry, helper route, or
   inferred verdict is allowed.
7. **Consume verdict fail closed.** Only literal Claude `PASS` naming exact D6 SHA authorizes close.
   On `REVISE`, silence, wrong SHA, partial response, or evidence mismatch, record bounded status
   and stop without code rework, review retry, Harness mutation, or D7 promotion.
8. **Close D6 exactly once after PASS.** Capture pre-close `harness status --json`, both Harness
   hashes, current-task contents, task-status inventory, and terminal-count proof. Run exactly one
   `./harness done harvto-d6-readonly-attach`; never retry. Require positive proof that only D6 made
   the expected active-to-done transition, no other task changed, eval remains pass, and no active
   D6 remains. Any failed, unreadable, or partial transition stops without hand repair.
9. **Create separate D6 bookkeeping commit.** Determine exact D6-owned close delta against the
   captured pre-state; explicitly stage only reviewed D6 contract/evidence/eval/Harness bookkeeping
   plus this `PLAN.md` and append-only `status.md` where required. Never broad-stage. Exclude source,
   tests, frozen red, `.loop/`, formatter artifacts, unrelated parked ideas, and unrelated dirty
   work. Prove cached path set, hashes, normal/ignore-space numstats, and
   `git diff --cached --check`; commit once without amendment. Verify committed scope, empty index,
   terminal D6 state, unchanged implementation/frozen evidence, bundles, and utility state.
10. **Handover before D7.** Update plan/status with exact verdict, close, commit, checks, risks, and
    next action; produce validated governed handover. D7 cannot start in the same unhanded-over
    lifecycle.

### D7-D12 isolated campaign

Proceed strictly in order: `harvto-d7-handoff-identity`, `harvto-d8-stale-write-lease`,
`harvto-d9-duplicate-emission`, `harvto-d10-guarded-apply`, `harvto-d11-composer-nudge`, then
`harvto-d12-socket-discovery`. For each task:

1. Validate predecessor handover, empty index, no active predecessor, preserved dirty work,
   utility `0/off/0`, and exact parked-task identity. Promote once into a new isolated Harness run.
2. Build canonical spec/plan/tasks/verify from the parked report; freeze exact base, invariant,
   paths, red command, controls, gates, and no-UI determination. Obtain literal Claude zero-write
   `PLAN PASS`, then force-add only reviewed contract files and create a separate plan-freeze commit.
3. Reproduce deterministic exact-base red without production mutation. Preserve command/output,
   decisive assertion, hashes, and inventories. Stop and re-plan if premise does not reproduce.
4. Implement smallest bounded fix with named positive, negative, replay, fail-closed, race, and
   isolation controls relevant to that defect. Never absorb a later defect or touch Harvto,
   provider/model, dependencies, remote, release, deploy, or unrelated cleanup scope.
5. Run focused controls, check, canonical TypeScript, build, certified serial `test:ci`, Harness
   preflight/stop-gate, dual passing evals with empty baseline failures and by-name allowlist, and
   root verifier. Capture screenshots plus DOM only if rendered UI changes.
6. Prove exact scope and evidence integrity; explicitly stage and create one implementation commit.
   Obtain literal Claude zero-write `PASS` for that exact SHA. A `REVISE` permits changes only in
   current approved scope, followed by fresh full gates, a new commit, and new exact-SHA review.
7. After exact-SHA `PASS`, capture pre-close state, close exactly once, prove one positive terminal
   transition, and create a separate exact-path bookkeeping commit. Verify empty index and all
   preservation boundaries.
8. Update `PLAN.md` and append-only `status.md`, then complete a governed handover. Start successor
   only after the next loop validates that handover.

Task invariants remain separate: D7 preserves model, effort, workspace, run, manifest, and authority
identity; D8 rejects stale/dead utility write authority before mutation; D9 emits one durable
acknowledgement once across retry/replay; D10 guarded apply requires exact existing applicable target
and preimage; D11 uses durable recovery transport without typing over non-empty composers; D12 uses
manifest-recorded tmux socket/target identity and rejects default-socket inference.

### Acceptance and stop conditions

- D6 mandatory commands and root verifier are fresh and green; both evals pass with empty baseline
  failures and empty by-name allowlist; D6 code, contracts, frozen red, and implementation SHA never
  change.
- Exactly one authorized follow-up review is sent. D6 receives literal exact-SHA `PASS`, closes once
  only after that PASS, and receives one separate exact-path bookkeeping commit before D7.
- D7-D12 each complete plan review/freeze, exact-base red, bounded fix, fresh full verification,
  dual evals, implementation commit, exact-SHA review, one close, separate bookkeeping, and governed
  handover before the next task.
- Stop immediately on authority, hash, scope, lifecycle, evidence, gate, review, or close mismatch.
  Never retry a one-shot action, infer PASS, weaken checks, repair Harness by hand, overwrite frozen
  evidence, route utility, or discard existing work.

### Plan review corrections — run 83, epoch `1786912909823827` (plan-only, read-only re-verification)

Re-verified this review with no writes outside `PLAN.md`, no gate run, no lifecycle action, no
review request, no staging, no helper route:

- `shasum -a 256` on both run-82 bundles reproduces Claude
  `71f3ea1bdd698d8d8835f1cd6ed7a1d71ff900872e50009f7a79491581dda3d7` and Codex
  `bba79e5993906b1a5db3f163b81ffc0192abd9083990707a73532baae05a6a19`; both parse `status: "ready"`,
  `epoch 1786912909823827`, `gitHead ef17eb08139a7300316a3564782c216e7f19cfaf`, key `head` absent.
- `git rev-parse HEAD` = `ef17eb08139a7300316a3564782c216e7f19cfaf`;
  `254e1749ca67ad1d81cd434ef01db0aeabae5827^{commit}` resolves; `git diff --cached --name-only` = 0
  lines; `git show --stat 254e174` = exactly `loop-fork/src/loop/tmux.ts` and
  `loop-fork/tests/loop/tmux.test.ts`, 810 insertions, 53 deletions.
- `loop-fork/harness status --json`: `active_task harvto-d6-readonly-attach`, `meta.status active`,
  `eval_status pending`; hashes unchanged `tasks.json`
  `42b30be61071b60a8e9d6838565d25a2abf36d7a2d8fc35499516f5f415f214d`, `current-task`
  `f15fd0c0490dece3829ff14cb75706c5f696cca66d3bae8485b4a30a632a4e4e`.
- Root eval `runs/harvto-d6-readonly-attach/eval.json` is `verdict: "fail"`; loop-fork eval
  `loop-fork/runs/harvto-d6-readonly-attach/eval.json` is `status: "pending"` with
  `verdict: "pending"`; both still carry the one stale inherited formatter `baseline_failures`
  string. Both `parked-ideas.jsonl` entries for `harvto-d7-handoff-identity`,
  `harvto-d8-stale-write-lease`, `harvto-d9-duplicate-emission`, `harvto-d10-guarded-apply`,
  `harvto-d11-composer-nudge`, `harvto-d12-socket-discovery` read `status: "parked"` (D1/D3/D4/D5/D6/D15/D16
  read `promoted`), so the D7-D12 promotion order in this plan matches actual parked identity.

Corrections binding on execution (continue the numbering of the run-82 corrections):

20. **`status.md` exists; line count in correction 13 is stale.** `wc -l status.md` = **3611**
    (was 3444 at run 82). `git check-ignore -v PLAN.md status.md` exits 1 — neither is ignored.
    No create step is needed before implementation; the rule stays append-only, one run-83 entry per
    bookkeeping commit, never written before the corresponding capture evidence exists. This
    plan-only session must leave `status.md` byte-identical: its handover hash
    `c442b2eea8d0a9de4f6e5096d7541307eb87b135173fe148273efa3fe80ffa85` must still match at execution
    preflight. `PLAN.md` hash `a67a1cae05aa13876d86bcf9d3c15148292456ab36e79301c000054a76201975` is
    superseded by this amendment; preflight must re-derive and record the new `PLAN.md` hash and must
    not treat the handover value as a mismatch stop.
21. **The root verifier re-runs the same four gates — do not read step 4 as an independent check.**
    `scripts/verify.sh` runs `bun run check`, the canonical `bunx tsc` line, `bun run build`, and
    `bun run test:ci` itself (all inside `loop-fork/`), then requires
    `runs/<task-id>/eval.json` to exist and pipes it to `scripts/check-baseline-allowlist.py`.
    Step 2's separate runs are for per-gate evidence capture; the verifier is the sealing run. Both
    are still required, and a divergence between the two runs of the same gate is a stop condition,
    not a retry.
22. **The verifier machine-checks only the ROOT eval; the loop-fork eval is unchecked by it.**
    `scripts/verify.sh` sets `ARTIFACTS_DIR="runs/${TASK_ID}"` relative to repo root, so
    `loop-fork/runs/harvto-d6-readonly-attach/eval.json` never reaches the allowlist gate.
    Step 3 must additionally run `python3 scripts/check-baseline-allowlist.py
    loop-fork/runs/harvto-d6-readonly-attach/eval.json` explicitly and record its exit and stdout.
    Claiming "dual passing evals" from a single verifier run is a fail-open.
23. **Know the gate's exact predicates before writing either eval.** `check-baseline-allowlist.py`
    requires: top-level `verdict` (falling back to `result`) exactly `"pass"`; a `baseline_failures`
    key present somewhere and an empty list at EVERY occurrence; no `result`/`status`/`verdict`
    value whose text normalizes to contain both `baseline` and `fail`; and no other
    `*baseline*fail*` key holding a non-empty/true/non-zero allowance. The two evals have different
    current shapes — root has `verdict`/`summary`/`checks`, loop-fork has `status` plus `verdict`,
    `required`, `dimensions.unit.status` — so both `status` fields and both `verdict` fields must
    read `pass`, and `dimensions.unit.status` must read `pass`, or the loop-fork eval will assert a
    pass its own body contradicts. Do not delete existing keys to satisfy the gate.
24. **`bun run check` is `ultracite check` (read-only); `bun run fix` is `ultracite fix` (writes).**
    The standing ban is on `fix`. Before banking a green `check`, prove it wrote nothing: capture
    `git status --porcelain` and the dirty-file hash set immediately before and after, and stop if
    they differ. The formatter production commit `2e6adb8c…` is what makes this gate green now, so
    a still-red `check` means the frozen exclusion regressed — that is a stop, never a re-`fix`.
25. **`bun run build` emits an artifact; exclude it explicitly, do not just "verify dirty scope".**
    `build` is `bun build --compile --outfile loop src/cli.ts` and writes `loop-fork/loop`.
    `git check-ignore -v loop-fork/loop` = `loop-fork/.gitignore:1:/loop`, and `git ls-files
    loop-fork/loop` is empty, so it is ignored and untracked. Expect it to appear or change mtime
    after steps 2 and 4; that is not a scope violation and not evidence of source change. It must
    never be staged, and the step-5 zero-change proof must be stated over tracked paths so the
    binary cannot be misread as implementation drift.
26. **Name the review transport and mode in step 6.** Use bridge `loop-bridge-agents-collab-83`,
    `kind=review`, exact-SHA peer-verdict (omit `review_mode` or use `peer-verdict`) — never
    `review_mode=utility-audit`, which grants no approval — with zero writes, zero authority flags,
    and read scopes limited to the frozen follow-up evidence inventory. Carry the exact SHA
    `254e1749ca67ad1d81cd434ef01db0aeabae5827` in the request body.
27. **Bound the verdict wait and make silence explicit.** Consume the verdict only by reading the
    bridge inbox (`receive_messages`) and record each poll with its result. Declare the bounded wait
    before sending. On expiry, write a bounded status entry naming the timeout and stop: no second
    `review_request` for this SHA, no helper route, no inferred PASS, no lifecycle action.
28. **Re-verify the review's own preconditions immediately before sending.** Between step 5 and the
    send, re-run HEAD, empty-index, D6 blob hashes, five contract hashes, four red hashes, and both
    Harness hashes. A review request that quotes a stale evidence set is an evidence-integrity
    failure of the same class as the prior `FAIL` `903ea1ff-acc3-4968-ba7d-70151b01bc04`.
29. **Correction 15's exactly-one rule extends to the D6 evidence writes.** Post-write, assert
    COUNTS on the bounded green surfaces: the fresh gate tuple appears exactly once per surface and
    no second terminal or verdict record was appended. Pipe through `tr '\n' ' '` before claiming any
    phrase is absent, and diff `git diff --numstat` against `git diff --numstat --ignore-all-space`
    for every written file before staging.
30. **Corrections 16, 17, 18, and 19 carry forward unchanged into run 83** (no repo-wide formatting
    on evidence; utility ban outranks the bridge delegation mandate — route nothing even though
    `loop-bridge-agents-collab-83` is available; bundle immutability is re-checked after the
    bookkeeping commit and after close; close is gated on a positive terminal transition, not the
    absence of an error). Session identity for every artifact, `status.md` entry, commit message,
    review request, and handover produced by this campaign is run 83, epoch `1786912909823827`.
31. **Move the Harness gates after truthful loop-fork eval regeneration.** The current ordering in
    D6 lifecycle step 2 cannot succeed: `v2/kit/scripts/stop-gate.sh` first runs `preflight.sh`, then
    accepts only `pass`, `skipped`, or `sign-off-granted` for every required dimension; the current
    D6 eval requires `unit` and records it as `pending`. Running stop-gate before step 3 therefore
    exits 1 and, under step 2's stop rule, prevents the authorized eval correction. Split the
    sequence without omitting or retrying any gate: first run exactly the four code gates (`check`,
    canonical TypeScript, `build`, certified `test:ci`); only if all four pass, regenerate both
    evals from those results; run `check-baseline-allowlist.py` explicitly on BOTH evals; then run
    `./harness preflight --json` followed by `./harness stop-gate --json`; finally run the root
    verifier. The verifier's root-eval check remains the sealing repeat, not a substitute for the
    pre-Harness dual-eval checks.
32. **Predeclare the complete run-83 green command-output set and never overwrite it.** Step 1 must
    prove the following paths are absent, then freeze them as the only new sibling outputs allowed
    under `loop-fork/runs/harvto-d6-readonly-attach/artifacts/green/`:
    `run-83-01-check.txt`, `run-83-02-typecheck.txt`, `run-83-03-build.txt`,
    `run-83-04-test-ci.txt`, `run-83-05-loop-eval-baseline.txt`,
    `run-83-06-root-eval-baseline.txt`, `run-83-07-harness-preflight.json`,
    `run-83-08-harness-stop-gate.json`, and `run-83-09-root-verify.txt`. Capture combined
    stdout/stderr, exact command, and the command's own exit status for each; a pipeline must use
    pipefail and must not mistake `tee` success for command success. If any predeclared path already
    exists, stop before gates rather than append, truncate, rename, or choose a second filename.
33. **Do not let evidence capture invalidate the read-only gate proof.** Buffer each command's raw
    output in one validated `mktemp -d` directory outside the repository while it runs. First
    compare the repository status and dirty-file content-hash inventory before/after the command;
    only after that comparison succeeds may the buffered bytes be materialized at the exact bounded
    green path from correction 32. The ignored `loop-fork/loop` build product remains the sole
    expected non-tracked command artifact. This makes correction 24's before/after equality real
    rather than comparing a tree to itself plus its newly written log.
34. **Give the fresh result one frozen identity and make exactly-once checks mechanical.** Before
    the first execution write, freeze one run-83 verification ID and one RFC3339 UTC timestamp.
    Record that pair exactly once in each mutable summary surface: loop-fork eval, root eval,
    `task-log.md`, and `artifacts/green/verification.md`. Correction 29's count proof is over that
    unique pair, not over generic command names already present in historical text. Each raw file
    from correction 32 is referenced exactly once by `verification.md`; no second terminal,
    verdict, or verification block is appended.
35. **A sealing-run failure invalidates the provisional pass evals.** Evals become pass only after
    the first four code gates are green. If either explicit baseline checker, Harness preflight,
    Harness stop-gate, or any root-verifier subgate then fails or diverges, update both eval
    surfaces to an honest overall `fail` (including loop-fork `status`, `verdict`, and
    `dimensions.unit.status`), retain `baseline_failures: []` unless actual named baseline failures
    exist, record the exact failed command/output once, and stop without review or lifecycle action.
    Do not leave dual pass evals describing a verification sequence whose sealing run failed, and
    do not rerun the failed gate to recover green.
36. **Prove `status.md` append-only at byte level.** Before any authorized run-83 status append,
    freeze its byte length and SHA-256. After the append, require the complete pre-write bytes to be
    an exact prefix, require only the expected new run-83 block after that prefix, and count the
    frozen verification ID exactly once. This supplements line-count checks and prevents a rewrite,
    reorder, or newline-normalization from masquerading as an append.
37. **Make the one-review wait finite before the irreversible send.** Immediately before sending,
    freeze an absolute UTC deadline and a maximum of 30 inbox polls over at most 30 minutes, with no
    individual wait longer than 60 seconds. Record each `receive_messages` result. The first
    complete literal exact-SHA verdict ends the wait; expiry follows correction 27 and stops with no
    duplicate request, helper route, inferred PASS, close, or D7 promotion.

## Run-82 recovery amendment — resume run-79 epoch `1786902912181400`

This section is current authority. It supersedes run identity and next-action wording in the
run-80/run-81 recovery sections. Their detailed Phase A-C procedures, corrections 0-10,
preservation rules, acceptance criteria, and path restrictions remain binding unless tightened
below.

### Validated resume boundary

- Both ready bundles at
  `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/79/handoff/1786902912181400/{claude,codex}.json`
  parse and agree on `status: "ready"`, epoch `1786902912181400`, and `gitHead`
  `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`. SHA-256 is Claude
  `eb9fe4b1e5d16f6996e6bfb324fd26e201be68c30be0778fa459f5698fdb232b` and Codex
  `7d2eaa597964c12f70ccfccb3d9ccaab37919cd49dadc4bf3e93f198c0e46559`.
- Runs 80 and 81 are failed startup residue only. Both manifests report `status: "stopped"`; neither
  run contains a handoff file, `governess-state.json`, Governess control log, or populated topology
  or Governess manifest field. Preserve their files, but never resume, reconstruct, or use either
  run as lifecycle authority.
- Live HEAD is exact formatter production commit
  `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`; index is empty. D6 object
  `254e1749ca67ad1d81cd434ef01db0aeabae5827` resolves. Never amend, rebase, or replace either SHA.
- `loop-fork/harness status --json` reports `harvto-d6-readonly-attach` as sole active task,
  `meta.status: "active"`, eval `pending`. Harness hashes remain `tasks.json`
  `42b30be61071b60a8e9d6838565d25a2abf36d7a2d8fc35499516f5f415f214d` and `current-task`
  `f15fd0c0490dece3829ff14cb75706c5f696cca66d3bae8485b4a30a632a4e4e`.
- Formatter exact-SHA Claude verdict remains literal `PASS`
  `fed87397-a1a1-4e36-a984-2775a643b648`. Root `.loop/` remains 60 files and zero tracked files.
  Utility is hard-disabled: `LOOP_UTILITY_ENABLED=0`, `LOOP_UTILITY_DELEGATION_MODE=off`, and all
  execution preflights must positively prove the established third `0` state before work.
- This session is plan-only. No terminal write, evidence/config/source/test edit, lifecycle action,
  review request, staging, commit, helper route, or remote action is authorized here.

### Execution plan after plan mode

1. **Fail-closed preflight.** Revalidate both run-79 bundles and hashes; prove runs 80/81 remain
   stopped and non-authoritative; verify exact HEAD lineage, empty index, dirty scope, formatter
   verdict, formatter/D6/D15 inventories and protected hashes, ignored-plan provenance, Harness
   status/hashes, root `.loop/`, and utility `0/off/0`. Stop and preserve evidence on any mismatch.
2. **Capture D6 pre-state.** Before any write, create durable proof that D6 is sole active,
   eval-pending, and unclosed. Freeze one canonical formatter terminal tuple, exact additive JSON
   key names, exact `meta.json` transitions, all four pre-write key sets/hashes, and expected
   post-write inventory delta.
3. **Record one formatter terminal PASS.** Write exactly one standalone terminal `PASS`, tied to
   verdict `fed87397-a1a1-4e36-a984-2775a643b648` and SHA `2e6adb8c…`, in only formatter
   `task-log.md`, `meta.json`, loop-fork eval, and root eval. Existing eval keys/values remain
   byte-equivalent; additions and named meta transitions only. Never call formatter `harness done`.
4. **Capture post-state and bookkeep separately.** Prove only four authorized formatter surfaces
   changed, retained keys match, D6 remains sole active/eval-pending, Harness hashes and protected
   evidence match, utility stays `0/off/0`, HEAD/root `.loop/` stay unchanged, and index was empty
   before staging. Stage exact paths only, verify cached scope and `git diff --cached --check`, then
   create one bookkeeping commit on top of `2e6adb8c…`; never amend formatter production. Finish
   with empty index and governed handover.
5. **Review unchanged D6.** After validating formatter bookkeeping and handover, submit exactly one
   zero-write Claude review for unchanged D6 SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827`, carrying
   prior evidence-only `FAIL` `903ea1ff-acc3-4968-ba7d-70151b01bc04`, formatter `PASS`, frozen
   contracts, and preserved verification/evidence. Silence is not PASS; do not re-request same SHA.
6. **Close D6 once only on exact-SHA PASS.** On literal `PASS` naming exact D6 SHA, capture pre-close
   state, run one D6 Harness close, prove one expected terminal transition, and create a separate
   exact-path bookkeeping commit. On `REVISE`, mismatch, or partial Harness mutation, stop without
   retry, code rework, or hand repair. Complete governed handover before D7.
7. **Execute D7-D12 in order.** For each defect, use one isolated Harness lifecycle: validate prior
   handover and empty index; promote once; freeze bounded contract and obtain Claude `PLAN PASS`;
   make separate plan-freeze commit; preserve deterministic exact-base red; implement smallest
   scoped fix and controls; run focused plus full required verification and dual evals; make an
   explicit implementation commit; obtain literal exact-SHA Claude `PASS`; close once; make a
   separate bookkeeping commit; validate empty index; update plan/status; produce governed handover.
   No successor starts before predecessor is reviewed, closed, bookkept, and handed over.

### Hard boundaries and acceptance

- Never edit Harvto; merge, rebase, push, deploy, release, change provider/model/dependencies,
  delete or normalize evidence, weaken authority/checks, widen scope, route helpers/spend utility,
  or inject `/compact` or `/rename`.
- Formatter ends with exactly one standalone terminal PASS, no Harness close, unchanged production
  SHA, matching D6 pre/post proof, and one separate bookkeeping commit.
- D6 remains unchanged through review, closes once only after exact-SHA PASS, and receives separate
  bookkeeping before D7.
- D7-D12 each complete full isolated plan/red/fix/verify/review/close/bookkeeping/handover lifecycle.
  Root `.loop/`, ignored plans, protected evidence, preserved dirty state, and utility `0/off/0`
  remain intact throughout.

### Plan review corrections — run 82, epoch `1786902912181400`

Read-only re-verification performed this review (no writes, no lifecycle action, no helper route):

- Both bundles re-hashed: Claude `eb9fe4b1e5d16f6996e6bfb324fd26e201be68c30be0778fa459f5698fdb232b`,
  Codex `7d2eaa597964c12f70ccfccb3d9ccaab37919cd49dadc4bf3e93f198c0e46559`; both parse with
  `status: "ready"`, `epoch 1786902912181400`, `gitHead 2e6adb8c3c2cf502ffea28c714685b2ea14b9822`,
  key `head` absent (`None`) — revalidation must read `gitHead`, never `head`.
- `git rev-parse HEAD` = `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`;
  `254e1749ca67ad1d81cd434ef01db0aeabae5827^{commit}` resolves; `git diff --cached --name-only` = 0 lines.
- `loop-fork/harness status --json`: `active_task` `harvto-d6-readonly-attach`, `meta.status`
  `active`, `eval_status` `pending`. Hashes unchanged: `tasks.json`
  `42b30be61071b60a8e9d6838565d25a2abf36d7a2d8fc35499516f5f415f214d`, `current-task`
  `f15fd0c0490dece3829ff14cb75706c5f696cca66d3bae8485b4a30a632a4e4e`.
  `grep -c formatter loop-fork/.harness/tasks.json` = 0 (formatter not Harness-admitted).
- `find .loop -type f | wc -l` = 60, `git ls-files .loop | wc -l` = 0. Utility env is `0/off/0`.
- Runs 80 and 81 manifests both `status: "stopped"`, `topology` and `governess` `null`; no run-level
  handoff bundle and no `governess-state.json` under either (only vendored plugin-cache fixtures
  named `handoff*` exist, which are not lifecycle artifacts). Run 82 manifest is `status: "running"`.

Corrections binding on execution:

11. **Session identity is run 82.** Run-81 amendment A is archival: every artifact, `status.md`
    entry, commit message, review request, and governed handover produced by this recovery must name
    run 82 (`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/82`, bridge
    `loop-bridge-agents-collab-82`) as producing run and `1786902912181400` as the resumed epoch.
12. **Run 81 inherits run 80's preservation rule.** Both `.../80` and `.../81` are preserved on disk
    and never resumed, read as lifecycle authority, deleted, truncated, or normalized. Before Phase A
    proceeds, positively prove for each of 80 and 81: manifest `status` is `stopped`, no run-level
    handoff bundle, no `governess-state.json`. Silence is not proof — record the command output.
13. **`status.md` line count in correction C is stale.** Repository-root `status.md` exists, is
    tracked, dirty, and currently **3444 lines** (was 3403 at run 81, 3368 at run 80). The count is
    informational; the binding rule is unchanged — append-only, never create fresh, rewrite, reorder,
    or truncate. `git check-ignore -v PLAN.md status.md` exits 1 (neither ignored). `status.md`
    already exists, so no create step is needed; the campaign must append one run-82 entry per
    bookkeeping commit and never before the corresponding capture evidence exists.
14. **Carry the frozen RFC3339 UTC timestamp into the run-82 tuple.** Run-82 step 2 omitted it.
    The canonical formatter terminal tuple is exactly (`PASS`,
    `fed87397-a1a1-4e36-a984-2775a643b648`, `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`, one frozen
    RFC3339 UTC timestamp). Freeze it before the first write; never re-derive per surface, or the
    four surfaces will disagree.
15. **Prove exactly-one, not merely present.** Post-write verification must assert a COUNT, not
    existence: across the four authorized formatter surfaces the frozen verdict ID appears exactly
    once per surface, and `standalone_terminal_status` transitions exactly once. A grep that only
    proves the PASS is on the page cannot detect a duplicate terminal record — the named risk in
    `status.md`. Line-oriented grep also misses wrapped text; pipe through `tr '\n' ' '` before
    claiming a phrase is absent.
16. **Never run repo-wide formatting on evidence.** Formatter-evidence edits are hand-authored JSON
    and Markdown. Do not run `bun run fix` or any repo-wide formatter — it rewrites `runs/` evidence.
    If formatting is required, run biome on the touched file only. Before every commit, diff
    `git diff --numstat` against `git diff --numstat --ignore-all-space`; disagreement means an
    unintended reformat and is a stop condition.
17. **Utility ban outranks the bridge delegation mandate.** The bridge instructions mandate
    `route_task` for separable work; this campaign hard-disables utility (`0/off/0`) and forbids
    helper routing and spend. Plan authority wins: route nothing, and record the ban rather than
    treating a quiet channel as permission.
18. **Bundle immutability is an end-state check, not only a preflight one.** Re-hash both run-79
    bundles after the formatter bookkeeping commit and after D6 closure; the two SHA-256 values in
    the resume boundary must be byte-identical. Any change is a stop condition.
19. **D6 close is gated on a positive terminal transition, not on absence of error.** Capture
    pre-close `harness status --json` plus both harness hashes, run one close, then prove exactly one
    expected transition and that no other task changed status. A skip or unread output is a
    fail-open and must return nonzero.

## Run-81 recovery session amendment — plan review at epoch `1786902912181400`

Supersedes only session identity, stale counts, and the run-80 artifact rule below. All campaign
phases, run-80 corrections 0-10, run-79 corrections 1-9, preservation rules, acceptance criteria,
and path restrictions remain binding and unchanged.

### Re-verified read-only this review (run 81)

- Both bundles at `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/79/handoff/1786902912181400/{claude,codex}.json`
  parse: `status: "ready"`, `epoch 1786902912181400`, `gitHead 2e6adb8c3c2cf502ffea28c714685b2ea14b9822`.
  SHA-256 Claude `eb9fe4b1e5d16f6996e6bfb324fd26e201be68c30be0778fa459f5698fdb232b`, Codex
  `7d2eaa597964c12f70ccfccb3d9ccaab37919cd49dadc4bf3e93f198c0e46559`. Key `head` is absent/`None` in
  both, confirming run-79 correction: revalidation must read `gitHead`.
- `git rev-parse HEAD` = `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`; `2e6adb8c…^{commit}` and
  `254e1749…^{commit}` both resolve. `git diff --cached --name-only` = 0 lines.
  `git show --stat 2e6adb8c` lists only `loop-fork/biome.jsonc` (1 insertion), subject
  `fix: exclude generated run evidence from Biome`.
- `./harness status --json`: `active_task` `harvto-d6-readonly-attach`, `meta.status` `active`,
  `eval_status` `pending`. Hashes unchanged: `tasks.json`
  `42b30be61071b60a8e9d6838565d25a2abf36d7a2d8fc35499516f5f415f214d`, `current-task`
  `f15fd0c0490dece3829ff14cb75706c5f696cca66d3bae8485b4a30a632a4e4e`. `grep -c formatter
  loop-fork/.harness/tasks.json` = 0, confirming the formatter is not Harness-admitted.
- `find .loop -type f | wc -l` = 60; `git ls-files .loop` = 0. Utility env is `0/off/0`.
- Current key sets confirm corrections 3 and 4 remain accurate:
  `loop-fork/runs/harvto-formatter-evidence-scope/eval.json` =
  `[baseline_failures, dimensions, required, status, task_id, verdict]`;
  `runs/harvto-formatter-evidence-scope/eval.json` =
  `[baseline_failures, checks, summary, task_id, verdict]`; formatter `meta.json` carries
  `status`, `lifecycle`, `standalone_terminal_status`, `harness_admitted`,
  `exact_sha_review_verdict`, `exact_sha_review_verdict_id`.

### Amendments

A. **Session identity is run 81, not run 80.** This recovery executes in run 81
   (`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/81`, bridge
   `loop-bridge-agents-collab-81`). Every artifact, `status.md` entry, commit message, review
   request, and governed handover produced by the recovery must name run 81 as the producing run and
   epoch `1786902912181400` as the resumed handover epoch. Wording of "run-80 execution" below is
   read as "recovery execution under the run-80 corrections".

B. **Run-80 artifacts are preserved, not deleted.** `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/80`
   exists on disk (`manifest.json`, `transcript.jsonl`, `world-model/`, `codex-home/`, ...). It is
   abandoned as authority and must never be resumed, read as lifecycle authority, or used to derive
   state — and equally must never be deleted, truncated, or normalized. Confirm no handoff bundle
   exists under run 80 before Phase A; if one is found, stop and report rather than adopting it.

C. **Correction 2's `status.md` line count is stale.** Repository-root `status.md` is tracked, dirty,
   and currently **3403 lines** (was 3368 when correction 2 was written). The count is informational
   only; the binding rule is unchanged — append-only, never create fresh, rewrite, reorder, or
   truncate. `git check-ignore -v PLAN.md status.md` exits 1 (neither ignored), so both stage by
   exact path with plain `git add` and enter bookkeeping commits only. Do not re-verify against the
   3368 figure; treat any line count >= 3403 with an intact prefix as expected.

D. **Pre-state capture must record the verbatim pre-write key sets.** Before the single formatter
   terminal write, the Phase A pre-state capture records the full sorted key list and SHA-256 of all
   four authorized surfaces (`loop-fork/runs/harvto-formatter-evidence-scope/{eval.json,meta.json,task-log.md}`
   and `runs/harvto-formatter-evidence-scope/eval.json`). The post-state check then proves, per file,
   that the new key set is a strict superset of the old and every retained key's value is
   byte-equivalent — the additive proof required by correction 3, made mechanical rather than
   by inspection.

## Post-run-80 recovery binding — resume epoch `1786902912181400`

This section supersedes only run/session identity and next-action wording in the run-80 section
below. Its campaign phases, corrections 1-10, preservation rules, acceptance criteria, and exact
path restrictions remain binding.

### Recovery decision

- Resume from both run-79 ready bundles at
  `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/79/handoff/1786902912181400/{claude,codex}.json`.
  Do not resume or reconstruct malformed run 80: launcher exited during Claude development-channel
  confirmation before Governess/topology creation, and its partial session was torn down.
- Both bundles parse and match `status: "ready"`, epoch `1786902912181400`, and `gitHead`
  `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`. SHA-256 remains Claude
  `eb9fe4b1e5d16f6996e6bfb324fd26e201be68c30be0778fa459f5698fdb232b` and Codex
  `7d2eaa597964c12f70ccfccb3d9ccaab37919cd49dadc4bf3e93f198c0e46559`.
- Read-only recovery validation found HEAD `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`, parent
  `13b02be9b1783bbc7d955ff05e4470cb733dee9b`, empty index, formatter commit path exactly
  `loop-fork/biome.jsonc`, and D6 object `254e1749ca67ad1d81cd434ef01db0aeabae5827`.
- `./harness status --json` is lifecycle authority and reports current task
  `harvto-d6-readonly-attach`, status `active`, eval `pending`. Harness hashes remain
  `42b30be61071b60a8e9d6838565d25a2abf36d7a2d8fc35499516f5f415f214d` and
  `f15fd0c0490dece3829ff14cb75706c5f696cca66d3bae8485b4a30a632a4e4e`.
- Root `.loop/` remains 60 files, zero tracked. Utility environment is `0/off/0`. Formatter
  exact-SHA Claude `PASS` `fed87397-a1a1-4e36-a984-2775a643b648` remains complete.
- This is plan-only. No lifecycle transition, terminal record, evidence/config/source/test edit,
  staging, commit, review request, Harness action, helper route, or remote action is authorized in
  this session.

### Execution sequence after plan mode

1. Run Phase A preflight from current state. Revalidate both bundles, HEAD lineage, empty index,
   formatter verdict, D6/D15 inventories and protected hashes, ignored-plan provenance, Harness
   status/hashes, root `.loop/`, dirty scope, and utility `0/off/0`. Stop on any mismatch.
2. Capture durable D6 pre-state before writes. In that capture, freeze one canonical terminal tuple
   (`PASS`, verdict ID `fed87397-a1a1-4e36-a984-2775a643b648`, production SHA
   `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`, and one RFC3339 UTC timestamp), exact JSON key names,
   exact `meta.json` state transitions, and expected post-write removed-file match count. Do not
   infer or change schema after first write.
3. Record exactly one standalone terminal event in formatter `task-log.md`, `meta.json`, and both
   evals. Eval changes are additive only; existing verdict/status/baseline/check fields remain
   byte-equivalent. Never run formatter `harness done`.
4. Capture matching post-state and prove only four authorized formatter self-surfaces changed;
   D6 remains current `active`/`pending`, Harness hashes remain exact, protected evidence matches,
   HEAD and root `.loop/` remain unchanged, utility remains `0/off/0`, and index remains empty.
5. Explicitly stage only authorized formatter terminal/bookkeeping paths plus current root
   `PLAN.md` and append-only `status.md` when required by bookkeeping. Prove cached set and diff,
   run `git diff --cached --check`, and create one separate bookkeeping commit on top of
   `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`. Never amend formatter production commit.
6. Produce governed handover. Then execute Phase B: resubmit unchanged D6 SHA
   `254e1749ca67ad1d81cd434ef01db0aeabae5827` exactly once for Claude same-SHA zero-write review,
   carrying prior evidence-only `FAIL` `903ea1ff-acc3-4968-ba7d-70151b01bc04` and formatter `PASS`.
   Only literal exact-SHA `PASS` permits one D6 close and separate bookkeeping commit.
7. After D6 closure and governed handover, execute D7-D12 in strict order using isolated lifecycle
   gates in Phase C. No successor starts before predecessor exact-SHA PASS, single close,
   bookkeeping commit, empty index, and validated handover.

### Recovery acceptance

- Run 80 remains abandoned and unresumed; no state depends on its partial session.
- Formatter HEAD and D6 SHA remain unamended and unchanged. Formatter receives one standalone
  terminal PASS and no Harness close; D6 remains current active/eval-pending through formatter
  pre/post capture.
- Formatter bookkeeping, D6 closure bookkeeping, and every D7-D12 lifecycle use separate explicit
  commits with exact-path staging and empty-index boundaries.
- Utility stays hard-disabled; no helper routing/spend. Root `.loop/`, ignored plans, evidence, and
  unrelated dirty state remain preserved. All prohibited actions below remain prohibited.

## Run-80 authoritative resume plan — handover epoch `1786902912181400`

This section supersedes older next-action text below. Older sections remain campaign history.

### Validated boundary

- Both handoff files at
  `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/79/handoff/1786902912181400/{claude,codex}.json`
  parse and report `status: "ready"`, epoch `1786902912181400`, and `gitHead`
  `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`. Current SHA-256 values are Claude
  `eb9fe4b1e5d16f6996e6bfb324fd26e201be68c30be0778fa459f5698fdb232b` and Codex
  `7d2eaa597964c12f70ccfccb3d9ccaab37919cd49dadc4bf3e93f198c0e46559`.
- Live HEAD is exact formatter production commit
  `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`, with parent plan-freeze commit
  `13b02be9b1783bbc7d955ff05e4470cb733dee9b`; index is empty. Production commit contains only
  `loop-fork/biome.jsonc`. Never amend or rebase it.
- Formatter exact-SHA Claude verdict is complete: literal `PASS`
  `fed87397-a1a1-4e36-a984-2775a643b648` for exact commit `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`.
  Any older statement that request `8fde0b7b-36b6-4c75-ba30-b8b3f5424510` is pending is archival
  and superseded.
- Harness hashes match handoff: `tasks.json`
  `42b30be61071b60a8e9d6838565d25a2abf36d7a2d8fc35499516f5f415f214d` and `current-task`
  `f15fd0c0490dece3829ff14cb75706c5f696cca66d3bae8485b4a30a632a4e4e`. Harness reports
  `harvto-d6-readonly-attach` as sole active task, status `active`, eval `pending`.
- D6 implementation object exists at exact SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827`.
  Root `.loop/` remains 60 untracked files and zero tracked files. Existing tracked/untracked
  evidence, ignored plans, and coordination state remain preserved.
- No open question or technical blocker. This plan-only session authorizes no lifecycle transition,
  evidence edit, staging, commit, review request, close, source/test/config edit, or remote action.

### Hard preservation and authority rules

- Preserve formatter HEAD `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`, D6 implementation SHA
  `254e1749ca67ad1d81cd434ef01db0aeabae5827`, D6 frozen contract hashes, D6/D15 inventories,
  formatter evidence, root `.loop/`, ignored plans, and all existing dirty state. Never delete,
  regenerate, normalize, or weaken evidence.
- Formatter is standalone and was never Harness-admitted. Never call `harness done` for
  `harvto-formatter-evidence-scope`.
- D6 stays sole active, eval-pending, and unclosed until same-SHA Claude `PASS`. Do not edit,
  amend, recommit, rebase, park, or rework D6.
- Before executable campaign commands, set and prove `LOOP_UTILITY_ENABLED=0`,
  `LOOP_UTILITY_DELEGATION_MODE=off`, and `LOOP_AU_PAIR_ENABLED=0`. Route no helper and spend no
  utility.
- Never edit Harvto; merge, rebase, push, deploy, release, change provider/model/dependencies,
  broaden permissions, widen scope, inject `/compact` or `/rename`, or broad-stage (`git add -A`,
  `git add -u`, `git add .`, or directory staging).
- Stop on any authority, hash, inventory, index, scope, lifecycle, or gate mismatch. Preserve exact
  failure evidence; do not retry irreversible lifecycle actions or repair Harness by hand.

### Phase A — Formatter standalone terminal and bookkeeping

1. Revalidate both epoch bundles, exact HEAD/parent, empty index, dirty scope, formatter verdict,
   D6 and D15 full SHA-256/size inventories, five frozen D6 contract hashes, protected D15 close
   hashes, root `.loop/`, ignored-plan provenance, Harness hashes/status, and utility `0/off/0`.
2. Capture a durable pre-state showing D6 is the sole Harness task with status `active` and eval
   `pending`. Include exact Harness file hashes, HEAD, index, root `.loop/`, utility state, and
   evidence-inventory result.
3. Record exactly one standalone formatter terminal `PASS` tied to verdict
   `fed87397-a1a1-4e36-a984-2775a643b648` and production SHA
   `2e6adb8c3c2cf502ffea28c714685b2ea14b9822` in only these required lifecycle surfaces:
   formatter `task-log.md`, formatter `meta.json`, `loop-fork/runs/harvto-formatter-evidence-scope/eval.json`,
   and `runs/harvto-formatter-evidence-scope/eval.json`. Preserve prior eval facts and empty
   `baseline_failures`; create no second terminal record. Do not call Harness.
4. Capture matching post-state. Prove D6 remains sole active/eval-pending, both Harness hashes are
   unchanged, HEAD is unchanged, index is empty before staging, protected inventories/hashes match,
   utility remains `0/off/0`, and root `.loop/` is untouched.
5. Stage each authorized terminal/bookkeeping/evidence path explicitly. Compare cached path set to
   planned set, inspect cached diff, run `git diff --cached --check`, and prove no source, test,
   config, contract, `.loop/`, D6 lifecycle, or unrelated evidence path entered staging.
6. Create one separate explicit formatter bookkeeping commit. Do not amend formatter production.
   Verify committed path set/content, empty post-commit index, unchanged D6 Harness state, and all
   preservation checks. Append exact commit and proof to `PLAN.md` and `status.md`; produce governed
   handover before opening D6 review.

### Phase B — Unchanged D6 same-SHA review, single close, bookkeeping

1. After Phase A commit and handover, revalidate D6 frozen contract hashes, exact implementation
   SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827`, existing focused/full-suite/eval evidence, complete
   D6/D15 inventories, empty index, root `.loop/`, utility `0/off/0`, and D6 sole-active/eval-pending
   status. Do not recreate red or alter D6 code/contracts/evidence.
2. Resubmit unchanged SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827` to Claude for zero-write
   same-SHA exact review. Carry D6 `PLAN PASS` `80e774db-4748-4281-a6a0-1c9e54b7ccfc`, prior
   evidence-integrity-only `FAIL` `903ea1ff-acc3-4968-ba7d-70151b01bc04`, formatter `PASS`
   `fed87397-a1a1-4e36-a984-2775a643b648`, formatter bookkeeping commit, exact modified-path set,
   preserved red, mandatory suites, dual evals, and evidence-integrity proof.
3. Accept only literal Claude `PASS` for exact D6 SHA. On `REVISE` or any evidence mismatch, stop
   before close; do not rework code unless later authority explicitly changes scope.
4. On `PASS`, capture complete pre-close Harness state and terminal-record counts. Run exactly one
   `./harness done harvto-d6-readonly-attach`. Never retry. Prove one new D6 close record, no active
   D6, expected Harness hash/state delta only, unchanged implementation/evidence, and empty index.
5. Stage only explicit D6 close/bookkeeping/evidence paths, prove cached scope, and create one
   separate bookkeeping commit. Verify empty index and preserve all campaign boundaries. Append
   exact verdict/close/commit proof and produce governed handover before D7 promotion.

### Phase C — D7-D12 automatic isolated lifecycles

Execute strictly in order:

1. `harvto-d7-handoff-identity`: preserve model, effort, workspace, run, manifest, and authority
   identity across handoff.
2. `harvto-d8-stale-write-lease`: reject stale/dead utility write authority before mutation after
   epoch or authority changes.
3. `harvto-d9-duplicate-emission`: make one resolved acknowledgement produce one durable emission
   across retry and replay.
4. `harvto-d10-guarded-apply`: fail closed for absent, stale, or non-applicable targets with exact
   target and preimage evidence.
5. `harvto-d11-composer-nudge`: use durable recovery transport and preserve non-empty composers.
6. `harvto-d12-socket-discovery`: derive live-run discovery from manifest-recorded tmux socket and
   target identity, including non-default sockets.

For each task, complete this lifecycle before touching the next:

1. Revalidate prior bookkeeping commit, empty index, no active predecessor, root `.loop/`, utility
   `0/off/0`, preserved campaign evidence, parked task identity, and governed handover. Promote
   exactly once into its own Harness run; create/update its canonical spec, plan, tasks, verify,
   task log, metadata, and root/loop eval surfaces.
2. Freeze bounded invariants, authorized paths, named positive/negative/replay/fail-closed/isolation
   controls, exact red command, mandatory suites, acceptance thresholds, and no-UI determination.
   Obtain literal Claude zero-write `PLAN PASS` for exact contract hashes before source/test edits.
3. Resolve ignore provenance per file. Force-add each reviewed contract file explicitly, prove the
   cached set and hashes equal the reviewed set, then create a dedicated plan-freeze commit. Restore
   empty index and revalidate preservation state.
4. Reproduce deterministic exact-base red with production unchanged. Preserve command, output,
   exit, assertion, base SHA, path inventory, and before/after evidence hashes. If premise does not
   reproduce, stop and revise plan through Claude review; never manufacture red.
5. Implement smallest authorized fix and controls. Keep each defect invariant separate; do not
   absorb later tasks, Harvto, provider/model, dependencies, or unrelated cleanup.
6. Run focused red-to-green controls, canonical check/typecheck/build, complete certified serial
   suite, Harness preflight/stop-gate, dual evals with `baseline_failures: []`, root
   `scripts/verify.sh`, evidence/hash inventories, normal versus ignore-all-space scope accounting,
   and UI screenshot/DOM checks only if rendered UI changes.
7. Stage only explicit implementation/test/evidence paths authorized by reviewed plan. Prove cached
   path set, diff, numstat, `git diff --cached --check`, and exclusion of `.loop/`, unrelated dirty
   state, later tasks, Harvto, and bookkeeping. Create one implementation commit; never amend.
8. Obtain Claude literal zero-write exact-SHA `PASS` for exact implementation commit. On `REVISE`,
   change only current approved scope, rerun all required gates/evals, create a new commit, and seek
   new exact-SHA review. Never close on plan approval or stale SHA approval.
9. After exact-SHA `PASS`, capture pre-close state, close current Harness task exactly once, prove
   one expected terminal transition, then create one separate explicit bookkeeping/evidence commit.
   Verify empty index and no active predecessor.
10. Update `PLAN.md` and append `status.md` with exact evidence, risks, and next action. Complete a
    governed handover. Continue automatically to next numbered task only after successor validates
    that handover and prior lifecycle is fully closed/bookkept.

### Acceptance criteria

- Formatter has exactly one standalone terminal `PASS`, no formatter `harness done`, matching D6
  pre/post sole-active/eval-pending proof, and one separate bookkeeping commit. Formatter production
  remains exact unamended SHA `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`.
- D6 remains exact implementation SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827`, receives literal
  same-SHA Claude `PASS`, closes exactly once, and gets a separate bookkeeping commit before D7.
- D7-D12 each have isolated reviewed contracts, durable plan-freeze commit, exact-base red, bounded
  fix and controls, full green suites/evals, explicit implementation commit, Claude exact-SHA
  `PASS`, one Harness close, separate bookkeeping commit, and governed handover.
- Utility stays hard-disabled with no helper route or spend. Root `.loop/`, ignored plans, all
  protected evidence, and unrelated dirty state remain preserved. No prohibited action occurs.

### Plan review corrections — applied at epoch `1786902912181400` (run-80 plan review)

Binding for run-80 execution; override any looser wording above in the run-80 section.

0. **Boundary re-verified this review (read-only).** Both bundles parse with `status: "ready"`,
   `epoch 1786902912181400`, `gitHead 2e6adb8c3c2cf502ffea28c714685b2ea14b9822`; SHA-256 Claude
   `eb9fe4b1e5d16f6996e6bfb324fd26e201be68c30be0778fa459f5698fdb232b`, Codex
   `7d2eaa597964c12f70ccfccb3d9ccaab37919cd49dadc4bf3e93f198c0e46559`. `git rev-parse HEAD` =
   `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`; both `2e6adb8c…^{commit}` and `254e1749…^{commit}`
   resolve. Index empty (`git diff --cached --name-only` = 0 lines). Harness hashes match the
   recorded values; `current-task` = `harvto-d6-readonly-attach`. `find .loop -type f | wc -l` = 60;
   `git ls-files .loop` = 0.
1. **All run-79 plan review corrections 1-9 remain binding in run-80** and apply unchanged to
   Phase A, Phase B, and every Phase C task: check-ignore result recorded either way and `git add -f`
   mandated regardless; force-add file-by-file, never a directory and never `-A`/`-u`/`.`; read-only
   Biome invocations only (no `--write`/`--fix`/`--unsafe`, no `bun run fix`); fail-open fixture
   hygiene; Harness partial mutation is a stop, not a repair; phase ordering is a hard gate; bundle
   revalidation reads `gitHead`, not `head`.
2. **status.md exists and is append-only.** Repository-root `status.md` is tracked, dirty, 3368
   lines. Never create fresh, rewrite, reorder, or truncate it. Append a dated run-80 subsection at
   every phase boundary and at any stop, recording exact HEAD, index state, evidence-inventory
   result, verdict IDs, and the next bounded action. `PLAN.md` and `status.md` are both tracked and
   not ignored (`git check-ignore -v PLAN.md status.md` exits 1), so they stage with plain `git add`
   by exact path; they are bookkeeping only and must never enter an implementation commit.
3. **The terminal record is ADDITIVE; existing eval verdicts must not be rewritten.** Observed:
   `loop-fork/runs/harvto-formatter-evidence-scope/eval.json` already has
   `"status": "pass"`, `"verdict": "pass"`, `"baseline_failures": []`, `"required": ["unit"]`, and a
   `dimensions.unit` block; `runs/harvto-formatter-evidence-scope/eval.json` already has
   `"verdict": "pass"`, `"baseline_failures": []`, `summary`, and a ten-key `checks` object. Phase A
   step 3 therefore adds new keys recording the standalone terminal (verdict ID
   `fed87397-a1a1-4e36-a984-2775a643b648`, production SHA
   `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`, terminal timestamp) and must leave every existing key
   and value byte-equivalent. Do not flip, duplicate, or restate `verdict`, `status`,
   `baseline_failures`, `required`, `dimensions`, `summary`, or `checks`. Prove both files parse
   (`python3 -m json.tool`) before and after, and diff old-versus-new key sets to show additions only.
4. **Name the exact meta.json transition.** `loop-fork/runs/harvto-formatter-evidence-scope/meta.json`
   currently carries `"status": "active"`, `"lifecycle":
   "standalone-ratified-exact-sha-pass-received-terminal-pending-handover-prepared"`,
   `"standalone_terminal_status": "pending-fresh-loop"`, `"harness_admitted": false`, and
   `"exact_sha_review_verdict": "PASS"` / `"exact_sha_review_verdict_id":
   "fed87397-a1a1-4e36-a984-2775a643b648"`. The single terminal write updates `status`, `lifecycle`,
   and `standalone_terminal_status` and adds a terminal-timestamp key. Because
   `harness_admitted` is `false`, this transition changes no Harness state: prove
   `loop-fork/.harness/tasks.json` and `loop-fork/.harness/current-task` hashes are unchanged across
   the write and that no formatter record exists in `tasks.json`. Never call `./harness done` for the
   formatter.
5. **Pre-declare the moving accounting figure so revalidation cannot fail spuriously.** The formatter
   task log already records that the 720/720 removed-file byte-match figure is presently 718/720
   because this task's own `eval.json` and `meta.json` took authorized later writes. Phase A step 3
   writes those two files again plus `task-log.md`. Before writing, record the current inventory; the
   protected-inventory comparison in Phase A step 4 covers D6, D15, and all foreign evidence
   byte-for-byte, and explicitly excludes exactly the three authorized formatter self-surfaces
   `loop-fork/runs/harvto-formatter-evidence-scope/{eval.json,meta.json,task-log.md}` plus
   `runs/harvto-formatter-evidence-scope/eval.json`. State the expected post-write match count in the
   pre-state capture and require the observed post-state count to equal it exactly. Any change to a
   path outside that four-file exclusion is a stop.
6. **Name the paths that must NOT be staged.** Phase A step 5 and every later staging step must prove
   the cached set excludes `loop-fork/.harness/tasks.json`, `loop-fork/.harness/current-task`,
   `loop-fork/.harness/parked-ideas.jsonl`, `loop-fork/agents/coordination.jsonl`, `.loop/`, all D6
   paths (`loop-fork/specs/harvto-d6-readonly-attach/`,
   `loop-fork/runs/harvto-d6-readonly-attach/`, `runs/harvto-d6-readonly-attach/`), and
   `loop-fork/biome.jsonc`. These are preserved dirty/untracked state and stay out of every run-80
   commit unless a later phase explicitly authorizes the exact path.
7. **The formatter terminal record has no pre-existing schema.** `loop-fork/specs/harvto-formatter-evidence-scope/verify.md`
   defines no `standalone_terminal` field. Fix the exact key names and values in the Phase A
   pre-state capture before writing any file, then use that fixed set in all four surfaces so the
   record is one consistent standalone terminal, not four divergent ones. Do not edit the frozen
   plan-reviewed contract files (`spec.md`, `plan.md`, `tasks.md`, `verify.md`, run `plan.md`) —
   their PLAN PASS hashes are frozen by commit `13b02be9b1783bbc7d955ff05e4470cb733dee9b`.
8. **Phase B must re-prove formatter production is unamended.** Phase B step 1 additionally requires
   `git rev-parse HEAD`, `git log --oneline` lineage showing
   `2e6adb8c3c2cf502ffea28c714685b2ea14b9822` still present with parent
   `13b02be9b1783bbc7d955ff05e4470cb733dee9b`, and `git show --stat 2e6adb8c…` still listing only
   `loop-fork/biome.jsonc`. The Phase A bookkeeping commit lands on top; it never amends or reorders
   the production commit.
9. **One review request per SHA, no re-request on silence.** For Phase B and every Phase C exact-SHA
   review, submit exactly one zero-write review request per SHA and record its request ID. Silence is
   not a verdict: never infer PASS from an absent or timed-out reply, and never resubmit the same SHA
   to obtain a different verdict. Only a literal `PASS` naming that exact SHA authorizes a close.
10. **Every stop preserves evidence and reports.** On any authority, hash, inventory, scope,
    lifecycle, gate, or review mismatch, stop with the exact command, output, exit status, and
    before/after hashes recorded in the owning task's artifacts, append to `status.md`, and produce a
    governed handover. Do not retry irreversible lifecycle actions, hand-edit Harness, or self-resolve
    by parking, rebasing, widening scope, or weakening checks.

### Exact next step

Begin Phase A only after leaving plan mode, under the run-80 corrections above: perform read-only
preflight and capture the D6 sole-active/eval-pending pre-state, which must also fix the exact
terminal-record key set (correction 7) and the expected post-write inventory match count
(correction 5). Then record one standalone formatter terminal `PASS` as additive keys only
(correction 3) in exactly the four surfaces, capture the matching post-state, and make one separate
bookkeeping commit excluding the paths named in correction 6. Never call formatter `harness done`.

## Run-79 plan-only resume — handover epoch `1786863160636037`

### Result and authority

- Resume boundary validated from both ready bundles at
  `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/78/handoff/1786863160636037/{claude,codex}.json`.
  Both parse, report `status: "ready"`, epoch `1786863160636037`, and exact Git HEAD
  `254e1749ca67ad1d81cd434ef01db0aeabae5827`. Run-78 `governess-state.json` points to both exact
  paths at the same epoch; handover control records report both publications completed. Observed
  bundle SHA-256 values are Claude `9df07edbee14c4497668193bac45402ccba3c089dafec5453ab08926182d7d7e`
  and Codex `d5f17028f91fc1fea533bbd9e40da29617cb8a5dd77fb2b7f69661657c9e2b76`.
- Live resume state matches: HEAD is exact `254e1749ca67ad1d81cd434ef01db0aeabae5827`; parent is
  `ee1e7736d876d4b387f13580ec25ddf1c606e873`; index is empty; root `.loop/` contains 60 files and
  no tracked path; utility is positively `0/off/0`; Harness reports only
  `harvto-d6-readonly-attach` active with eval pending.
- Current supervisor authority is `9d4620f7-1b3f-470c-8d3b-c243706ca7b3`. It supersedes
  `d0d24bc6-82a7-4a59-905a-592d52524892`. Decision
  `8415f50f-adb0-4026-88de-ece616c1b060` remains discharged.
- D6 `PLAN PASS` `80e774db-4748-4281-a6a0-1c9e54b7ccfc` remains valid. Exact-SHA verdict
  `903ea1ff-acc3-4968-ba7d-70151b01bc04` remains `FAIL` for evidence integrity only. D6 code at
  `254e1749ca67ad1d81cd434ef01db0aeabae5827` is not changed, amended, recommitted, rebased, parked,
  or closed before a same-SHA `PASS`.
- New lifecycle rule from supervisor: at every plan freeze, force-add ignored contract files and
  commit the exact reviewed contract set before implementation so frozen hashes have Git objects
  and a durable commit baseline. Never broad-stage. This applies to
  `harvto-formatter-evidence-scope` and D7-D12; frozen D6 contract bytes remain untouched.

### Non-negotiable preservation boundary

- Preserve all existing worktree changes and every D6/D15 artifact byte-for-byte. Never edit or
  regenerate anything under D6 `artifacts/red/`; never delete evidence. Before any lifecycle
  attempt, inventory SHA-256 and size for the complete D6 and D15 evidence trees and compare them
  after every phase.
- Preserve frozen D6 contract hashes exactly: spec
  `aaa58574cce19e466cafd8b5d7a51c03ea052457611b91d21170bc461106dfaa`, plan
  `67fd510c0034378fcb83ef7ff7b99bdbb91ab92835d3de5d88299f2ce19b48d2`, tasks
  `0bf974e3769aad738e7f3e56ac3fe377ca4697ff836c444bacc0283ddf3f2f6b`, verify
  `5b4532f5011e5366a0735341a6861da11962d5a42abe917eb0b6e78669b29a9e`, and run plan
  `4b840882ffee189649c31b7011e9fc48b0f997e5070140493cde86eef73a7baf`.
- Preserve D15 close evidence at hashes
  `66666865793bc34d117e7f5a82d03e10b5482aa454dbe79bce8fb697f81e9d7e` and
  `fb0b63c017dea91d60fad622242b0fd7bd3f9eab14ce2fa48c23afdb41ba7a71`.
- Only production path authorized for the root-cause task is `loop-fork/biome.jsonc`. Its only
  semantic change is an exclusion for generated `loop-fork/runs/**` evidence. No source, test,
  spec, root `runs/**`, existing override, rule, dependency, provider/model, or Harvto change.
- Never run `bun run fix`. Never merge, rebase, amend, push, deploy, release, route helpers, spend
  utility, inject `/compact` or `/rename`, or change D6 lifecycle state to accommodate Harness.

### Phase 1 — Separate formatter task admission and plan freeze

1. Revalidate exact resume state, frozen hashes, evidence inventories, empty index, ignored-plan
   provenance, utility `0/off/0`, and D6 as sole active task. Record all checks in the formatter
   standalone run directory.
2. Create the bounded `harvto-formatter-evidence-scope` spec, plan, tasks, verify contract, run
   plan, and run log. Contract must define inherited exact-base red, one-file production scope,
   generated-evidence-only exclusion, fail-open controls, mandatory suites, evidence immutability,
   refusal handling, and exact-SHA review gates.
3. Attempt normal Harness promotion while D6 remains active and unchanged. Capture command, exact
   stdout/stderr, exit status, pre/post Harness file hashes, active-task identity, HEAD, and index.
   Do not retry a rejected promotion.
4. If Harness accepts concurrent promotion, prove D6 remains active and unmodified and continue
   under the formatter task identity. If Harness rejects it, finish the complete standalone
   `loop-fork/specs/harvto-formatter-evidence-scope/`,
   `loop-fork/runs/harvto-formatter-evidence-scope/`, and root
   `runs/harvto-formatter-evidence-scope/` contract/run structure; place exact refusal evidence in
   that task's artifacts; do not produce red, edit config, stage, commit, or change D6; then stop
   for supervisor ratification.
5. Obtain Claude literal zero-write `PLAN PASS` for exact contract hashes. On `REVISE`, update only
   formatter contracts, re-hash, and resubmit before red or production work.
6. At literal `PLAN PASS`, verify each ignored contract path resolves to the expected ignore rule.
   Force-add only the exact formatter spec/plan/tasks/verify and run-plan files, prove the cached set
   equals the reviewed hash set with no `.loop/`, source, test, evidence, or unrelated path, and make
   a dedicated plan-freeze contract commit. Verify commit blobs reproduce every reviewed hash and
   restore an empty index. This contract commit is separate from the one-file production commit.

### Phase 2 — Exact-base red and one-file fix

1. Record formatter implementation base after the plan-freeze commit. Reproduce inherited failure
   without changing evidence: run repository Biome check against pristine generated run artifacts
   and preserve command, output, exit status, checked-file inventory/count, config hash, evidence
   inventory, HEAD, and empty index. Red must prove current config inspects `loop-fork/runs/**` and
   fails on preserved generated JSON.
2. Add controls before or with the narrow fix:
   - Positive: `loop-fork/runs/**` generated evidence is excluded and remains byte-identical.
   - Fail-open: representative `loop-fork/src/**` and `loop-fork/tests/**` files remain checked;
     deliberate temporary invalid fixtures outside `runs/**` are rejected and removed without
     touching preserved evidence.
   - Scope accounting: every checked-file-count decrease is explained only by files under
     `loop-fork/runs/**`; root `runs/**`, specs, config, source, and tests are not accidentally
     excluded.
   - Config integrity: existing overrides and rules are unchanged except the narrow exclusion.
3. Edit only `loop-fork/biome.jsonc`. Do not format or rewrite evidence. Prove full evidence
   inventories and frozen hashes remain byte-identical immediately after the edit and every test.

### Phase 3 — Verification, one-file commit, and formatter review

1. Run plan-defined focused red-to-green controls, targeted Biome checks, `bun run check`, canonical
   TypeScript, `bun run build`, complete certified serial suite, Harness preflight/stop-gate when
   represented, both passing evals with `baseline_failures: []`, and root
   `scripts/verify.sh harvto-formatter-evidence-scope harvto-formatter-evidence-scope`. UI capture is
   not required because rendered UI does not change.
2. Recheck utility `0/off/0`, D6 lifecycle identity, all frozen hashes/evidence inventories, and
   exact Git scope. Stage only `loop-fork/biome.jsonc`; require cached path count one, normal and
   ignore-all-space numstats accounting, `git diff --cached --check`, and no contract/evidence file
   in the implementation commit.
3. Create one production commit containing exactly `loop-fork/biome.jsonc`. Do not amend or rebase.
   Obtain Claude literal zero-write exact-SHA `PASS`; reviewer must independently verify the
   generated-only exclusion, source/test fail-open guard, checked-file-count accounting, mandatory
   gates, one-file commit, and evidence byte identity. On `REVISE`, change only current task scope,
   rerun every required gate, create a new explicit commit, and seek a new exact-SHA verdict.
4. After exact-SHA `PASS`, close formatter task exactly once only if Harness admitted it and all
   lifecycle/eval gates pass. Capture pre/post close proof and make a separate exact-path
   bookkeeping/evidence commit. If task exists only as supervisor-ratified standalone state, follow
   the ratified close/bookkeeping procedure exactly; never infer authority.

### Phase 4 — Same-SHA D6 review and close

1. Reconfirm D6 contract hashes, D6/D15 evidence byte identity, D6 sole-active state, utility
   `0/off/0`, and unchanged implementation object
   `254e1749ca67ad1d81cd434ef01db0aeabae5827`. Do not recreate D6 red or alter its contract/code.
2. Rerun D6 focused controls and all mandatory gates against current tree with formatter exclusion
   active. Regenerate only authorized non-frozen eval/verification outputs; never touch frozen red
   or D15 close evidence. Both eval locations must pass with empty baseline failures.
3. Request Claude same-SHA exact review of D6 implementation SHA
   `254e1749ca67ad1d81cd434ef01db0aeabae5827`, explicitly carrying prior `FAIL` and formatter-task
   `PASS` evidence. Require literal zero-write `PASS` for that exact SHA.
4. Only after `PASS`, capture D6 pre-close lifecycle proof, run exactly one Harness close, prove one
   new close record and no active D6, then make one separate exact-path bookkeeping/evidence commit.
   Never retry close. Any mismatch or failed close stops with exact evidence.

### Phase 5 — Continue D7-D12 automatically

Run in order: `harvto-d7-handoff-identity`, `harvto-d8-stale-write-lease`,
`harvto-d9-duplicate-emission`, `harvto-d10-guarded-apply`, `harvto-d11-composer-nudge`, and
`harvto-d12-socket-discovery`. Each gets isolated Harness lifecycle, exact-base red, bounded fix,
named positive/negative/replay/fail-closed/isolation controls, mandatory suites, passing dual evals,
explicit implementation commit, Claude literal exact-SHA `PASS`, exactly one close, and separate
bookkeeping commit. At each plan freeze, force-add and commit exact reviewed contract files first.
Stop on any authority, scope, evidence, hash, lifecycle, or gate mismatch; never self-resolve by
parking, rebasing, widening scope, weakening checks, or changing prior task state.

### Acceptance criteria

- Formatter task has full governed lifecycle and exact evidence; production commit contains only
  `loop-fork/biome.jsonc` and excludes only `loop-fork/runs/**` generated evidence.
- All frozen D6/D15 evidence and D6 contract hashes remain byte-identical; root `.loop/` remains
  untracked; utility remains `0/off/0`; no helper routing or spend occurs.
- Formatter plan and exact-SHA reviews are literal Claude `PASS`; all focused, control, mandatory,
  eval, preflight/stop-gate, and root verifier checks pass.
- D6 implementation object stays exact `254e1749ca67ad1d81cd434ef01db0aeabae5827`, receives same-SHA
  literal Claude `PASS`, closes exactly once, and is separately bookkept before D7 starts.
- Every new frozen contract set is force-added and committed at plan freeze. D7-D12 then proceed in
  order under the same gates and prohibitions.

### Plan review corrections — applied at epoch `1786863160636037` (run-79 plan review)

These corrections are binding for run-79 execution and override any looser wording above in this
run-79 section.

1. **Contract paths are NOT git-ignored — do not treat that as an anomaly.** Observed:
   `git check-ignore -v` returns no rule (exit 1) for `loop-fork/specs/harvto-d6-readonly-attach`,
   `loop-fork/runs/harvto-d6-readonly-attach`, `runs/harvto-d6-readonly-attach`, and `.loop`. The
   only ignore rules in `loop-fork/.gitignore` are `/loop`, `node_modules`, `PLAN.md`, `.DS_Store`,
   `agents/coordination.jsonl`; root `.gitignore` ignores none of the campaign paths. Therefore
   Phase 1 step 6 must record, per contract path, either the exact matching ignore rule or the
   literal `git check-ignore` exit-1 no-rule result, and proceed either way. Absence of an ignore
   rule is not a stop condition and `git add -f` remains the mandated form so behaviour is identical
   in both cases.
2. **Force-add is file-by-file, never directory-by-directory.** Pass each exact contract file path
   as its own argument. Never pass `loop-fork/specs/harvto-formatter-evidence-scope/` or any
   directory to `git add`/`git add -f`, and never `git add -A`/`-u`/`.`. After staging, prove the
   cached set equals the reviewed hash set exactly (`git diff --cached --name-only` count equals the
   reviewed file count) before committing, and re-prove root `.loop/` is still 60 untracked files
   and appears in neither the index nor the commit.
3. **Biome exclusion syntax and root are pre-specified; verify the resolved config, do not assume.**
   `loop-fork/biome.jsonc` currently has no top-level `files` key at all — it is `$schema`,
   `extends: ["ultracite/biome/core"]`, and four `overrides` entries only. The narrow change is
   therefore an added top-level `files.includes` negation whose glob is relative to the config root
   `loop-fork/`, i.e. the pattern excludes `runs/**` as written in the file while denoting
   `loop-fork/runs/**` on disk. Before and after the edit, capture the resolved configuration
   (`biome explain`/verbose check output) to prove: (a) the `ultracite/biome/core` preset's own
   `files` settings compose as intended and are not silently replaced, (b) all four existing
   `overrides` blocks and their `includes` arrays are byte-identical, and (c) repository-root
   `runs/**` — which lies outside the Biome root — is untouched by the change.
4. **Read-only Biome invocations only.** Beyond the standing ban on `bun run fix`, the following are
   prohibited in every phase: `biome check --write`, `--fix`, `--unsafe`, `biome format --write`,
   `biome lint --write`, and any `bun run` script that wraps them. Red and controls use non-mutating
   checks and capture the checked-file inventory/count explicitly (for example a summary/verbose
   reporter), and every red/control step is bracketed by a full evidence SHA-256 inventory to prove
   read-only behaviour against preserved artifacts.
5. **Fail-open fixture hygiene.** The deliberate invalid fixture proving `loop-fork/src/**` and
   `loop-fork/tests/**` are still checked must live outside `loop-fork/runs/**`, outside every
   contract/evidence path, and outside the index. Prove by exact path that it is removed and that
   `git status --porcelain` shows no residue before staging, and prove it is absent from
   `git diff --cached --name-only` and from the commit tree.
6. **Harness promotion attempt: partial mutation is a stop, not a repair.** Hash
   `loop-fork/.harness/tasks.json` and `loop-fork/.harness/current-task` immediately before and
   after the single promotion attempt. Observed current state: `current-task` contains exactly
   `harvto-d6-readonly-attach`. If the attempt is rejected but left either file changed, or changed
   D6's record in any way, do not revert, re-run, hand-edit, or otherwise repair it — record the
   exact pre/post hashes and diff as refusal evidence and stop for supervisor ratification. Only a
   clean no-mutation rejection permits continuing to the standalone-structure branch.
7. **Phase ordering is a hard gate.** Phase 4 (D6 same-SHA review) starts only after a literal
   Claude exact-SHA `PASS` for the formatter production commit, or after explicit supervisor
   ratification of the standalone branch. If the formatter task ends in `REVISE`, refusal, or an
   unratified standalone state, stop; do not begin D6 re-review or D7-D12.
8. **status.md is append-only and required at every phase boundary of this run too.** `status.md`
   exists at repository root (2975 lines, tracked, dirty) and must never be created fresh,
   rewritten, or truncated. Append a dated run-79 subsection at each phase boundary and at any stop,
   recording exact HEAD, index state, evidence-inventory result, verdict IDs, and the next bounded
   action. `PLAN.md` and `status.md` updates are bookkeeping and must never enter the one-file
   `loop-fork/biome.jsonc` production commit.
9. **Bundle field names are fixed for revalidation.** Both bundles expose keys `agent`, `blockers`,
   `checks`, `dirtyFiles`, `epoch`, `gitHead`, `next`, `status`. Revalidation must read `gitHead`
   (not `head`) and require it to equal `254e1749ca67ad1d81cd434ef01db0aeabae5827`, `status` to be
   `ready`, and `epoch` to be `1786863160636037`, alongside the recorded bundle SHA-256 values.

### Current stop/next action

Phase 1 revalidation and formatter contract creation completed. The one authorized concurrent
Harness promotion attempt exited 1 because `harvto-d6-readonly-attach` remains active. Exact
pre/post hashes prove no mutation to `.harness/tasks.json`, `.harness/current-task`, the D6 record,
HEAD, or the empty index. Complete standalone formatter spec/run/root-run structure and refusal
evidence now exist.

Supervisor decision `99311508-b4a9-4bbd-af9a-f569c3cf16f5` ratified the standalone formatter
lifecycle. Claude returned literal zero-write `PLAN PASS`
`3a37e350-c389-4fd0-9b59-a49977b06a82` for request
`e621ac84-8d94-4bb1-b4cc-b19c325aca52` and the exact hashes spec `84b42f75…f3e1d9`, plan
`670df040…3ff5f`, tasks `1939347f…fd32b`, verify `79b85f53…34c6e4`, and run plan
`be1cf808…1a0107`.

Dedicated plan-freeze commit `13b02be9b1783bbc7d955ff05e4470cb733dee9b` now contains exactly
the five reviewed blobs with their PLAN PASS hashes. Its parent is
`254e1749ca67ad1d81cd434ef01db0aeabae5827`; the post-commit index is empty; root `.loop/` remains
60 untracked files; Harness, D6/D15 evidence, config, source, and tests remain unchanged.

Exact-base read-only red from `13b02be9…` is preserved: `bunx biome check --verbose .` exited 1,
checked 909 files, applied zero fixes, and reported exactly the pristine D15 pre/post-close JSON
evidence. Full output and the clean-tree 909-path inventory are under formatter `artifacts/red/`;
D6/D15 inventories, config, HEAD, index, Harness, source, and tests remain unchanged.

The one-file config edit and all focused controls pass. Parsed local scope is exact `["!runs"]`;
the four overrides are byte-identical; config self-lint checks exactly one file; clean accounting is
909→189 with zero additions, exactly 720 `runs/` removals, and 720/720 byte matches. Source/test
fixtures were selected and rejected, inherited preset-class representatives stayed excluded, and
all temporary controls are now absent from filesystem, status, index, and HEAD.

All four mandatory commands pass: 189-file read-only check, canonical TypeScript, build, and the
79-file certified serial suite. Dual evals now pass with empty `baseline_failures` and no tolerated
test-name allowlist; evidence and config hashes remained exact after every gate.

Root `./scripts/verify.sh harvto-formatter-evidence-scope harvto-formatter-evidence-scope` passed
lint, typecheck, build, all 79 serial test files, and the empty-baseline gate. Post-verifier evidence,
frozen hashes, Harness/D6 identity, utility, config, `.loop`, index, and control cleanup are exact.

Production commit `2e6adb8c3c2cf502ffea28c714685b2ea14b9822` has parent `13b02be9…` and
contains exactly one insertion in `loop-fork/biome.jsonc`. Normal and ignore-all-space numstats are
both `1 0`; the post-commit index is empty; all preservation boundaries remain exact.

Next bounded action: obtain Claude literal zero-write exact-SHA `PASS` or `REVISE` for
`2e6adb8c…` under request `8fde0b7b-36b6-4c75-ba30-b8b3f5424510`. Do not record standalone
terminal PASS, run formatter `harness done`, begin D6
same-SHA review, or mutate D6 first.

After formatter exact-SHA `PASS`, do not run `harness done` because Harness did not admit this task.
Record exactly one standalone terminal `PASS`, make separate explicit bookkeeping, and prove D6
remains sole active/eval-pending before resubmitting unchanged D6 SHA `254e1749…` for review.

## Run-78 execution plan — epoch `1786856716562565`

Plan review for this epoch is complete and this section is the authoritative execution contract, not a
plan-only note. The next action is the D15 pre-close lifecycle snapshot (step 2 below); no source edit
and no D6 work may start before the D15 bookkeeping commit exists with an empty index.
`status.md` already exists at repository root and is append-only — never rewrite or truncate it; append
a new dated section at every phase or context boundary.

### Objective

- Close `harvto-d15-teardown-process-orphans` exactly once under exact-SHA approval
  `b5280c18-08cc-439c-8009-9d121ea1dfe8`, then make one separate D15 bookkeeping/evidence commit.
- Do not start D6 until that commit exists and the index is empty. Then run D6-D12 in order as
  separate Harness tasks, each with plan review, exact-base red proof, bounded fix, full gates,
  explicit implementation commit, Claude exact-SHA zero-write `PASS`, exactly one close, separate
  bookkeeping commit, and governed handover.
- Utility remains hard-disabled. No helper routing or spend. Never edit Harvto; merge, rebase, push,
  deploy, release, change provider/model/dependencies, delete evidence, weaken authority, widen
  scope, or inject `/compact` or `/rename`.

### Reviewer authority ledger — 2026-08-16

Maintained by the Claude reviewer session. Read before acting on any older reviewer instruction.

- D6 `PLAN PASS` `80e774db-4748-4281-a6a0-1c9e54b7ccfc` is **valid**. The contract amendment was
  rolled back and all five files hash to the originally frozen values, verified by recomputation.
  No fresh D6 plan verdict is required.
- D6 exact-SHA `FAIL` `903ea1ff-acc3-4968-ba7d-70151b01bc04` stands for implementation SHA
  `254e1749ca67ad1d81cd434ef01db0aeabae5827`. The failure is **evidence integrity only**; the
  committed code is correct and must not be reworked. The same SHA is re-reviewed once the tree is
  clean. `FAIL` authorizes no Harness close.
- Current supervisor authority is `9d4620f7-1b3f-470c-8d3b-c243706ca7b3`: the formatter repair is a
  separate full-lifecycle task changing only `loop-fork/biome.jsonc` to exclude generated
  `loop-fork/runs/**` evidence. Never run `bun run fix`; never reformat evidence to obtain green.
- Superseded or discharged, do not act on either: `d0d24bc6-82a7-4a59-905a-592d52524892` (superseded by `9d4620f7`) and
  `8415f50f-adb0-4026-88de-ece616c1b060` (its corrective re-freeze is moot after the rollback).
- `bun run check` was already red at D6 base `ee1e7736…`; the red is inherited from `ee1e773`, not a
  D6 defect. Root cause is `biome.jsonc` declaring no `runs/**` exclusion.
- Escalated, not actioned: canonical contracts are frozen by hash but untracked until bookkeeping, so
  any edit destroys the frozen bytes. Supervisor decision pending; do not widen a task to fix it.

Full reviewer evidence, including the real-tmux 3.7b validation of the D6 query construction, is in
the `status.md` section "2026-08-16 — Claude reviewer handover".

Reviewer session closed at epoch `1786863160636037` with HEAD `254e1749…`, empty index, and the five
D6 contract hashes still matching the frozen `PLAN PASS` set. Next bounded action is the separate
`harvto-formatter-evidence-scope` lifecycle without mutating sole-active D6; if Harness rejects
promotion, capture exact output and stop for supervisor ratification.

### D6 active plan — 2026-08-16

- D15 is closed and separately bookkept at exact base
  `ee1e7736d876d4b387f13580ec25ddf1c606e873`; the index was empty before D6 promotion.
- `harvto-d6-readonly-attach` was promoted exactly once at `2026-08-16T07:07:05Z` and is the sole
  active Harness task with eval pending. Root `.loop/` remains 60 untracked files and utility is
  `0/off/0`.
- Source trace found the D6 owner in `loop-fork/src/loop/tmux.ts`: the exact Claude
  suggested-composer recovery rejects every nonzero `window_active_clients` count, but tmux exposes
  per-client `client_readonly` state and guarantees read-only clients cannot affect pane keys.
- Canonical D6 contracts authorize only `loop-fork/src/loop/tmux.ts` and
  `loop-fork/tests/loop/tmux.test.ts` for implementation. They require exact target
  session/window/client binding, stable read-only classification around the mutation boundary,
  writable/unknown fail-closed behavior, existing pane/composer protections, replay safety, and
  other-window isolation.
- D11 remains separate: D6 does not change Governess `answer-prompt` or `nudge` transport.

Canonical hashes and the zero-source/test-diff boundary passed. Claude plan request
`b09a991e-23fb-4366-a663-78cf986f95b9` is durably pending, but exact pane inspection found Claude
idle behind stale non-empty draft `ping codex to start the D15 pre-close snapshot`. The bridge
correctly refuses terminal injection into that composer, and Codex will not clear, submit, or type
over it. Supervisor escalation `9961797c-a5bf-4d0f-8461-9cea17dc9a5e` requests safe Claude attention
or a fresh governed reviewer session.

Next atomic action: receive literal `PLAN PASS` or `REVISE` after the stale Claude composer is safely
resolved. No red regression or production edit starts first; do not duplicate the pending request.

Claude returned literal `REVISE` `cf16415b-f17f-4f1f-90cc-6a1327e290f1` with zero writes/helpers/
spend. Required planning corrections are B1: include the post-send raw `activeClients === 0`
changed-suggestion consumer and prove `candidate-changed` under stable read-only viewers; B2: prove
target-window membership by pane-bound `window_active_clients_list` identity intersected with
session-bound `client_readonly`, using count only as a cross-check; B3: keep variable identities out
of the fixed-arity marker and define explicit zero/empty/empty synthetic-shim semantics. Also record
that deterministic query tests do not certify deployed tmux output; unsupported output fails closed.

Next atomic action: re-hash the revised canonical artifacts and run plan, prove the exact base and
zero source/test diff, then request a fresh literal plan verdict. No red or production edit first.

### D15 closure result — 2026-08-15

- Resume bundles, bootstrap binding, exact HEAD/parent, empty index, five-path inherited tracked
  scope, 16 non-root untracked paths, 60-file root `.loop/`, utility `0/off/0`, frozen hashes, and
  exact-SHA PASS `b5280c18-08cc-439c-8009-9d121ea1dfe8` all revalidated before close.
- Pre-close lifecycle snapshot
  `loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/close/pre-close-lifecycle.json`
  records 11 files, terminal count 0, active D15, exact HEAD, empty index, full `-uall` status, byte
  sizes, SHA-256 values, and bounded tails.
- Exactly one `./harness done harvto-d15-teardown-process-orphans` exited 0. Post-close snapshot
  records `active_task: null`, terminal count 1, unchanged total count 61, removed `current-task`,
  changed `tasks.json`, unchanged HEAD, empty index, no source/test change, and root `.loop/` count
  60. No retry occurred.
- Next atomic action is exact-path D15 bookkeeping/evidence staging and one separate commit. D6 may
  start only after that commit exists and the index is empty.

### Validated resume boundary

- Both ready bundles at
  `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/77/handoff/1786856716562565/{claude,codex}.json`
  parse, carry `status: "ready"`, agree on epoch `1786856716562565`, and bind exact live HEAD
  `5f5ddba66cdb1bc5d8f6212b763323f507b0b777`.
- Bundle validation is not parse-only. Before acting, recompute SHA-256 of `claude.json`, `codex.json`,
  and `continuation.md` and match each against `manifest.json` `bundles.*.digest` /
  `continuation.digest`; confirm `manifest.json` `epoch` equals `1786856716562565` and equals the
  containing directory name. Expected digests: claude
  `08ca8cfaf0f9b379b9c36c0bc6b5034427efc89f2efe2a641da6e12e56f5d86d`, codex
  `4ea9cbc4ffe572e9644723ee2677d242b265ab20fa668ef7c44a2d80957749bc`, continuation
  `6f1435dfa29ee37266becbe639e53154ad97c512c954ac09357f208ed73409c0`. Any digest or epoch mismatch
  stops the resume; re-reading the bundle text is not a substitute for the digest check.
- HEAD parent is `fb71f47bb126a39eae7f1613fa952c994421de5e`; the index is empty. The implementation commit
  modifies exactly the approved six production and three test paths. Root `.loop/` remains
  untracked with 60 files. Utility is positively `0/off/0`.
- Harness reports only `harvto-d15-teardown-process-orphans` active with eval `pass`. No close has
  run. Exact-SHA verdict `b5280c18-08cc-439c-8009-9d121ea1dfe8` authorizes one D15 close and one
  separate bookkeeping commit only.
- Frozen SHA-256 values match: spec
  `9233cb254643fa5029c822808bcefb3c2df3e6136311258ccbcb4ab497c43c53`, plan
  `5cbd5dd1870c61a859d09632a774a80aee1195911f7982f3cbc474bf8142326d`, verify
  `27b85e35e64cd066cea93a204f2dd24039bc322b4ea56227cd08e9adf3cb463b`, and red
  `cea7c590c92768f92db9647e25f359eafd4f1701d74572a438d71e905f6990c9`.
- Untracked scope is counted with `git status --porcelain -uall`, never `-unormal`: `-unormal`
  collapses the D15 run/spec directories and reports 9 entries where the authoritative count is 16
  non-root-`.loop` untracked paths. Root `.loop/` file count is proven with
  `find .loop -type f | wc -l` (expected `60`), not read off a status line.
- Tracked dirty scope remains `PLAN.md`, `status.md`,
  `loop-fork/.harness/{parked-ideas.jsonl,tasks.json}`, and
  `loop-fork/agents/coordination.jsonl`. The 16 non-root-`.loop` untracked paths and both ignored
  D15 plans match the bundles. Evidence remains preserved.

### D15 close and bookkeeping plan

1. Reconcile exact HEAD/parent, empty index, dirty scope, 60-file root `.loop/`, utility `0/off/0`,
   sole active/eval-pass D15 state, frozen hashes, nine-path commit range, and exact-SHA PASS ID.
   Any mismatch stops the close.
2. From `loop-fork/`, inventory the `.harness` lifecycle scope with a NUL-safe sorted path list
   (`find .harness -type f -print0 | sort -z`) so subdirectory contents are included, not just
   top-level files. The scope observed at this epoch is `.harness/{README.md,config.json,
   current-task,parked-ideas.jsonl,tasks.json}` plus the `hooks/`, `locks/`, and
   `pre-task-artifacts/` subtrees; `current-task` and `locks/` are the entries the close is expected
   to mutate or remove. Record `./harness status --json`, `git status --porcelain -uall`,
   `git rev-parse HEAD`, byte size, SHA-256, and a bounded tail for every inventoried file into D15
   run evidence. Preserve that snapshot as a machine-comparable file. The plan-review session did
   not create it; it is the first execution action.
3. Run exactly one command:

   ```bash
   ./harness done harvto-d15-teardown-process-orphans
   ```

   Do not retry automatically on any failure. Re-inventory the same lifecycle scope plus any newly
   created lifecycle files; record post-close status, byte sizes, SHA-256, tails, and structured
   deltas against the pre-close snapshot.

   Positive close proof requires all of:
   - `./harness status --json` exits zero and reports no active task (`active_task` absent or
     `null`); a non-zero exit or missing key is a stop, not a pass.
   - The count of `.harness/tasks.json` records with `id == "harvto-d15-teardown-process-orphans"`
     and a terminal status (`done`/`closed`) goes from `0` pre-close to exactly `1` post-close, and
     the total record count grows by at most one. Compare the two recorded numbers.
   - No second D15 terminal record exists anywhere in the lifecycle scope.
   - `git rev-parse HEAD` is still `5f5ddba66cdb1bc5d8f6212b763323f507b0b777` and the index is still
     empty: the close must not commit, and `git status --porcelain -uall` must show no new or
     changed path under `loop-fork/src/` or `loop-fork/tests/`.

   Silence, deletion of `.harness/current-task` alone, or command exit `0` alone is insufficient
   proof.
4. Recompute the authorized path set **after** the close, never before: the close is expected to
   delete untracked `loop-fork/.harness/current-task`, which is one of the 16 pre-close untracked
   paths, so an array frozen before the close will not match the post-close tree. Refresh only D15
   closure bookkeeping and evidence: D15 contracts/tasks, task log, evals, run
   artifacts, defect matrix entries, Harness lifecycle records, coordination record, `PLAN.md`, and
   `status.md`. Preserve all prior D15 evidence. Record the portability bound exactly: uppercase
   `PLAN.md` in `loop-fork/.gitignore:3` matches lowercase `plan.md` on the current
   case-insensitive macOS filesystem; a case-sensitive filesystem fails the force-add precheck
   closed. Record `git config --get core.ignorecase` (including its absence when unset) beside the
   bound, since the `check-ignore` result depends on it.
5. Before force-adding, run `git check-ignore -v -- <path>` separately for:
   `loop-fork/runs/harvto-d15-teardown-process-orphans/plan.md` and
   `loop-fork/specs/harvto-d15-teardown-process-orphans/plan.md`. Both must resolve only to
   `loop-fork/.gitignore:3:PLAN.md`; otherwise stop. Observed at this epoch both already resolve to
   exactly that rule and neither path is tracked (`git ls-files` over both D15 directories is
   empty), so the force-add is an add, not an overwrite. Re-run the check after the close, because
   the check must be against the post-close tree.
6. Build a quoted zsh array `P=(...)` containing every authorized bookkeeping/evidence path and no
   source/test path. Stage each ordinary path explicitly with `git add -- "$path"`; use
   `git add -f -- "$path"` only for the two checked ignored plans. Never broad-stage. Prove:

   ```zsh
   actual=("${(@f)$(git diff --cached --name-only -- "${P[@]}")}")
   (( ${#actual[@]} == ${#P[@]} ))
   diff -u <(printf '%s\n' "${(on)P[@]}") <(printf '%s\n' "${(on)actual[@]}")
   git diff --cached --name-only | awk 'END { print NR }'
   ```

   Run these under `git -c core.quotePath=false` so non-ASCII paths are not octal-quoted into a
   false mismatch. Assert each of the following and record its pass/fail:
   - `P` holds no duplicate entry (`(( ${#P[@]} == ${#${(u)P[@]}} ))`); a duplicate would satisfy the
     count comparison while covering fewer real paths.
   - The final `awk` line count equals `${#P[@]}` and is non-zero, and the unfiltered
     `git diff --cached --name-only` set equals `P` exactly, proving nothing outside `P` is staged.
   - No staged path starts with `.loop/`, and no staged path lies under `loop-fork/src/` or
     `loop-fork/tests/` — those nine paths belong to the implementation commit only.
   - On any failed assertion: do not commit and do not retry. Record the exact staged set and stop.
     Do not unstage on your own initiative; the index is evidence and restoring the empty-index
     invariant is a supervisor decision.
7. Review the cached diff and `git diff --cached --check`, and diff `git diff --cached --numstat`
   against `git diff --cached --numstat --ignore-all-space`; disagreement means an unintended
   reformat and stops the commit. Then create one separate D15 bookkeeping commit whose message
   states bookkeeping/evidence only and cites exact-SHA PASS
   `b5280c18-08cc-439c-8009-9d121ea1dfe8`. Prove afterwards: the commit path set
   (`git show --name-only --format= HEAD`) equals `P`, the new HEAD's parent is
   `5f5ddba66cdb1bc5d8f6212b763323f507b0b777`, no root `.loop/` path is in the commit while
   `find .loop -type f | wc -l` is still `60` and `.loop/` is still untracked, no Harness task is
   active, every prior D15 evidence file is still present, and the index is empty. Do not amend,
   rebase, or reword the implementation commit.

### D6-D12 automatic isolated campaign

Run only after D15 bookkeeping commit, in order:
`harvto-d6-readonly-attach`, `harvto-d7-handoff-identity`,
`harvto-d8-stale-write-lease`, `harvto-d9-duplicate-emission`,
`harvto-d10-guarded-apply`, `harvto-d11-composer-nudge`, and
`harvto-d12-socket-discovery`.

For each task:

1. Reconcile prior close/bookkeeping commit, empty index, preserved root `.loop/` (60 files, still
   untracked), no active Harness task, and utility `0/off/0`. Confirm the target id exists in
   `loop-fork/.harness/parked-ideas.jsonl` and that no task is active, then promote exactly one
   parked Harness task. Create canonical spec/plan/tasks/verify and
   run evidence from preserved defect-matrix authority. Obtain Claude literal zero-write plan
   verdict and record its ID before any source edit.
2. Capture one named exact-base red proof against fixture-owned state only. Preserve it unchanged.
   Trace the narrow owner, implement only the bounded defect fix, and add positive, negative,
   replay, fail-closed, and isolation controls required by that task contract.
3. Run focused tests and targeted static checks, then mandatory `bun run check`, canonical
   TypeScript, build, complete certified serial suite, passing Harness/root evals with
   `baseline_failures: []` and empty by-name allowlist, Harness preflight/stop-gate, and root
   `scripts/verify.sh`. Evals run against that task's `verify.md`, and both
   `loop-fork/runs/<task-id>/eval.json` and `runs/<task-id>/eval.json` must exist and read `pass`
   before any close. UI capture remains required only if rendered UI changes. Never run
   `bun run fix` — it rewrites `runs/` evidence; format touched files with biome directly.
4. Prove exact Git scope and normal/ignore-all-space numstats from repository root. Explicitly stage
   only authorized implementation paths, create one implementation commit, and obtain Claude
   literal zero-write `PASS` for that exact SHA. On `REVISE`, change only the current task, rerun
   proportional focused checks plus every mandatory gate, commit corrections explicitly, and seek
   a fresh verdict.
5. After exact-SHA `PASS`, capture pre-close lifecycle status/sizes/tails, run exactly one Harness
   close, prove exactly one new close record and no active task, then make one separate explicit
   bookkeeping/evidence commit using the same quoted-array scope proof. Reconcile before promoting
   the next task.
6. At every phase or context boundary, append `status.md`, refresh this current-plan section, and
   produce governed handover with exact HEAD, index, dirty paths, hashes, verdict IDs, test results,
   Harness state, root `.loop/` count, utility state, and one next action.

Task invariants remain separate: D6 read-only attachment cannot block targeted recovery delivery;
D7 preserves model, effort, workspace, run, and manifest identity; D8 stale write authority cannot
mutate; D9 one resolved acknowledgement emits once; D10 guarded apply requires an existing,
applicable exact target; D11 recovery uses durable transport and never types over composers; D12
live-run discovery follows manifest-recorded tmux sockets.

### Acceptance and stop conditions

- D15: exactly one positive close record, no active task, one separate bookkeeping commit, exact
  staged path proof, root `.loop/` excluded, all evidence preserved.
- D6-D12: each task has approved plan, preserved exact-base red, bounded implementation, mandatory
  green gates/evals, explicit implementation commit, exact-SHA zero-write `PASS`, exactly one close,
  separate bookkeeping commit, and governed handover.
- Any state mismatch, bundle digest/epoch mismatch, failed close, missing review verdict, gate
  failure, unexpected write, ignore mismatch, staged-set mismatch, HEAD movement during a close, or
  scope mismatch stops the current task. Record blocker without retries, cleanup, or
  scope widening.

## Run-77 governed prepare boundary — exact-SHA PASS received, close pending

### Current objective and state

- Finish D15 only: exact-SHA PASS `b5280c18-08cc-439c-8009-9d121ea1dfe8` is granted for
  implementation commit `5f5ddba66cdb1bc5d8f6212b763323f507b0b777`; close the active Harness task
  exactly once and commit closure bookkeeping separately. Do not begin D6 until that boundary is
  complete.
- Exact HEAD is `5f5ddba66cdb1bc5d8f6212b763323f507b0b777`; exact parent is
  `fb71f47bb126a39eae7f1613fa952c994421de5e`; index is empty. The commit contains only the approved
  six production and three test paths already listed below. Range `git diff --check` passes.
- Exact tracked dirty scope is five bookkeeping paths: `PLAN.md`,
  `loop-fork/.harness/parked-ideas.jsonl`, `loop-fork/.harness/tasks.json`,
  `loop-fork/agents/coordination.jsonl`, and `status.md`.
- Exact non-root-`.loop` untracked scope is 16 paths:
  `loop-fork/.harness/current-task`, D15 run files
  `artifacts/debt/baseline-loc.json`, `artifacts/pre-task/10-current-task.sh.log`,
  `artifacts/pre-task/state-invariants.jsonl`, `artifacts/pre-task/state-invariants.log`,
  `artifacts/red/reproduction.md`, `eval.json`, `memory/001-initial.md`,
  `memory/002-promoted-parked-idea.md`, `meta.json`, `parked-idea.md`, and `task-log.md` under
  `loop-fork/runs/harvto-d15-teardown-process-orphans/`; D15 canonical `spec.md`, `tasks.md`, and
  `verify.md` under `loop-fork/specs/harvto-d15-teardown-process-orphans/`; and root
  `runs/harvto-d15-teardown-process-orphans/eval.json`.
- Both required D15 `plan.md` files remain present and ignored by `loop-fork/.gitignore:3`. Root
  `.loop/` remains untracked with exactly 60 files. Utility is positively `0/off/0`.

### Completed checks and review state

- Focused proof is 223 pass, 0 fail; targeted Ultracite, canonical TypeScript, and diff-check pass.
  Mandatory `check` passes 898 files; build and all 79 certified serial test files pass; both evals
  pass with `baseline_failures: []`; Harness preflight and stop-gate pass; root verifier passes.
- Canonical spec/plan/verify and exact-base red hashes remain the exact values recorded below.
  Harness still reports sole active task `harvto-d15-teardown-process-orphans`, eval `pass`; no
  close or lifecycle transition has run.
- Control-slice decision `4f9e84d4-34f9-4e6c-843b-c564420e9016` is literal `PASS`. Exact-SHA
  decision `b5280c18-08cc-439c-8009-9d121ea1dfe8`, replying to request
  `8aa2a171-7eb6-4ae9-8507-3750ad6129cc`, is also literal `PASS` for exact implementation commit
  `5f5ddba66cdb1bc5d8f6212b763323f507b0b777`. It authorizes exactly one D15 Harness close and one
  separate bookkeeping commit, and nothing else. The verdict arrived after Governess's prepare
  boundary, so run 77 records it without starting the new lifecycle phase.

### Risks and next bounded action

- Preserve the recorded non-blocking bounds: first-executable agent identity intentionally fails
  closed for wrapper launches; polling is synchronous and serial; the documented same-second
  identical-command collision lacks a dedicated control. Also, `loop-fork/.gitignore:3` contains
  uppercase `PLAN.md` but matches the two lowercase D15 `plan.md` files only because the current
  macOS filesystem is case-insensitive; on a case-sensitive filesystem the mandated pre-force-add
  `git check-ignore -v` would fail closed and those plans would be ordinary untracked files. The
  explicit-path staging rule remains protective. Do not rework these bounds during handover.
- Next fresh loop: verify charter/bundles, exact HEAD/index/dirty scope, utility, root `.loop`,
  Harness state, canonical/red hashes, exact commit range, and exact-SHA PASS ID. Capture pre-close
  Harness status plus byte sizes and tails of every lifecycle file, run exactly one Harness close,
  then positively prove one new D15 close record and no active task. Update and explicitly stage
  only D15 closure bookkeeping/evidence, force-add only the two pre-verified ignored plans, prove
  exact staged scope with a quoted zsh array and no root `.loop`, and create the one separate
  bookkeeping commit. Do not rerun a broad suite unless source changes or review requires it.

## Run-77 authoritative continuation plan — epoch `1786849270478176`

### Validated boundary

- Both ready bundles at
  `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/76/handoff/1786849270478176/{claude,codex}.json`
  parse, report epoch `1786849270478176`, and bind to live HEAD
  `fb71f47bb126a39eae7f1613fa952c994421de5e`.
- Index is empty. Root `.loop/` remains untracked with exactly 60 files. No evidence was changed or
  deleted. Harness reports sole active task `harvto-d15-teardown-process-orphans`, eval pending.
- Canonical D15 hashes match Claude's literal `PLAN PASS` decision
  `92de3425-0e1c-42e6-a89d-bda26e7bb578`: spec
  `9233cb254643fa5029c822808bcefb3c2df3e6136311258ccbcb4ab497c43c53`, plan
  `5cbd5dd1870c61a859d09632a774a80aee1195911f7982f3cbc474bf8142326d`, verify
  `27b85e35e64cd066cea93a204f2dd24039bc322b4ea56227cd08e9adf3cb463b`.
- D15 implementation is committed as exact SHA
  `5f5ddba66cdb1bc5d8f6212b763323f507b0b777`, whose exact parent is
  `fb71f47bb126a39eae7f1613fa952c994421de5e`. Its tree delta contains exactly six production files
  and three test files: `loop-fork/src/loop/{governess,hooks/emit,hooks/settings,run-process-cleanup,run-state,tmux}.ts`
  and `loop-fork/tests/loop/{governess-exit,governess-hooks,run-process-cleanup}.test.ts`. Exact-SHA
  zero-write decision `b5280c18-08cc-439c-8009-9d121ea1dfe8` is literal `PASS` for this commit.
- Post-control focused result is 223 pass, 0 fail: cleanup `29/29`, Governess exit `34/34`,
  Governess hooks `35/35`, tmux `103/103`, and run-state `22/22`. Targeted Biome and Ultracite over
  all nine files, canonical TypeScript, and `git diff --check` pass.
- Claude control review `1723a22b-2f3a-4573-ad47-db11eda4a718` returned `REVISE`; all three blockers
  were closed in the working tree with named TERM/KILL survival controls, complete registration
  failure lifecycle controls, retained global `exec`, and agent-command validation. Fresh
  zero-write control decision `4f9e84d4-34f9-4e6c-843b-c564420e9016` returned literal `PASS` for
  design and coverage. This remains separate from exact-SHA approval.
- Mandatory pre-commit verification is green: `bun run check` passes 898 files; canonical TypeScript
  and build pass; the official complete serial suite passes all 79 files; both evals pass with
  `baseline_failures: []`; Harness preflight and stop-gate pass; and the root verifier completes
  lint, typecheck, build, all tests, and baseline gate.
- Normal and ignore-all-space source/test numstats now match on all nine paths:
  `governess.ts` `163/20`, `hooks/emit.ts` `46/1`, `hooks/settings.ts` `8/2`,
  `run-process-cleanup.ts` `799/51`, `run-state.ts` `19/3`, `tmux.ts` `46/3`,
  `tests/loop/governess-exit.test.ts` `371/8`, `tests/loop/governess-hooks.test.ts` `132/9`, and
  `tests/loop/run-process-cleanup.test.ts` `916/0`.
- Preserved exact-base red proof sha256 is
  `cea7c590c92768f92db9647e25f359eafd4f1701d74572a438d71e905f6990c9` for
  `loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/red/reproduction.md`. Re-derive and
  match this digest before the implementation commit, before the exact-SHA review request, and
  before the Harness close.
- `status.md` already exists at repository root (2459 lines, tracked, dirty). It must not be
  created or truncated; each boundary appends to it. `PLAN.md` and `status.md` are bookkeeping
  paths and never enter an implementation commit.
- Both ignored plans are preserved:
  `loop-fork/runs/harvto-d15-teardown-process-orphans/plan.md` and
  `loop-fork/specs/harvto-d15-teardown-process-orphans/plan.md`.

### Non-negotiable authority

- Utility stays hard-disabled: `LOOP_UTILITY_ENABLED=0`, `LOOP_UTILITY_DELEGATION_MODE=off`,
  `LOOP_AU_PAIR_ENABLED=0`. No helper routing, native helper fallback, provider call, or spend.
- Do not edit or control Harvto; merge, rebase, push, deploy, or release; alter provider, model,
  effort, dependencies, remotes, or authority; delete evidence; widen defect scope; or inject
  `/compact` or `/rename`.
- Preserve exact inherited state until its owning phase commits it. Never broad-stage, clean the
  worktree, reuse a task run, or mix D15 with D6-D12.

### D15 execution

1. Reconcile before each write and gate.
   - Recheck exact HEAD, empty index, active Harness task, root `.loop/` count, utility `0/off/0`,
     Git-derived dirty paths, ignored plans, and both handoff bundles.
   - Read the complete inherited diff against canonical `spec.md`, `plan.md`, and `verify.md`.
     Preserve the exact-base red at
     `loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/red/reproduction.md`; never
     recapture it over changed production.
2. Complete only approved F1-F3 controls and fixes they expose.
   - F1: add named `D15 zombie target is settled after TERM while its parent has not reaped it`.
     Prove `kill(pid,0)` and `ps -p` still see the zombie, `ps stat` is `Z`/defunct, settlement
     succeeds, and no KILL reaches a changed identity.
   - F2: add named `D15 cleanup never signals itself or an ancestor`. Prove exact PPID walking,
     zero signals, retained ownership, and durable `unresolved:self-or-ancestor`.
   - F3: add named `D15 native-child SessionStart creates no agent ownership record`, paired with
     main-agent positive registration and every affected Claude/Codex hook compatibility control.
3. Complete M1-M3 and revised-plan R1/R2 controls.
   - M1: prove exact command plus one-second `lstart` matching, including documented identical
     command/same-second bound.
   - M2: prove death on exact launch-recorded tmux socket and session; missing or unknown socket
     fails without default-socket fallback.
   - M3: prove enumeration stays under fixture `runDir`; preserved live runs are never inspected or
     signaled.
   - R1: add named `D15 ordinary teardown transfers only its exact self launcher and reaches
     stopped`. Require durable versioned receipt before active-record removal, no inline unresolved
     ownership, all other processes and exact tmux target settled, and lifecycle `stopped`.
   - R2: add named `D15 abandoned-run GC treats a zombie manifest launcher as settled`. Exercise
     the same zombie-aware predicate through teardown, `runIsProvablyAbandoned`, and deferred
     receipt cleanup.
   - M1 named control: `D15 launcher settlement matches exact command and one-second lstart`.
   - M2 named control: `D15 tmux death is proved on the exact launch-recorded socket and session`.
   - M3 named control: `D15 enumeration stays inside the fixture runDir and never touches live runs`.

4. Run focused proof with utility fixed at `0/off/0`.
   - Named exact-base regression, then each new named control.
   - `bun run test:file -- tests/loop/run-process-cleanup.test.ts`
   - `bun run test:file -- tests/loop/governess-exit.test.ts`
   - `bun run test:file -- tests/loop/governess-hooks.test.ts`
   - `bun run test:file -- tests/loop/tmux.test.ts`
   - `bun run test:file -- tests/loop/run-state.test.ts`
   - Targeted Biome and Ultracite over touched source/test files, canonical TypeScript, and
     `git diff --check`. Fix only D15 failures; scope widening blocks work.
5. Run mandatory gates from `loop-fork/`.
   - `bun run check`
   - `bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts`
   - `bun run build`
   - `LOOP_TEST_CERTIFICATION_MODE=single-file bun run test:ci`
   - `./harness preflight --json`
   - `./harness stop-gate --json`
   - Regenerate passing Harness and repository-root evals with `baseline_failures: []`, then run
     `./scripts/verify.sh harvto-d15-teardown-process-orphans harvto-d15-teardown-process-orphans`
     from repository root. UI capture remains unnecessary.
6. Prove and commit D15 implementation explicitly.
   - Reconcile porcelain-v2 status, cached/unstaged name-status, normal versus ignore-all-space
     numstats, diff-check, and exact staged path list.
   - Stage only approved D15 source/test paths by explicit `git add -- <path>` calls. Never use
     `git add -A`. Exclude root `.loop/`, Harness lifecycle files, plans/specs/run evidence,
     coordination records, root logs, unrelated tasks, Harvto, dependencies, remotes, and release
     paths from this implementation commit.
   - Commit one D15 implementation SHA. Confirm its parent, exact path set, and no whitespace-only
     or out-of-scope changes.
7. Obtain Claude exact-SHA zero-write review.
   - Send exact parent/SHA, exact path set, canonical hashes and PLAN PASS ID, red proof, F1-F3,
     M1-M3, R1/R2 results, full gates, evals, and explicit zero-write/no-helper/no-spend authority.
   - Require literal `PASS` or `REVISE` for that SHA. `PLAN PASS` is not implementation approval.
   - On `REVISE`, change D15 only, rerun proportional focused checks plus every mandatory gate,
     commit explicit correction paths, and request a fresh exact-SHA verdict. No Harness close
     before literal `PASS`.
8. Close once and bookkeep separately.
   - After exact-SHA `PASS`, run exactly one `./harness done harvto-d15-teardown-process-orphans`.
     Inspect all lifecycle writes and confirm no second close.
   - Update D15 contracts, tasks, evals, task log, defect matrix, run evidence, `PLAN.md`, and
     `status.md`. Explicitly stage bookkeeping/evidence paths. Force-add only the two required
     ignored D15 plan files. Preserve root `.loop/`.
   - Commit one separate D15 bookkeeping commit. Confirm no active task and no D15 leakage before
     D6 promotion.

### D6-D12 automatic isolated campaign

Run in this order: `harvto-d6-readonly-attach`, `harvto-d7-handoff-identity`,
`harvto-d8-stale-write-lease`, `harvto-d9-duplicate-emission`,
`harvto-d10-guarded-apply`, `harvto-d11-composer-nudge`, then
`harvto-d12-socket-discovery`.

For each task, only after prior bookkeeping commit and clean index:

1. Reconcile authority and promote exactly one parked Harness task. Create its run folder and
   canonical spec/plan/tasks/verify from preserved matrix evidence. Obtain zero-write plan review
   before source edits.
2. Capture one exact-base red proving the named invariant without Harvto access, broad process
   discovery, helper routing, or mutation outside fixture-owned state.
3. Trace the narrow owner, implement the bounded fix, and add positive, negative, replay,
   fail-closed, and isolation controls required by that task's contract.
4. Run focused suites, targeted static checks, complete mandatory serial suite, passing evals,
   Harness preflight/stop-gate, and root verifier. No filtered or attested result substitutes for
   mandatory proof.
5. Prove exact scope and create one explicit implementation commit. Obtain Claude literal
   zero-write `PASS` for that exact SHA; correct and re-review until PASS.
6. Run exactly one Harness close, inspect writes, then create one separate explicit bookkeeping
   commit. Reconcile preserved evidence and empty index before promoting next task.

Task invariants stay distinct: D6 read-only attachment cannot block targeted recovery delivery; D7
handover preserves model, effort, workspace, run, and manifest identity; D8 stale write authority
cannot mutate; D9 one resolved acknowledgement emits once; D10 guarded apply requires an existing,
applicable exact target; D11 recovery uses durable transport and never types over composers; D12
live-run discovery follows manifest-recorded tmux sockets.

### Verification hardening — plan review at epoch `1786849270478176`

These are mandatory additions to the D15 and D6-D12 steps above, not optional advice.

- Run every Git scope, numstat, name-status, diff-check, and staged-path command from repository
  root `/Users/amgad/dev_projects/agents-collab-harvto-supervisor-defects` with repository-root
  relative pathspecs. A pathspec-scoped `git diff --numstat` can return empty output while the same
  paths are genuinely modified; empty output is therefore a FAIL and must be re-derived, never read
  as "no churn". Assert the numstat line count equals the expected path count before banking it.
- Verify utility hard-disable positively at each phase boundary rather than assuming it:
  `env | grep -E '^LOOP_(UTILITY_ENABLED|UTILITY_DELEGATION_MODE|AU_PAIR_ENABLED)='` must print
  exactly `0`, `off`, `0`. Absence of output is a FAIL, not a pass.
- Prove exactly one Harness close positively. Before `./harness done`, record
  `./harness status --json` and the byte size plus tail of every `.harness` lifecycle file; after
  it, re-read them and confirm exactly one new close record for
  `harvto-d15-teardown-process-orphans` and no active task remains. Silence is not evidence of a
  single close.
- Before force-adding the two ignored D15 plan files, run `git check-ignore -v -- <path>` on each
  to confirm they are the only force-adds, and after staging run `git diff --cached --name-only`
  and confirm the staged set equals the intended set exactly, with no root `.loop/` entry.
- Evals must be allowlisted by test NAME with the allowlist required empty, in addition to
  `baseline_failures: []`. A tolerated-failure count is not acceptance.
- The repository-root verifier is `scripts/verify.sh` (there is no `loop-fork/scripts/verify.sh`);
  the Harness entrypoint is `loop-fork/harness`. Invoke each from its own correct root.
- If a mandatory gate, focused control, or reviewer verdict cannot be obtained, stop that task,
  record the blocker in `status.md` and this section, preserve all dirty state, and produce a
  governed handover. Never substitute an attested or filtered prior result for a rerun.
- For D6-D12, record the reviewer's literal plan-review verdict ID before any source edit, and the
  literal exact-SHA `PASS` ID before the Harness close, in `status.md` and the task run evidence.
  A plan-level PASS never authorizes a close.
- If the context or handover threshold is reached mid-task, finish the current atomic action, do
  not start a new phase, append `status.md`, and hand over with exact HEAD, dirty paths, staged
  state, task/eval state, and next atomic action.

### Handover and acceptance

- At every loop boundary, append `status.md`, refresh this authoritative plan section, preserve all
  dirty/evidence state, and create governed ready bundles for both agents. Handover records exact
  HEAD, empty-index state, dirty paths, task/eval state, proof, open risks, and next atomic action.
- Campaign acceptance: D15 and D6-D12 each have preserved red proof, bounded implementation,
  passing focused and mandatory checks, passing evals, explicit implementation commit, Claude
  exact-SHA zero-write `PASS`, exactly one Harness close, and separate bookkeeping commit.
- No human decision is currently required. Any bundle/HEAD mismatch, unexpected staged path,
  authority change, required scope widening, utility activation/spend, or missing exact reviewer
  verdict blocks that task and must be recorded before further writes.

## Authoritative continuation plan — post-run-62 handover

### Run-66 fresh-loop handover — D16 focused contract slice

Governess requested a fresh-loop handover at the context preparation threshold. Stop after this
atomic slice; do not start another control group, broad suite, commit, review gate, or Harness
lifecycle action in this session.

- Objective remains `harvto-d16-scope-audit-completeness` at exact base/HEAD
  `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`. Index is empty, root `.loop/` still has 60 untracked
  evidence files, and Harness status still selects D16 as the current task with eval pending.
- Current producer-to-consumer contract is implemented but uncommitted across
  `loop-fork/src/loop/{utility-scope-audit,task-router,utility-tools,utility-runtime,utility-store,bridge-utility}.ts`.
  Broker Git evidence now has canonical records/count/hash, is retained outside helper-visible tool
  payloads, survives the conversation into `UtilityCompactResult`, validates during store replay,
  and validates again before `get_task_result` returns a completed current scope audit. Historical
  completed scope audits without evidence replay internally but `get_task_result` rejects them as
  `legacy/unverified`.
- Current focused test scope is
  `loop-fork/tests/loop/{utility-pi-harness,utility-scope-audit,utility-tools,utility-store,bridge-utility}.test.ts`.
  It covers the named synthesized omission, protected metadata, staged/unstaged/add/delete/rename,
  committed rename/copy/delete/modify, whitespace paths, zero-record clean evidence,
  duplicate/malformed/truncated/count/hash/clean-bit rejection, durable replay/tamper, and legacy
  consumer rejection.
- Focused proof now passing: named Pi regression `1 pass, 11 filtered, 0 fail, 5 expect() calls`;
  scope parser/hash `4 pass, 0 fail, 16 expect() calls`; broker `47 pass, 0 fail, 169 expect()
  calls`; store `18 pass, 0 fail, 46 expect() calls`; bridge consumer `2 pass, 0 fail, 2 expect()
  calls`; targeted Biome over 11 files clean; canonical TypeScript exits 0; `git diff --check` exits
  0. No mandatory broad suite has run.
- The first post-fix named run exposed protected metadata in the provider payload and failed
  `0 pass, 1 fail, 4 expect() calls`; runtime serialization was narrowed so `scopeAudit` remains
  authoritative consumer evidence but is omitted from helper-visible JSON. The named test then
  passed with its original five assertions.
- Claude mid-implementation design review request
  `10069fa8-5335-474d-8eb6-8fa35ba60a7b` was accepted, but no design verdict arrived before the
  Governess handover decision. Exact-SHA review has not been requested and remains premature.
- Claude reviewer note (run 66): the design review was never inspected, so there is no partial
  verdict to inherit. The four bridge messages, including review request
  `10069fa8-5335-474d-8eb6-8fa35ba60a7b` and the urgent Governess handover
  `35aeaaf4-52d4-4cb0-bbe1-4c476d08aeeb`, were delivered together after the handover order.
  The later handover instruction controlled, so Claude opened no D16 source or test file and
  performed zero writes to production scope. Successor Claude must run that design review from
  scratch; treat the current contract as unreviewed, not as tacitly approved.
- Five early `route_task` calls were rejected by the broker as under-bounded before any task ID or
  dispatch. They caused no helper execution, utility result, provider spend, or repository write.
  D16's explicit no-helper/no-spend authority controls; do not retry helper routing.

Next bounded action in the fresh loop: pull any pending Claude design response, re-read this section
and the current diff, then add only remaining runtime request-requirement/conflicting-manifest and
task-router classification controls. Run the affected focused files, including existing
`utility-runtime.test.ts`, `task-router.test.ts`, and `bridge.test.ts`, before deciding whether the
D16 matrix is complete. Preserve all existing uncommitted D16 evidence and root `.loop/`.

### Reconciled boundary

- Exact HEAD/base is `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`; index is empty and branch is
  ahead of `origin/main` by 23 commits.
- Both epoch `1786652500290340` bundles were read and verified. Claude's bundle is the zero-write
  D5 review snapshot at `13a6e8fd37084359fafb4813b462375662b21966`; Codex's later bundle is the
  authoritative continuation snapshot after D5 closure bookkeeping at current HEAD.
- D1, D2, D3, D4, D5, D13, and D14 are closed. Sole active Harness task is
  `harvto-d16-scope-audit-completeness`, mode `emergent`, eval pending.
- Preserve every existing D16 modification and artifact, including ignored
  `loop-fork/{runs,specs}/harvto-d16-scope-audit-completeness/plan.md`, and untracked root `.loop/`
  with its current 60 files. Never broad-stage or clean this worktree.
- Exact-base red is durable: 0 pass, 11 filtered, 1 fail, 5 assertions, captured while the
  production diff was empty. It is preserved evidence at
  `loop-fork/runs/harvto-d16-scope-audit-completeness/artifacts/red/reproduction.md`; do not
  re-capture it over the partial implementation, and do not present any current-tree failure as the
  exact-base red.
- Partial implementation is unstaged and incomplete. Canonical TypeScript and `git diff --check`
  passed at handover. The targeted Biome count of 15 errors is a run-62 handover measurement, not a
  fact to bank: re-derive it before the first cleanup edit and again after. The count is a progress
  indicator only; the acceptance bar is zero diagnostics on touched files.
- `status.md` exists at repository root and already carries the run-62 D16 boundary section. No
  creation step is required; it is appended to, never rewritten, at every D16 phase boundary
  (post-reconcile, post-fix, post-verify, post-commit, post-review, post-close).
- Two sections below remain BINDING for this work despite appearing under older headings:
  `## Verification gaps to close for the two new defects` (its D16 clauses) and
  `## Scope and commit proof`. Everything else below `## Archived campaign record — D3/D5`,
  including `## Campaign order` and `## D5 live plan`, is archival history and directs nothing.
- Paid utility remains disabled. No helper routing, Harvto access/edit, provider/model/dependency
  change, merge, rebase, push, deploy, spend, evidence deletion, authority weakening, or scope
  widening is authorized.

All older D3/D5 execution sections below are retained as campaign history. This section and the
canonical D16 bundle are authoritative for continuation.

### D16 bounded implementation

1. Reconcile before each write.
   - Recheck exact HEAD, empty index, sole active task, Git-derived dirty set, ignored plan files,
     root `.loop/` preservation, and disabled utility environment.
   - Treat native Git output as scope authority until the D16 commit receives exact-SHA review.
     Routed/model scope summaries remain untrusted evidence only.
   - Re-read both epoch `1786652500290340` bundles (`claude.json`, `codex.json`) and confirm the
     Codex bundle's `gitHead` equals live HEAD before any write. A bundle/HEAD mismatch blocks work
     and is recorded, not reconciled by assumption.
   - Append a dated D16 section to `status.md` at each phase boundary with exact base/head SHA,
     task ID, changed scope, proof, open questions, and risks. Keep all prior sections intact.
2. Finish the existing producer-to-consumer contract; do not redesign routing policy.
   - Keep helper-visible protected-content exclusions unchanged while the broker independently
     produces metadata-only records for hidden changed paths.
   - Complete canonical parsing and serialization for porcelain-v2 status and NUL-delimited
     name-status diff evidence: repository-relative paths, state, surface, rename/copy source and
     destination, deterministic sort, duplicate rejection, exact count, clean bit, and SHA-256.
   - Require scope evidence only for `utility-audit` requests using `git-status` or `git-diff`.
     A failed authoritative Git inventory must fail closed; synthesized prose never repairs or
     replaces missing evidence.
   - Retain the authoritative manifest from successful broker result through
     `UtilityConversationResult` and `UtilityCompactResult`. Persist the same manifest without a
     second synthesis.
   - Validate schema, canonical records, count, clean bit, and SHA-256 during utility-store replay
     and again before `get_task_result` returns a completed audit. Missing, malformed, duplicate,
     truncated, conflicting, or tampered evidence cannot materialize as authoritative completed or
     clean. Existing non-scope results remain compatible; historical scope results remain
     legacy/unverified, never authoritative-clean.
3. Resolve only current bounded diagnostics.
   - Organize touched imports; hoist regexes; split status/diff parsing and Git inventory helpers to
     meet complexity limits; replace nested ternaries/negative conditional forms; apply formatter
     output; use imported `spawnSync` instead of undeclared `Bun` in the fixture.
   - Run targeted Biome and canonical TypeScript after these edits. Do not apply repository-wide
     automatic fixes.
4. Restore the named red first.
   - Rerun only `D16 utility scope audit preserves routing-hidden Git paths when synthesis reports
     only visible paths` until it passes with exactly two canonical records and a valid count/hash.
   - If making it pass requires files or behavior outside the traced broker/runtime/store/bridge
     boundary, stop and record the mismatch before widening scope.
   - If that regression is already green on the current partial tree, treat it as an instrument
     failure rather than progress: confirm the assertion still targets the durable `scopeAudit`
     two-record/count/hash contract and re-derive the failure mechanism from
     `artifacts/red/reproduction.md` before proceeding. A pass without runtime retention, store
     replay validation, and consumer validation is not evidence of a fix.
5. Add deterministic controls in small groups.
   - Git classes: added/untracked, deleted, rename and copy identity, staged, unstaged,
     committed base/head range, whitespace-safe paths, and tracked routing-hidden metadata.
   - Fail-closed cases: synthesized omission, absent evidence, malformed records, duplicate
     records, truncation, count mismatch, hash mismatch, conflicting clean bit, and failed Git
     inventory.
   - Compatibility: durable replay returns identical evidence; consumer revalidates before return;
     non-scope legacy results still materialize; old scope results cannot become clean; genuinely
     clean scope yields a validated zero-record manifest and clean result.
6. Verify in increasing scope.
   - Run touched focused files first: utility Pi harness, tools, runtime, store, execution tier,
     router, and bridge as selected by actual changed seams.
   - Then run `bun run check`, canonical TypeScript, `bun run build`, and complete serial
     `bun run test:ci`. Filtered tests never substitute for the serial suite.
   - Update Harness and root evals with pass verdicts and empty `baseline_failures`; run Harness
     preflight and stop-gate; run
     `scripts/verify.sh harvto-d16-scope-audit-completeness harvto-d16-scope-audit-completeness`
     from repository root. UI capture remains unnecessary unless rendered UI changes.
7. Prove scope and commit explicitly.
   - Derive pre-commit paths from porcelain-v2 status plus unstaged/cached name-status, include the
     two ignored required D16 plan files explicitly, and exclude root `.loop/`, Harvto, D15,
     D6-D12, providers/models, dependencies, remotes, deployment, and release paths.
   - Pass `git diff --check`, normal versus ignore-all-space numstat comparison, and exact staged
     path comparison. Stage each approved D16 path explicitly with `git add -- <path>`; the two
     ignored required files `loop-fork/runs/harvto-d16-scope-audit-completeness/plan.md` and
     `loop-fork/specs/harvto-d16-scope-audit-completeness/plan.md` require
     `git add -f -- <path>` and must be named in the commit scope proof as deliberate force-adds.
     Never `git add -A`. Create one D16 implementation and evidence commit.
8. Obtain Claude exact-SHA zero-write review.
   - Send exact base/head, explicit path set, invariant, red proof, named controls, mandatory-suite
     results, and zero-write/no-helper/no-spend authority. Require `PASS` or `REVISE` for that SHA.
   - On `REVISE`, correct D16 only, rerun proportional focused checks plus every mandatory gate,
     commit explicit correction paths, and request a new exact-SHA review. Repeat until `PASS`.
9. Close and bookkeep.
   - After `PASS`, record verdict and review ID, run Harness done exactly once, inspect every
     lifecycle write, update D16 contracts/evals/matrix/task log plus root plan/status, and commit
     explicit bookkeeping paths.
   - Confirm no active task, preserved root `.loop/`, and no out-of-scope path in the full D16
     range before starting another defect.

### Remaining campaign order

After D16 bookkeeping commit, continue as isolated Harness tasks with the same exact-base red,
bounded fix, focused/full verification, explicit commit, Claude exact-SHA zero-write review,
correction loop, one Harness close, and separate bookkeeping commit:

1. D15 teardown process orphans.
2. D6 read-only attach.
3. D7 handoff identity.
4. D8 stale utility write lease.
5. D9 duplicate acknowledgement emission.
6. D10 guarded apply target evidence.
7. D11 recovery transport/composer preservation.
8. D12 manifest socket discovery.

Never mix task source, tests, evidence, lifecycle writes, or commits. Promote next task only after
previous task's reviewed closure bookkeeping is committed and tracked state is reconciled.

### D16 acceptance gate

- Exact-base observed omission remains preserved and named regression passes after bounded fix.
- Every required Git path class is represented without exposing protected content.
- Producer, durable replay, and final consumer independently enforce canonical count/hash evidence.
- All tamper/missing/conflict cases fail closed; clean zero-set and legacy non-scope controls pass.
- Focused tests, targeted Biome, canonical TypeScript, check, build, complete serial suite, both
  eval schemas, Harness gates, and root verifier pass.
- Explicit D16-only commit receives Claude zero-write exact-SHA `PASS`; Harness closes once and
  bookkeeping is committed separately. Root `.loop/` and all prior evidence remain preserved.

### Open questions

- No human decision is currently required. During implementation, settle exact multi-tool manifest
  handling and durable failed/unknown representation from existing runtime/store contracts. Any
  answer that widens beyond the traced D16 boundary blocks work and requires a recorded scope
  decision before edits continue.

## Archived campaign record — D3/D5

D1, D2, D3, D4, D13, and D14 are closed. D3 implementation is committed at exact SHA
`9d1ce5dbfe1831fafdabcad7260e6c22dd5d5ecd` over exact base
`d5d3140844f9ff7f8447156f4b4f7f27ac093d96`. `./harness done harvto-d3-pending-route` completed
exactly once at `2026-08-13T18:49:48Z`; no Harness task is active. This accompanying bookkeeping
commit is `6cdb9ad60e7c2b18926a70e25debf877302bc014` and records closure evidence.

D5 `harvto-d5-silent-completion` is now promoted in planned mode at that exact base. Harness status
reports it active with pending unit eval. Its run-owned plan and canonical
`loop-fork/specs/harvto-d5-silent-completion/{spec,plan,tasks,verify}.md` are initialized before
source or test edits. D16 and D15 remain parked independently and matrixed.

D3 reproduced red before production edits, then received the narrow correction at the proven
Governess/utility-runtime ownership boundary. Missing workspace, driver, or peer routing evidence
now records one durable `routing-owner-unavailable` escalation; stale and duplicate replay append
nothing. Normal routing still preserves full-but-eligible capacity backlog and later recovery.

Focused D3, D1, and D4 controls pass. Check, canonical TypeScript, build, canonical 77-file serial
suite, Harness preflight/stop-gate, and the repo-root verifier all pass with empty
`baseline_failures`. Git-derived scope proof passed and the exact 32-path D3 implementation and
evidence range is committed at `9d1ce5dbfe1831fafdabcad7260e6c22dd5d5ecd`, whose parent is exact
base `d5d3140844f9ff7f8447156f4b4f7f27ac093d96`. Codex's zero-write audit passes. Claude returned
zero-write static `PASS` for that exact SHA via bridge
`0e404eeb-1bca-45eb-a829-9299c46fb342`; Claude did not rerun any test or gate, so the recorded pass
counts remain Codex-attested. No D3 correction is required. Preserve all task evidence and
untracked `.loop/`.

Current D5 source trace shows paired completion persists manifest/transcript terminal state but has
no automatic supervisor close enqueue. Reproduction must prove that exact gap on unchanged
production before choosing the narrow completion owner. Do not re-promote, re-park, reproduce,
rewrite, or recommit D3.

Claude disclosed an unauthorized Au Pair audit during review despite the explicit no-paid-utility
instruction. Run-local usage records task `9301b78a-7e6f-42a8-bcbe-7576f0ac6d53` on OpenRouter
`z-ai/glm-5.2` at cost `$0.006511969`. Its five-path result was scope-incomplete and is discarded;
Claude's native 32-path review supports the verdict. Paid utility remains disabled for all further
work.

Claude disclosed a second unauthorized Au Pair audit during D5 plan review. Run-60 usage records
task `3466ccae-7ca4-4eb9-be18-b645a77aa019` on OpenRouter `z-ai/glm-5.2` at cost
`$0.003881967` and 4212 total tokens. Its eight-path result omitted the untracked canonical D5 spec
directory from Git's exact nine-path set and is discarded. A zero-cost Nanny packet
`6747f5a7-f35a-446d-9690-3b7f64feed42` also falsely reported that same directory empty although
native `ls` showed `spec.md`, `plan.md`, `tasks.md`, and `verify.md`. These two false enumerations
are preserved as D16 evidence only; neither supports D5. No further utility routing is authorized.

Human authorized immediate governed handover. Run 57 manifest topology was revalidated, then the
built-in Governess graceful-handover control started epoch `1786644098329708` at
`2026-08-13T18:21:18.663Z`. Successor launch remains gated on validated Claude and Codex bundles,
both agent exits, and manifest acceptance. Resume instructions remain scope proof, commit, review,
closure, then D5.

## Authority and boundaries

- Work only in this existing campaign worktree and branch. One active Harness task, defect,
  implementation commit range, Claude review, closure, and bookkeeping boundary at a time.
- Codex owns implementation, tests, explicit-path commits, corrections, and lifecycle bookkeeping.
  Claude reviews exact committed SHAs with zero-write authority only.
- Do not edit Harvto, mutate preserved Harvto runs, merge, rebase, push, deploy, release, spend, use
  paid utility providers, change models/providers, change dependencies, delete evidence, or stage,
  edit, or remove `.loop/`.
- Do not trust routed scope-audit path lists as complete until the new scope-audit defect is fixed.
  Git-derived path sets are authoritative and any disagreement fails closed.
- Maintain root `PLAN.md` and `status.md` at every task phase boundary. Keep canonical task planning
  in `loop-fork/runs/<task-id>/plan.md` after promotion.

HISTORICAL AS WRITTEN (D5 era; superseded by the authoritative section above, which binds the same
rule to D16): `status.md` was then the D5 handoff. Append a dated section at every phase boundary
(post-promotion, post-plan-review, post-repro, post-fix, post-verify, post-review, post-close) with
the exact base/head SHA, canonical task ID, changed scope, proof, open questions, and risks. Keep
all older D1-D4 and handover sections as archival evidence; do not rewrite or delete them.

Authoritative inputs: `specs/constitution.md`, `docs/architecture/system-overview.md`,
`docs/testing/commands.md`, `loop-fork/specs/harvto-supervisor-defects/{spec,verify}.md`, each
parked defect spec, and
`loop-fork/runs/harvto-supervisor-defects/artifacts/{defect-matrix.md,harvto-supervisor-drain.md}`.

## Campaign order

ARCHIVAL AS WRITTEN — D5 is closed and D16 is active. Current ordering is
`### Remaining campaign order` in the authoritative section above.

1. `harvto-d5-silent-completion` — P1, active at exact base `6cdb9ad6...`.
2. `harvto-d16-scope-audit-completeness` — campaign-integrity P0, ranked before teardown among
   newly verified work because every future scope verdict depends on complete path enumeration.
3. `harvto-d15-teardown-process-orphans` — lifecycle P0, proving completed Governess teardown
   reaps the exact run launcher and Claude child as well as tmux and manifest runtime.
4. `harvto-d6-readonly-attach` through `harvto-d12-socket-discovery` — P2, numeric order.

Explicit user order keeps D3, D5, D16, D15, then D6-D12. New defects must be durably parked during
D3 and remain independent task boundaries. If a current task
reveals a safety blocker in another defect, finish or safely park the current task before promotion;
never mix fixes.

## D5 live plan

### Contract

Paired-run success must emit one durable supervisor-visible close attributable to exact repository,
run ID, source-task SHA-256, and Git HEAD. Restart, supervisor delivery, and replay must preserve
one effective close. Missing attribution or durable enqueue cannot look like healthy completion.
Failed, stopped, input-required, max-iteration, and review-failed paths emit no success.

### Execution

1. Preserve exact base `6cdb9ad60e7c2b18926a70e25debf877302bc014`, active canonical task, and
   untracked `.loop/`.
2. Add one named regression in the existing paired-loop boundary while production remains
   unchanged. Prove manifest `done` plus no matching supervisor completion; record manifest,
   transcript, bridge rows, exact command, and decisive red output.
3. If unchanged production instead reaches manifest `done` with one matching durable supervisor
   close, record `not-reproduced` with the exact contrary manifest/transcript/bridge proof and skip
   every production edit. Continue only the evidence and lifecycle path.
4. Assert exact field identity, not row presence, using the canonical completion record and
   repository-root precedence in `loop-fork/specs/harvto-d5-silent-completion/spec.md`.
   Missing/malformed fields or Git resolution fail closed.
5. Use reproduction to settle terminalization order, restart repair, enqueue failure, delivery,
   and replay dedupe. Prefer current run/bridge schemas; extend only the narrow owner proven
   necessary.
6. Apply the smallest fail-closed correction. Add restart/replay, delivered-dedupe, exact
   attribution, and failed/stopped controls without tmux, providers, sleeps, or Harvto access.
7. Run focused paired-loop, bridge, D1, D3, and D4 controls. Then run `bun run check`, canonical
   `bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve
   --target esnext src/cli.ts src/loop/caveman-skill.d.ts`, `bun run build`, and the complete serial
   `bun run test:ci` under its built-in `LOOP_TEST_CERTIFICATION_MODE=single-file`; filtered tests
   never substitute. Read the canonical task ID from `./harness status --json`, never from the
   parked slug. Pass `./harness preflight --json <canonical-task-id>` and
   `./harness stop-gate --json <canonical-task-id>`.
8. Maintain both eval schemas explicitly: Harness eval
   `loop-fork/runs/<canonical-task-id>/eval.json` with every `dimensions[*].status` passing, and
   repository-root `runs/<canonical-task-id>/eval.json` because `scripts/verify.sh:13` resolves
   `ARTIFACTS_DIR="runs/${TASK_ID}"` from repository root. The root eval must have top-level
   `verdict` or `result` exactly `"pass"`, `baseline_failures` present and empty, and no other
   truthy baseline-failure key. `scripts/check-baseline-allowlist.py` allowlists by test name, never
   by tolerated count. Run `scripts/verify.sh <feature> <canonical-task-id>` and derive
   authoritative scope from Git.
9. Commit explicit D5 paths, obtain Claude zero-write exact-SHA `PASS`, correct D5 only if needed,
   close Harness once, commit lifecycle bookkeeping, then promote D16.

Candidate seams are `loop-fork/src/loop/paired-loop.ts`, existing bridge-store durable enqueue and
historical event reading, and run-state attribution only if crash-safe completion identity requires
an atomic terminal record. Reproduction selects final source/test scope.

### Fresh-loop preparation boundary

Governess bridge decision `ae28964d-a932-4d08-83b4-d3af73ee0145` ordered preparation after D5
promotion and contract initialization. Stop before the red-test edit. Preserve the active Harness
task and every uncommitted planning/intake artifact.

Exact current changed scope is root `PLAN.md` and `status.md`; D5 Harness intake in
`loop-fork/.harness/{current-task,parked-ideas.jsonl,tasks.json}` and
`loop-fork/agents/coordination.jsonl`; generated
`loop-fork/runs/harvto-d5-silent-completion/`; and canonical
`loop-fork/specs/harvto-d5-silent-completion/`. Diff under `loop-fork/src` and `loop-fork/tests` is
empty. `git diff --check` passes. `.loop/` remains untracked and untouched.

Claude returned `REVISE` for plan review request `071748dd-5b49-47f8-9129-9465d90196d0` via
bridge `3d1bb504-2707-4093-9327-1b57dcb8f138`. All five items are accepted: current status
maintenance, explicit not-reproduced exit, self-contained gates/eval schemas, run-59 historical
labeling, and exact attribution field mapping. No red-test edit starts before fresh plan `PASS`.

Claude returned fresh zero-write plan `PASS` via bridge
`7e1d33de-d003-4220-bd46-ebeec47f955a` after native local verification. Exact base remained
`6cdb9ad60e7c2b18926a70e25debf877302bc014`; `git diff --check` passed; source/test diff remained
empty; and `.loop/` remained untracked. D5 is authorized for the exact-base named red only.

Run-59 epoch `1786647683686113` and its manifest/pane topology are pre-handover evidence only.
Run 60 accepted the handover at exact base `6cdb9ad60e7c2b18926a70e25debf877302bc014`, verified
the D5 no-source/no-test boundary, and obtained the plan verdict. Current work remains in run 60;
the old bundle no longer directs lifecycle actions.

### Run-60 preparation boundary

Governess decision `d043df03-18d9-41d0-8833-fc44c98d8e01` ordered fresh-loop preparation after
Codex reached the context preparation threshold. Finish the plan-review atomic step only; do not
start the red-test slice in run 60.

Exact current state: HEAD/base `6cdb9ad60e7c2b18926a70e25debf877302bc014`; Harness task
`harvto-d5-silent-completion` active in planned mode with pending eval; `git diff --check` passes;
`git diff --name-only -- loop-fork/src loop-fork/tests` is empty. Changed scope remains root
`PLAN.md`/`status.md`, D5 Harness intake and coordination, generated D5 run evidence, and canonical
D5 planning. `.loop/` remains untracked and preserved.

Plan gate is complete: Claude fresh zero-write `PASS` is bridge
`7e1d33de-d003-4220-bd46-ebeec47f955a`. Completion payload is now explicit in canonical
`spec.md`: prefer `manifest.workspaceBinding.root`, fall back to `manifest.cwd`, capture Git HEAD
before terminalization, and bind the same repository/run/source-task/Git identity to the structured
supervisor close, `taskId`, `threadId`, and `dedupeKey`.

Next loop must begin with local reads of the constitution, architecture, testing commands, current
paired-loop/bridge/run-state seams, and existing paired-loop tests. Then add the smallest named
regression on unchanged production, run it once to decisive red, and preserve exact
manifest/transcript/bridge evidence before any source edit. No utility routing or provider spend.

Human ordered immediate governed handover after plan `PASS`. Successor launch must be
manifest-backed with `LOOP_UTILITY_ENABLED=0` and `LOOP_UTILITY_DELEGATION_MODE=off`. Preserve the
full expected Claude/Codex/Governess/local-support/Recon topology, but paid Au Pair must remain
disabled. Successor accepts the existing D5 task and plan gate; it must not re-review, re-promote,
or repeat D3. Its first work slice is the exact-base named red at `6cdb9ad...`, using the canonical
spec's already-defined supervisor-close payload and repository-root precedence, with
manifest/transcript/bridge red evidence captured before production changes.

### Run-61 D5 resumption

Run 61 accepted the validated run-60 handover at exact base
`6cdb9ad60e7c2b18926a70e25debf877302bc014`. Existing plan `PASS`
`7e1d33de-d003-4220-bd46-ebeec47f955a` remains authoritative; do not re-review, re-promote, or
repeat D3. Utility routing is hard-disabled with `LOOP_UTILITY_ENABLED=0`,
`LOOP_UTILITY_DELEGATION_MODE=off`, and `LOOP_AU_PAIR_ENABLED=0`.

Immediate slice: inspect current paired-loop, bridge, run-state, and test seams; add one smallest
named regression only; run it on unchanged production; and preserve exact manifest, transcript,
bridge, command, and decisive zero-close evidence before any source correction. Canonical D5
`spec.md` already defines the structured close payload and definite repository-root precedence.

Reproduction completed on unchanged production. Named integration regression reached manifest
`done`, transcript completion, and zero matching supervisor close rows; it failed with
`Expected length: 1`, `Received length: 0`. Raw manifest/transcript/bridge files and hashes are
preserved in the D5 run. Narrow correction may now begin at paired completion finalization.

### Run-61 implementation handover boundary

Governess decision `01bea514-bee6-4ef4-8ed9-0dce20f3c3bf` ordered fresh-loop preparation after
the focused implementation atomic step. No broader verification slice starts in run 61.

Current implementation enqueues or reconciles one exact historical supervisor completion before
writing terminal manifest `done`. It prefers `workspaceBinding.root`, falls back to `cwd`, resolves
Git HEAD before first enqueue, rejects missing source identity/Git/enqueue evidence, ignores
unrelated supervisor traffic, and reuses the same close after delivery/replay. Failed and stopped
runs still emit no completion.

Exact current Git status has 12 entries: the preserved nine-path planning state (including
untracked `.loop/`) plus tracked
`loop-fork/src/loop/paired-loop.ts`,
`loop-fork/tests/loop/00-paired-loop.integration.test.ts`, and
`loop-fork/tests/loop/paired-loop.test.ts`. HEAD remains exact base
`6cdb9ad60e7c2b18926a70e25debf877302bc014`; no commit exists yet.

Current proof: exact-base red is preserved; focused integration passes 6/6 after the final narrow
history predicate; paired-loop passes 21/21 before that final predicate-only correction; current
`bun run check` passes 885 files; and current `git diff --check` passes. Full controls, typecheck,
build, serial certification, Harness gates, eval completion, scope proof, commit, exact-SHA Claude
review, and closure remain pending.

Next bounded action: rerun `tests/loop/paired-loop.test.ts` on current source, then continue focused
bridge/D1/D3/D4 controls. Do not edit implementation unless a check fails. Utility routing remains
hard-disabled.

Graceful handover epoch `1786651310142809` is active. Preserve this uncommitted boundary and resume
from the next bounded action above; do not commit or start another slice in run 61.

### Run-62 D5 verified pre-commit boundary

Run 62 accepted the validated run-61 handover at exact base
`6cdb9ad60e7c2b18926a70e25debf877302bc014`. No helper was routed and paid utility remained
hard-disabled.

Current-source verification is complete: paired-loop unit 21/21; bridge 109/109; D1 liveness
16/16; D3 Governess 79/79; D3/D4 utility runtime 56/56; utility store 15/15; canonical typecheck
and build pass; complete serial `test:ci` passes all 77 files. Both D5 eval schemas pass with empty
`baseline_failures`; Harness preflight and stop-gate pass; and the repository-root verifier passes
check across 885 files, canonical typecheck, build, all 77 serial files, and baseline gate.

Git-derived pre-commit scope is authoritative. Include the two ignored-but-required D5 plan files
explicitly with force; exclude and preserve root `.loop/`. Next: finish exact path proof, stage only
D5 paths, commit once, and request Claude zero-write review of exact base/head. Do not close Harness
before Claude `PASS`.

Governess ordered fresh-loop preparation before staging. Exact 36-file candidate scope is recorded
in `loop-fork/runs/harvto-d5-silent-completion/artifacts/precommit-scope.md`; no file is staged.
Current short status remains the preserved 12-entry run-61 state plus the required root eval path,
with root `.loop/` still untracked. Successor first revalidates exact base/status and scope artifact,
then stages the 36 exact files, force-adding only the two ignored plan files.

Human intervention superseded the unconsumed handover and authorized continuation in run 62.
Exact 36-file scope revalidated, staged, and committed as
`13a6e8fd37084359fafb4813b462375662b21966` over exact parent
`6cdb9ad60e7c2b18926a70e25debf877302bc014`. Post-commit tracked tree was clean; root `.loop/`
remained untracked. Claude zero-write exact-SHA review request is
`c64acab6-c63c-43de-ba8a-62ed6b7410b1`. Next: receive `PASS` or `REVISE`; change D5 only on a
blocking finding. Do not close Harness before `PASS` and do not rerun broad gates without a source
or test change.

Claude returned zero-write exact-SHA `PASS` for
`13a6e8fd37084359fafb4813b462375662b21966` via bridge
`ccb2d981-4fd8-4908-ab3f-1536eba9a508`. Independent focused reruns passed 21/21 paired-loop and
6/6 integration. No D5 correction is required. Next: close Harness exactly once, inspect every
lifecycle write, commit explicit D5 bookkeeping, then promote D16 separately.

Harness closed D5 exactly once at `2026-08-13T21:03:12Z`; post-task invariants passed and no active
task remains. Lifecycle writes, the generated completion summary, debt indicator, regression-harvest
skip, and campaign matrix closure were inspected and normalized. Next: commit only explicit D5
bookkeeping paths while preserving untracked root `.loop/`, then promote D16 separately.

D5 bookkeeping committed as `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`. D16 is now the sole
active Harness task, promoted from `harvto-d16-scope-audit-completeness` with utility, delegation,
and Au Pair hard-disabled. Canonical D16 contracts require the actual run-60 omission boundary,
complete Git path classes, deterministic count/hash evidence, consumer-side fail-closed validation,
and a genuinely clean zero-set control. Production/tests remain frozen until named exact-base red.

## Run-62 D16 handover epoch 1786652500290340

Context-pressure intervention stops D16 expansion mid-implementation. Preserve every uncommitted
D16 path and the untracked root `.loop/`; do not stage or commit this partial boundary.

Completed before handover:

- D5 implementation `13a6e8fd37084359fafb4813b462375662b21966` received Claude zero-write
  `PASS`; Harness bookkeeping committed as exact current HEAD/base
  `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`.
- D16 promoted as sole active Harness task. Canonical spec/plan/tasks/verify, run plan/log/evidence,
  and root status are present. Utility remained hard-disabled; no helper route or spend occurred.
- Historical run-60 omission and false-empty evidence is preserved with ledger hashes. Source trace
  locates exact omission at protected `git_status` exclusions and absent compact-result validation.
- Named exact-base regression reproduces decisive red: native Git sees ordinary modified source plus
  protected untracked spec, helper-visible broker input omits the spec, and durable result still
  records completed with no `scopeAudit` field.
- Partial implementation adds `src/loop/utility-scope-audit.ts`, optional compact-result evidence
  type/witness in `task-router.ts`, and a second consumer-only Git inventory in `utility-tools.ts`.
  It is intentionally incomplete: runtime retention, store replay validation, bridge consumer
  validation, remaining controls, and cleanup are not started.

Atomic check boundary:

- Canonical TypeScript command passes.
- `git diff --check` passes.
- Focused red remains 0 pass / 1 fail as intended before full wiring.
- Targeted Biome check fails with 15 diagnostics: import ordering; two top-level-regex findings; two
  parser complexity findings; two conditional-style findings; formatter output; `gitDiff`
  complexity/nested ternaries; and undeclared `Bun` in the new test. Do not treat current source as
  verified or commit-ready.

Successor starts by reading the D16 canonical contracts and red/source-trace evidence, then finishes
the existing producer-to-consumer implementation only: retain one authoritative scope manifest from
successful broker results through utility conversation and compact result, validate it in store
replay and `get_task_result`, fix current Biome diagnostics, and make the named red green. Do not
rerun broad gates before focused D16 controls pass. Preserve ignored required run/spec `plan.md`
files explicitly, root `.loop/`, active Harness state, and disabled utility environment.

## Run-69 D16 design-gate handover

Human intervention superseded launch-charter helper routing and forbids all helper routes, utility
execution, spend, commits, and lifecycle actions. Run 69 reconciled the existing D16 worktree
directly and made no production or test edit. Exact HEAD remains
`ee559c4f75dfe36e2dd61c607d48a3aba4faa500`; index is empty; D16 remains the sole active Harness
task; root `.loop/` remains untracked with 60 files; both ignored required D16 `plan.md` files remain
present.

Current six-source/five-test producer-to-consumer slice from run 66 remains intact. Recorded focused
proof was not rerun: named omission regression green, parser/broker/store/bridge controls green,
targeted Biome clean, canonical TypeScript exit 0, and `git diff --check` exit 0. Run 69's direct
inspection raised four design risks for independent review: truncated NUL streams appear accepted;
canonical record sorting uses `localeCompare`; replay validates present manifests without itself
requiring one from the request; and bridge rejection is a read-time error rather than a persisted
terminal transition. Existing open choices also remain: legacy missing-evidence materialization,
byte-equivalence for repeated manifests, missing/conflicting evidence failure shape, and classifier
coverage for `executionPlan` requests.

Fresh zero-write Claude design review request
`a1afc3c6-ca24-45f3-9e6f-958ce8d8c982` was accepted with exact scope, evidence, and explicit
`PASS`/`REVISE` requirement. No verdict arrived. Governess decision
`5b138325-581f-4117-bfaa-2ae2ed233a06` ordered fresh-loop preparation before another slice. Two
pre-intervention route IDs, `1e9882f6-c240-4aa9-ad0f-23103dca7f4c` and
`d57d4d15-0509-4dbf-a6bb-428f7963136c`, both settled `utility-unavailable` because Au Pair is
disabled; neither executed, spent, wrote, or produced evidence. Do not route again.

Next bounded action: receive and evaluate Claude's explicit `PASS` or `REVISE` for request
`a1afc3c6-ca24-45f3-9e6f-958ce8d8c982`. Do not add runtime/classifier controls or change any D16
source/test until that verdict. On `REVISE`, correct only blocking D16 design findings. On `PASS`,
add only the remaining runtime missing/conflicting-evidence and request-classification controls,
then run the affected focused files before any broad gate.

Actual governed handover began at epoch `1786837846881948`. Direct delivery of the queued review
request is unsafe because Claude is idle with a non-empty composer, so the successor must request a
fresh zero-write design verdict after verifying preserved state. Run 69 stops here without another
slice. The governed bundle is under the run-69 handoff epoch directory.

## Archived D3 plan from parked spec

### Contract

`route_task` may accept durable work only when a current router can make a decision or when the job
has a durable bounded owner/recovery path. Absence of a lease holder, utility peer, router, or any
eligible tier must reject at admission or write one attributable terminal decision. It must never
look healthy while remaining `pending-route` forever.

Preserve intentional backlog behavior: a temporarily full but otherwise eligible worker pool may
remain `pending-route` until capacity frees. Distinguish temporary capacity pressure from no router,
no eligible capability, stale epoch/authority, and permanently unroutable work. Retries and replay
must not duplicate requests or terminal events.

Starting source seams are `src/loop/bridge-utility.ts` (`routeTask`),
`src/loop/utility-store.ts` (request/decision transitions), `src/loop/task-router.ts`
(`utility-unavailable`), and `src/loop/governess.ts` / `src/loop/utility-runtime.ts` (pending-route
drain ownership). Final owner and fix seam come from reproduction, not assumption.

### Execution

1. Confirm exact base `d5d3140844f9ff7f8447156f4b4f7f27ac093d96`, clean tracked state, preserved
   `.loop/`, and no active Harness task. Promote `harvto-d3-pending-route`; confirm canonical ID and
   base through `./harness status --json`.
2. Read generated run files. Refine promoted `spec.md`, `plan.md`, `tasks.md`, and `verify.md` before
   any source or test edit. Record exact acceptance cases, candidate files, mandatory commands,
   evidence paths, and exclusions.
3. While D3 is active, durably park D15 and D16 as separate Harness ideas/specs without activating
   either. Use `cd loop-fork && ./harness park-idea "<statement>" --name harvto-d16-scope-audit-completeness`
   and the same for `harvto-d15-teardown-process-orphans`. Do **not** use bare `./harness park
   <task-id>`: that form marks a task parked and clears the current marker, which would deactivate
   D3. Verify after each call that `./harness status --json` still reports the D3 task active and
   that `loop-fork/specs/harvto-d1{5,6}-*.md` exist with `status: parked`. Add separate matrix rows with source statement, priority, invariant, and `confirmed`
   status. Do not inspect or mutate Harvto to reconstruct evidence.
4. Trace admission and drain paths read-only. Add smallest deterministic D3 regression while
   production remains at exact base. Cover no router/holder/peer, no eligible tier, and bounded
   restart/replay. Save exact SHA, command, decisive red output, and durable journal rows. Run a
   temporarily-full eligible-pool control to prevent collapsing valid backlog into failure.
5. If D3 does not reproduce, record `already-fixed` or `not-reproduced` with exact contrary proof
   and skip production edits. If reproduced, implement narrow fail-closed correction at the owner
   proven by the test. Avoid broad routing policy, worker-pool, provider, or model changes.
6. Re-run unchanged red test plus stale epoch, malformed evidence, duplicate reconciliation,
   capacity-recovery, unrelated routing, and D1/D4 bridge controls. Record evidence in both Harness
   run artifacts and root eval.
7. Run focused files, `bun run check`, canonical `bunx tsc --noEmit --skipLibCheck --types
   bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts
   src/loop/caveman-skill.d.ts`, `bun run build`, and `bun run test:ci` from `loop-fork`. Run Harness
   `preflight` and `stop-gate`, then root
   `scripts/verify.sh <feature> <canonical-task-id>` with a passing root
   `runs/<canonical-task-id>/eval.json` and empty `baseline_failures`.
   Constraints that have bitten before and still apply:
   - Use the canonical task ID read from `./harness status --json`; never assume it equals the
     parked slug.
   - The eval file must live at repository-root `runs/<task-id>/eval.json`. `scripts/verify.sh:13`
     sets `ARTIFACTS_DIR="runs/${TASK_ID}"` relative to repository root, so an eval written under
     `loop-fork/runs/` fails the gate as missing.
   - The eval must satisfy `scripts/check-baseline-allowlist.py`: top-level `verdict` (or `result`)
     exactly `"pass"`, `baseline_failures` present and an empty list, and no other baseline+fail key
     truthy anywhere in the document. Allowlist by test NAME; never accept a tolerated-failure count.
   - `bun run test:ci` iterates every `tests/**/*.test.ts` serially under
     `LOOP_TEST_CERTIFICATION_MODE=single-file` and is slow. Budget for it; a filtered run never
     substitutes for the full gate.
8. Derive complete scope from Git, stage explicit paths only, and commit. `PLAN.md` and `status.md`
   ride in the same defect commit as their task's evidence. Send Claude exact
   base/head SHAs, Git-derived path list, invariant, red proof, and verification results. On
   `REVISE`, correct D3 only, rerun proportional focused tests and every mandatory gate, create a
   new explicit-path commit, and request fresh exact-SHA review. Repeat until `PASS` or a genuine
   blocker.
9. After `PASS`, record exact verdict, bridge ID, SHA, and checks. Run `harness done` exactly once
   after preflight/stop-gate. Inspect all lifecycle writes, commit explicit D3 bookkeeping paths,
   confirm no active task and only preserved `.loop/` remains, then promote D5 automatically.

## Repeated lifecycle for D5, D16, D15, and D6-D12

For each task, use the previous task's committed bookkeeping SHA as exact base:

1. Confirm no active task and clean tracked state; promote only the next parked ID. Refine generated
   spec/plan/tasks/verify before implementation.
2. Reproduce the named invariant against unchanged production at that base. Preserve exact command,
   red result, state/journal evidence, and controls. Close with contrary evidence if already fixed.
3. Implement only the reproduced branch. Keep one defect's source, tests, matrix hunk, run evidence,
   evals, and lifecycle files separate from every other defect.
4. Run focused regression/control files and the full mandatory verification set listed for D3.
   UI capture is required only if rendered UI behavior changes.
5. Commit explicit paths; obtain zero-write Claude `PASS` on exact final SHA. Any correction gets a
   new SHA and review. Then close Harness exactly once and commit bookkeeping before promotion of
   the next task.

Defect-specific invariants:

- D5: completion is durable and attributable to exact run/task/SHA across restart/replay; no
  completed work remains supervisor-open or closes twice.
- D6: stale read-only tmux viewers cannot block durable targeted recovery, and recovery never types
  into an unsafe pane or composer.
- D7: handoff preserves provider, model, effort, workspace, run identity, and explicit authority
  unless an authorized transition changes them.
- D8: stale/dead utility write leases fail before mutation after epoch or authority changes.
- D9: one resolved acknowledgement yields one durable emission across retries and replay.
- D10: guarded apply rejects absent, stale, or non-applicable targets with exact target/preimage
  evidence and no write.
- D11: recovery uses durable transport and preserves non-empty composers.
- D12: discovery uses manifest-recorded tmux socket/target identity; default-socket globs cannot
  declare a live non-default run absent.
- D16: scope audit enumerates the complete Git-derived modified-path set, including new, deleted,
  renamed, ignored-for-routing but tracked, staged, and committed-range paths; omission or mismatch
  returns a failing/unknown verdict, never a clean false negative.
- D15: completed teardown does not mark lifecycle stopped/completed until exact manifest-owned tmux,
  launcher, Claude child, bridge, and app-server processes are reaped or durable unresolved cleanup
  is recorded. Tests use isolated owned fixtures only; never signal unrelated or preserved live
  runs.

### Verification gaps to close for the two new defects

- D15 liveness must be proven POSITIVELY. Absence of a tmux session, a quiet log, or a
  zero-exit teardown command is not proof a process died: assert with `ps -p <pid>` (or an
  equivalent direct probe) on the exact recorded launcher and Claude-child PIDs, both before
  teardown (must be alive) and after (must be gone), and record what was probed. A teardown
  command's exit status is not acceptance. Kill paths must not rely on unquoted `$PIDS` in zsh
  (single newline-joined argument, no-op behind `2>/dev/null`); pipe to `xargs` and re-enumerate
  PIDs to verify, never trust the kill's exit code.
- D15 fixtures spawn their own short-lived child processes in an isolated temp root with a
  fixture-owned manifest. Assert explicitly that no signal is sent to any PID absent from the
  fixture manifest, and that preserved live runs and `.loop/` are untouched.
- D16 needs a red test that reproduces the ACTUAL observed false negative — an audit of a scope
  with known modified paths returning a clean verdict — not merely a unit test of a path
  formatter. Cover each omitted path class separately: added, deleted, renamed/copied, staged,
  committed-range, and tracked-but-routing-ignored.
- D16 also needs the negative control: a genuinely clean scope must still return a clean verdict
  after the fix. A blanket "always unknown" fail-closed is a regression, not a fix.
- D16's fix must make omission observable at the CONSUMER, not just inside the audit: prove the
  caller that renders/acts on the verdict fails closed on a count or hash mismatch against the
  Git-derived set. Prefer deriving the comparison from the artifact's own path set over an
  enumerated allowlist.
- Both new defects, once verified, must have their matrix rows written during D3 and never edited
  from another defect's commit.

## Scope and commit proof

Until D16 is fixed, compute authoritative sets with Git for every boundary:

- Before staging: `git status --porcelain=v2 --untracked-files=all`, `git diff --name-status`, and
  `git diff --cached --name-status`.
- After commit: `git diff-tree --no-commit-id --name-status -r <sha>` and
  `git diff --name-status <task-base>..<task-head>`.
- Compare routed audit output as an untrusted advisory set against the Git set. Any missing or extra
  path blocks commit/review until reconciled.
- Check `git diff --check`, cached diff, normal versus `--ignore-all-space` numstats, matrix hunk
  bounds, and explicit exclusions. Stage with `git add -- <exact paths>`; force-add ignored Harness
  evidence only when classified and required.
- After each commit and Harness close, prove `.loop/` still exists, remains untracked, and is absent
  from commit range. Also prove no Harvto, unrelated defect, dependency, provider/model, remote,
  deployment, or release path entered the range.

## Acceptance criteria

- D3 starts from exact base `d5d3140844f9ff7f8447156f4b4f7f27ac093d96`, is promoted from its
  parked spec, and has a refined Harness-owned plan before implementation.
- Every confirmed defect has red exact-base proof, a narrow fail-closed fix, replay/idempotency
  controls, focused tests, mandatory suite evidence, both eval schemas, Harness gates, and root
  verifier pass.
- Review mechanism for every task: routed `kind=review` with `review_mode=peer-verdict` (or omitted)
  against the exact committed SHA, no TTL, every write/authority flag false, carrying base SHA, head
  SHA, Git-derived path list, invariant, red proof, and verification results. `utility-audit` mode is
  advisory evidence only and never a review verdict. A `PASS` is recorded with its bridge ID.
- Every final implementation SHA receives zero-write Claude `PASS`; every revision is separately
  committed, reverified, and reviewed.
- Every Harness task closes exactly once and its lifecycle/bookkeeping commit lands before the next
  promotion. No active task remains after final D15 closure.
- D15 and D16 are durably parked during D3, retain independent specs/tasks/commits/reviews, and are
  closed only after ordered D3, D5, and D6-D12 work.
- All path sets reconcile against Git-derived truth. `.loop/` remains preserved and untracked.
- No prohibited action or campaign widening occurs.

## Open questions to resolve from reproduction

- Does any confirmed defect fail to reproduce at its exact base? If so the deliverable is a
  recorded refutation (`already-fixed` / `not-reproduced`) with exact contrary proof, not a patch
  shaped to the ticket.
- D3: can admission prove permanent ineligibility, or must durable reconciliation own the bounded
  terminal transition while preserving temporary eligible-pool backlog?
- D5-D12: exact failure owner and smallest deterministic boundary for each parked report.
- D16: which routed audit stage drops paths and which path classes are omitted.
- D15: which teardown owner loses exact launcher/child registration after tmux and manifest stop.

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

### Claude reviewer correction to the run-69 handover (epoch 1786837846881948)

Recorded by Claude, not Codex. Corrects one falsified inference above.

Review request `a1afc3c6-ca24-45f3-9e6f-958ce8d8c982` WAS delivered. Claude pulled it durably from
the bridge together with Governess decision `6298eed2-8758-4b70-85bb-ccb439f446e7` and the urgent
handover directive `d7f49844-500c-4061-85de-99dafeaa7c21`. The statement that direct delivery was
unsafe because Claude was idle with a non-empty composer is superseded: delivery succeeded.

Claude issued NO D16 design verdict. Neither `PASS` nor `REVISE` was returned. The verdict was
withheld deliberately: the urgent Governess handover directive permits finishing only the current
atomic step, and an adequate verdict requires reading six production sources, five focused tests,
and four canonical spec files, then independently adjudicating four open design questions plus five
flagged acceptance risks. That is a new slice, not an atomic step. A rushed `PASS` would have become
inherited approval, which is the exact failure mode that run-66 request
`10069fa8-5335-474d-8eb6-8fa35ba60a7b` and run-67 request `2c15370f-5759-4038-b928-c954f23091bf`
already produced once each.

Consequence for the successor: three D16 review requests now exist with zero durable verdicts. No
approval exists from any run. The successor must obtain a fresh zero-write Claude `PASS` or `REVISE`
against verified preserved state before adding any runtime or classifier control.

## Run-70 D16 design verdict and bounded correction handover

Result: fresh Claude zero-write design review `cf060ab5-47b6-41c5-a52a-0894463b9054` returned
first-token `REVISE`. The verdict is durable and does not inherit approval from runs 66, 67, or 69.
Claude confirmed B1-B6, then decision `3aebdf98-0649-4b70-9dc2-0108b8254e5f` added B7. Governess
ordered fresh-loop preparation before the correction slice could continue.

Blocking corrections:

1. Bind each manifest to the canonical declared Git pathspec; evidence inventory must ignore
   model-selected narrowing.
2. Persist a collection keyed by canonical query identity. Exact byte equality applies only to
   repeated calls under one key; distinct queries coexist.
3. Classify top-level and `executionPlan` `git-status`/`git-diff` profiles independent of request
   kind and review mode.
4. Replace scope-audit completion prose with deterministic manifest state and mark synthesis
   advisory.
5. Replace `localeCompare` with deterministic string ordering.
6. Validate query mode/ref/pathspec/range invariants at the consumer boundary.
7. Resolve base/head refs once in the broker before either diff command. Use the same literal SHAs
   in both commands and persisted query. Preserve three-dot behavior and record
   `rangeOperator: "..."` so exact-SHA review reproduces the same range.

Current atomic step completed only in
`loop-fork/src/loop/utility-scope-audit.ts` (SHA-256
`8abbd805a3b308e11b3a43b2c7ed41fae27ef710e5644537be801e90829f207f`):

- `UtilityScopeAuditQuery` now carries canonical `paths` and optional three-dot range operator.
- `UtilityScopeAuditCollection` is `{ schemaVersion: 1, manifests: [...] }`.
- Query identity, deterministic string ordering, mode/ref/pathspec invariants, collection
  canonicalization, duplicate-query rejection, and collection reconciliation are defined.
- Both NUL parsers reject non-empty non-NUL-terminated input as defense in depth.

This is an intentionally incomplete cross-file boundary. Existing producers, compact-result types,
store/bridge validators, runtime retention, notifications, and tests still use the old singular
manifest/query shape. No typecheck or tests were run after the type declaration because Governess
stopped the slice. Targeted Biome for `utility-scope-audit.ts` passes and `git diff --check` passes.

Next bounded action:

1. Update `utility-tools.ts` to inventory declared broker read scopes, include canonical pathspecs,
   resolve range refs once, and pass literal SHAs plus `rangeOperator: "..."` to both commands and
   manifest query.
2. Wire `UtilityScopeAuditCollection` through `task-router.ts`, `utility-runtime.ts`,
   `utility-store.ts`, and `bridge-utility.ts`; add per-query retention, expanded classifier, and
   deterministic completion notification.
3. Update existing D16 tests and add the exact B1-B7 controls named in Claude's verdict before
   focused and mandatory suites.

Keep the 64 KiB evidence-command output limit as an explicit fail-closed usability bound. Do not
silently truncate. Preserve disabled utility flags, empty index, root `.loop/`, ignored D16 plan
files, all evidence, sole active D16 Harness task, and every campaign authority boundary.

### Actual governed handover — epoch 1786839685729749

Human requested the fresh-loop handover after the run remained idle in prepare. Do not resume
implementation in run 70. Preserve the exact state above and publish the Codex bundle at
`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/70/handoff/1786839685729749/codex.json` only
after this planning/status update. Replacement starts with B1+B7 in `utility-tools.ts`; no new
design review is required before those bounded corrections.

## Run-71 D16 B1+B7 broker slice; fresh-loop preparation

Result: run 71 accepted validated epoch `1786839685729749`, completed the bounded B1+B7 broker
correction, and stopped when Governess decision `b784dd05-6a30-4f99-9454-0dffce31e17e` ordered
fresh-loop preparation at the context threshold. Exact HEAD remains
`ee559c4f75dfe36e2dd61c607d48a3aba4faa500`; index remains empty; D16 remains the sole active
Harness task; utility remains hard-disabled at `0/off/0`.

Completed in `loop-fork/src/loop/utility-tools.ts`:

- `git_status` evidence and persisted query now bind the broker's declared read scopes.
- `git_diff` keeps model-selected narrowing only in the helper-visible command. Its authoritative
  evidence command and persisted query always use the complete declared broker read scopes.
- Committed-range execution resolves base and head exactly once each through bounded
  `git rev-parse --verify <ref>^{commit}` before either diff command. Resolution must return one
  full 40- or 64-hex commit SHA or the broker fails closed.
- The same resolved literal `base...head` range is used in the helper-visible command and evidence
  command. Persisted query records those literal SHAs, declared paths, and
  `rangeOperator: "..."`.

The next collection slice started but is intentionally incomplete:

- `loop-fork/src/loop/task-router.ts` changes `UtilityCompactResult.scopeAudit` to
  `UtilityScopeAuditCollection` and classifies top-level plus read-plan `git-status`/`git-diff`
  independently of kind and review mode.
- `loop-fork/src/loop/utility-store.ts` now validates a persisted collection rather than a singular
  manifest.
- `utility-runtime.ts` and `bridge-utility.ts` still retain/consume the old singular shape. Tests
  still construct the old shape. Do not run or claim typecheck/test readiness until that wiring is
  complete.

Current source SHA-256 values:

- `utility-scope-audit.ts`: `8abbd805a3b308e11b3a43b2c7ed41fae27ef710e5644537be801e90829f207f`
- `utility-tools.ts`: `d4bd221c40187264a97835b68f3e81bdf159893008d26638e4bf43e63a6588ea`
- `task-router.ts`: `9d5c833873be1955c3333b37cd35b0791e3ea2fb5f3ed516e294284093c95ea0`
- `utility-store.ts`: `665b93b3696ad8a167e19779183874a6f04fb4e4f1420f7ee7f4a9313d71c6cc`

Checks: targeted Biome over those four files passed with no fixes; `git diff --check` passed. No
typecheck, focused test, build, serial suite, eval, Harness gate, commit, or review ran in run 71.

Next bounded action: finish collection retention in `utility-runtime.ts`; validate collections and
declared path coverage in `bridge-utility.ts` including B1c; render deterministic
mode/count/clean/SHA notification text with synthesis marked advisory. Then update existing controls
for B1-B7/B1c and run focused D16 files before mandatory suites. Preserve all existing dirty source,
tests, specs, run evidence, ignored plans, root `.loop/`, empty index, and authority boundaries.

### Actual governed handover — epoch 1786842065523738

Human requested graceful handover after the run-71 broker slice. Preserve the exact incomplete
collection boundary above. Replacement resumes with `utility-runtime.ts`, then
`bridge-utility.ts` B1c and deterministic notification wiring; do not repeat B1+B7 or the run-70
design gate.

Reviewer gate state at this handover: no run-71 review verdict exists (Codex sent no review request
before the governess stop), so the governing verdict is still run-70 REVISE
`cf060ab5-47b6-41c5-a52a-0894463b9054` plus blocking B7 decision
`3aebdf98-0649-4b70-9dc2-0108b8254e5f`. The run-71 `utility-tools.ts`, `task-router.ts`, and
`utility-store.ts` changes are unreviewed and untested. A Claude zero-write exact-SHA PASS, with
B1c consumer path-coverage validation and its narrowed-manifest control present, still gates the
D16 commit; do not commit or close the Harness task without it.

## Run-72 D16 runtime collection slice; fresh-loop preparation

Result: run 72 verified epoch `1786842065523738`, preserved exact HEAD/base
`ee559c4f75dfe36e2dd61c607d48a3aba4faa500`, and completed only the bounded
`utility-runtime.ts` collection/notification slice before Governess ordered fresh-loop preparation
at the context threshold. Index remains empty; D16 remains the sole active Harness task; utility
remains hard-disabled at `0/off/0`.

Completed in `loop-fork/src/loop/utility-runtime.ts`:

- Conversation state now retains `UtilityScopeAuditCollection` through legacy, Direct, and Pi
  paths and persists the same collection in `UtilityCompactResult`.
- Successful broker manifests are keyed by canonical `utilityScopeAuditQueryIdentity`. A repeated
  key must be byte-identical or fails closed; distinct keys coexist and are canonically ordered by
  `buildUtilityScopeAuditCollection`.
- Helper-visible payloads still exclude authoritative scope evidence.
- Scope completion notifications begin with deterministic
  `mode/count/clean/sha256` state for each canonical manifest, then label model text
  `Advisory synthesis`.

Current `utility-runtime.ts` SHA-256 is
`a5698b774a2f0c3633d5fe94c7564009b5968d05642d41f3f28f69305542f7c8`. Targeted
`bunx biome check src/loop/utility-runtime.ts` passed with one file checked and no fixes;
`git diff --check` passed. No typecheck, focused test, build, serial suite, eval, Harness gate,
commit, or lifecycle action ran because bridge and fixtures still use the singular shape.

Claude design question `a090c7f1-b2d1-4c19-a8bc-09744ed88a35` was accepted for delivery, asking
whether read-plan coverage may use one compatible union-path manifest for multiple same-mode steps.
No answer or review verdict arrived before Governess decision
`d994abb9-b37c-448e-8fdf-8c57910d6155`; only the fresh-loop preparation order was received.

Next bounded action: pull Claude's response if pending, then update `bridge-utility.ts` to validate
collections and enforce B1c declared path coverage, including the hand-edited narrowed persisted
manifest control. After that migrate collection fixtures and add runtime same-key conflict,
distinct-key coexistence, deterministic notification, router classification, and bridge read-plan
coverage controls. Run focused D16 files before mandatory suites. Do not repeat B1+B7 or the
run-70 design gate.

### Actual governed handover — epoch 1786843562643959

Human requested graceful handover after the run-72 runtime slice. Preserve the exact incomplete
collection boundary above. Required bundle is
`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/72/handoff/1786843562643959/codex.json`.
Replacement resumes with pending Claude message retrieval, then `bridge-utility.ts` collection and
B1c declared-scope validation; do not start another source slice in run 72.

## Claude B1c verdict — REVISE (epoch 1786843562643959)

Design question `a090c7f1-b2d1-4c19-a8bc-09744ed88a35` is answered. Verdict REVISE, bridge message
`db2a8ff5-b447-406d-9e20-5e8957617312`. It is a design consult only; the D16 commit and the one
Harness close still require a separate Claude zero-write exact-SHA PASS over unreviewed run-71
B1+B7 source and the run-72 runtime slice.

The proposed read-plan compatibility rule "status manifest only with git-status, any non-status
manifest only with git-diff" fails open and must not be implemented. Four modes exist
(`loop-fork/src/loop/utility-scope-audit.ts:35`) and `resolveGitDiffExecution`
(`loop-fork/src/loop/utility-tools.ts`, near 2415-2440) emits `diff-index`, `diff-worktree`, and
`diff-range` from one broker, so the split makes all three interchangeable. A `diff-worktree`
manifest would satisfy a commit-bound `diff-range` step whose paths it covers, certifying
uncommitted working-tree state and rendering B7 range binding decorative.

Next bounded action, superseding the previous next step: implement `bridge-utility.ts` collection
assertion and B1c with R1 exact mode-plus-range allowlist, R2 range equality on classified
top-level git-diff jobs, and R4 deterministic notification ordering folded in from the start.
Then add the R3 controls (narrowed paths, substituted mode, wrong range) and both vacuous
read-plan branches. Only then migrate collection fixtures and run focused D16 files before the
mandatory suites. Do not repeat B1+B7 or the run-70 design gate. Preserve utility `0/off/0`, the
empty index, root `.loop/`, ignored plans, and every campaign authority boundary.

## Run-73 D16 B1c representation audit; fresh-loop preparation

Result: run 73 completed the bounded pre-edit representation audit and found one blocking contract
gap. Governess decision `24fcff6c-38d0-410a-8122-b1854d6de348` then ordered fresh-loop preparation,
so no source, test, spec, run-evidence, Harness, staging, commit, or lifecycle slice started.

Verified state:

- Launch charter SHA-256 matched
  `aa3c63bdbf5285d25b7fad90f329ee1daa1b950fb2078719824f5c880df52ee8` before work.
- Both run-72 epoch `1786843562643959` bundles were read completely, were `ready`, and bound exact
  HEAD/base `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`.
- World-model bootstrap file SHA-256 matched
  `d876e7cc0eb80b61b115ee6a39c0545d9360f0b2092f4ef6bbccc2b4c8e8d3c8`; logical capsule matched
  `907da911e475cd2c37f427efcd8b664ba56715358e892a5bd1e387609422e15c`; every embedded
  `commitSha` matched current HEAD.
- Index remained empty. Harness still selected only
  `harvto-d16-scope-audit-completeness`, emergent, active, eval pending. Root `.loop/` remained at
  60 files; both ignored D16 plans remained present; utility environment measured `0/off/0`.
- `src/loop/utility-runtime.ts` remained byte-identical to the run-72 handoff at SHA-256
  `a5698b774a2f0c3633d5fe94c7564009b5968d05642d41f3f28f69305542f7c8`.

Representation finding:

- `UtilityRouteRequest` and `UtilityReadPlanStep` declare an execution profile and read scopes but
  persist no `baseRef`, `headRef`, or `staged` git-diff selection. `bridge-utility.ts` exposes no
  corresponding structured route field, and Direct read-plan git-diff calls carry only `paths`.
- Claude R1/R2 require exact equality against the declared mode and literal range. Profile plus
  paths cannot distinguish `diff-index`, `diff-worktree`, and `diff-range`; parsing free-form
  objective text would be ambiguous and fail open.
- Codex sent targeted zero-write clarification request
  `15a7013c-ea0a-453b-bc4d-cfd135746c9e` proposing optional structured
  `execution_git_diff` metadata at top-level and per read-plan step, with exact-mode/range consumer
  validation. No response arrived before the Governess preparation decision; no approval is
  inferred.

Checks this run: native read-only Git/Harness/environment checks, complete governing-artifact read,
current source/test inspection, and `git diff --check` from the inherited worktree. No typecheck,
focused test, build, serial suite, eval, verifier, helper route, or spend ran.

Next bounded action in the fresh loop: validate both new handoff bundles, pull Claude's response to
`15a7013c-ea0a-453b-bc4d-cfd135746c9e`, and settle the smallest structured selection contract. Then
implement B1c collection assertion and shared exact mode/range/path coverage validation before
migrating fixtures. Do not parse objective prose, start tests on the intentionally incomplete tree,
or widen beyond D16.

### Actual governed handover — epoch 1786844896236203

Human requested graceful handover after the run-73 representation audit. Preserve the exact
uncommitted D16 boundary above. Required Codex bundle is
`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/73/handoff/1786844896236203/codex.json`.
Run 73 starts no implementation, test, commit, review gate, or Harness lifecycle slice after this
point.

### Claude verdict `d708bc7f-1371-47c3-be76-7ef903789a9e` — B1c git-diff selection representation

Answers `15a7013c-ea0a-453b-bc4d-cfd135746c9e`. ACCEPT structured `execution_git_diff` declaration at
top level and per read-plan step, WITH six bounded corrections recorded in full in `status.md`. Not a
new design gate. Claude exact-SHA zero-write PASS remains the only gate before the D16 commit and the
single Harness close.

Binding summary for the successor's next bounded action:

1. Normalize selection to a discriminated union: `{kind:"worktree"}`, `{kind:"index"}`, or
   `{kind:"range", base, head, operator}`. Undeclared is a fourth, distinct state.
2. Do NOT default undeclared to worktree for validation. Compare through an explicit pairing
   allowlist; undeclared x range and range x non-range fail closed.
3. Parse-time rejection of `head_ref` without `base_ref`, `staged:true` with any ref, and any
   base/head not lowercase 40-hex. No abbreviated or symbolic refs, no resolution at validate time.
4. Persist and compare the range operator as data; never re-infer it.
5. Fold the normalized selection into the canonical query key so distinct ranges coexist.
6. One shared validator for runtime completion and the bridge consumer, both exercised by tests.

Then migrate collection fixtures and add the runtime same-key equality/conflict, distinct-key
coexistence, deterministic notification, router classification, and bridge controls. Run focused D16
files, including utility-runtime, task-router, and bridge, before the mandatory suites and evals.

## Run-74 D16 continuation

Verified launch charter, both run-73 ready bundles, world-model file/capsule/commit bindings, exact
HEAD `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`, empty index, D16 current-task identity, root `.loop/`
count 60, ignored plans, runtime SHA-256, and utility `0/off/0`. Claude verdict
`d708bc7f-1371-47c3-be76-7ef903789a9e` settles C1-C6; no design gate is reopened.

Current bounded sequence:

1. Add optional top-level/read-plan `execution_git_diff` metadata normalized to worktree, index, or
   exact lowercase-40-hex range; preserve absence as undeclared.
2. Add one shared collection-to-request validator with stable reason codes and call it from runtime
   completion plus bridge consumption.
3. Thread declared selection into Direct read-plan broker calls, include normalized selection in
   query identity, migrate collection fixtures, and add C1-C6/runtime/router/bridge controls.
4. Run focused D16 files before mandatory suites, evals, explicit D16 commit, Claude exact-SHA PASS,
   one Harness close, and separate bookkeeping commit.

### Run-74 fresh-loop preparation

Governess decision `4599bdbe-960b-4836-8303-cbfb51560d31` stopped work after the current atomic
`task-router.ts` slice. Preserve this uncommitted boundary.

- `UtilityGitDiffSelection` is now the discriminated union worktree/index/range. Range stores exact
  lowercase 40-hex base/head plus explicit `...` operator.
- `UtilityRouteRequest` and `UtilityReadPlanStep` carry optional `executionGitDiff`; omission remains
  undeclared. Request creation clones and validates it with stable parse reason
  `scope-audit-selection-invalid`.
- Boundedness rejects malformed or profile-incompatible top-level/read-plan selection metadata and
  forbids it on edit packets.
- Targeted Biome and `git diff --check` pass. Current `task-router.ts` SHA-256 is
  `dda4c3c7caa380d8949de0f11bae3945388bcdf68ddff520605c3fbbcd24b48c`.

Next bounded action: add bridge `execution_git_diff` schema/parser, thread selection through Direct
read-plan calls, then implement one shared B1c validator in `utility-scope-audit.ts` and invoke it
from runtime completion plus bridge consumption. Do not start fixtures until those source seams are
wired. No test/typecheck/broad suite has run on the intentionally incomplete cross-file boundary.

### Actual governed handover — epoch 1786846009516945

Human requested graceful handover after the run-74 structured-selection atomic slice. Preserve this
exact uncommitted boundary. Required Codex bundle is
`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/74/handoff/1786846009516945/codex.json`.
No additional implementation, test, commit, review gate, or Harness lifecycle slice begins here.

#### Reviewer (Claude) state at epoch 1786846009516945

Claude bundle: `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/74/handoff/1786846009516945/claude.json`.
Claude performed no source, test, or lifecycle work in run 74 and holds no in-flight review request.
Reviewer-held gates carried forward unchanged:

- Structured selection verdict `d708bc7f-1371-47c3-be76-7ef903789a9e` (bridge message
  `a8078822-e3aa-4b3e-85a8-a4e17c406586`) ACCEPTS `execution_git_diff` with C1-C6. Settled; the
  successor must not reopen it and no new design gate is required.
- Open REVISE state still outstanding: `cf060ab5-47b6-41c5-a52a-0894463b9054` B1-B6, B7 decision
  `3aebdf98-0649-4b70-9dc2-0108b8254e5f`, and B1c R1-R4 REVISE
  `db2a8ff5-b447-406d-9e20-5e8957617312`.
- Claude exact-SHA zero-write PASS still gates the D16 commit and the one Harness close. That gate
  has not been requested or granted in run 74.

## Run-75 D16 reconciliation; fresh-loop preparation

Result: run 75 accepted epoch `1786846009516945`, completed only bootstrap, preserved-state,
governing-artifact, and first-seam inspection, then stopped on Governess decision
`29e82039-e002-4780-b431-6c23e1e5ac50` at the context preparation threshold. No D16 source, test,
spec, run evidence, Harness, staging, commit, review-gate, or lifecycle slice started.

- Launch charter SHA-256 matched
  `96a3bc1090d4ece30c415969dd387d842fb6f2d23151facb5ccf7cfb71a0f9d3` before the charter was read.
- Both run-74 bundles and `continuation.md` were read completely. Their SHA-256 values matched the
  manifest: Claude `3eaa27b3396e788a5f921ec2a2260e96ffc92db3071caf61f47f7288ae423d31`,
  Codex `9a44e087bfc44dae7024ae1d79f49d1736e1548534d05772fd8a155303c4a591`, and continuation
  `f651c068f402d7ab4ce973f29f8d68c85fcaa319b5d96e0e0c608a8a734b5285`.
- World-model bootstrap file SHA-256 matched
  `d876e7cc0eb80b61b115ee6a39c0545d9360f0b2092f4ef6bbccc2b4c8e8d3c8`; capsule SHA-256 matched
  `907da911e475cd2c37f427efcd8b664ba56715358e892a5bd1e387609422e15c`; every embedded commit bound
  exact HEAD `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`.
- Preserved state revalidated: empty index, sole active D16 task emergent/eval-pending, root `.loop/`
  60 files, ignored run/spec plans present, utility `0/off/0`, task-router SHA-256
  `dda4c3c7caa380d8949de0f11bae3945388bcdf68ddff520605c3fbbcd24b48c`, runtime SHA-256
  `a5698b774a2f0c3633d5fe94c7564009b5968d05642d41f3f28f69305542f7c8`, and `git diff --check`
  pass.
- Read full root plan/status, run-74 transcript, constitution, architecture, dependency map, quality
  scorecard, testing commands, canonical D16 spec/plan/tasks/verify, run plan/task log, source trace,
  and exact-base red evidence. Utility routing remained prohibited and unused.

Next bounded action remains unchanged: add optional bridge `execution_git_diff` schema/parser and
thread normalized selection into Direct read-plan `git_diff` calls. Then implement one shared B1c
collection-to-request validator in `utility-scope-audit.ts` and invoke it from runtime completion
plus bridge consumption. Do not migrate fixtures before those source seams. Preserve C1-C6 as
settled, all current uncommitted work, empty index, root `.loop/`, ignored plans, utility `0/off/0`,
and every authority boundary.

### Actual governed handover — epoch 1786847216808383

Human requested graceful handover after run-75 reconciliation. Preserve this exact uncommitted
boundary. Required Codex bundle is
`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/75/handoff/1786847216808383/codex.json`.
Run 75 starts no implementation, test, verification, staging, commit, review, or Harness lifecycle
slice after this point.

## Plan-only continuation from epoch 1786847216808383

Result: both ready bundles validate and current governed state is preserved. This section is the
active D16 plan. It does not reopen settled design or authorize code work during this session.

### Preserved boundary

- Exact HEAD/base stays `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`; index stays empty until
  explicit D16 staging.
- Root `.loop/` stays untracked and byte-preserved at its observed 60 files. Ignored D16 run/spec
  `plan.md` files and all existing evidence stay present.
- D16 remains the sole current Harness task, `emergent`, `active`, and eval-pending. Do not close it
  before exact-SHA review.
- Utility remains hard-disabled. Use no helper, native fallback, provider call, or spend; before any
  future executable check, make effective values explicit as `LOOP_UTILITY_ENABLED=0`,
  `LOOP_UTILITY_DELEGATION_MODE=off`, and `LOOP_AU_PAIR_ENABLED=0`.
- Preserve verdict `d708bc7f-1371-47c3-be76-7ef903789a9e` and C1-C6. Preserve outstanding review
  obligations `cf060ab5-47b6-41c5-a52a-0894463b9054`,
  `3aebdf98-0649-4b70-9dc2-0108b8254e5f`, and
  `db2a8ff5-b447-406d-9e20-5e8957617312` until final exact-SHA PASS.

### Implementation sequence

1. Complete bridge declaration parsing.
   - Add optional `execution_git_diff` schema and parser at top level and per `execution_plan` step.
   - Preserve field absence as `undeclared`. Normalize present input to exactly worktree, index, or
     range selection. Reject unknown fields, one-sided refs, staged-plus-refs, non-lowercase/full-40
     SHAs, and missing/wrong operator with `scope-audit-selection-invalid`.
   - Update route schema text only enough to document structured selection. Never parse objective
     prose for mode, refs, or operator.
2. Thread declared selection into Direct execution.
   - Update `utility-execution-tier.ts` so Direct read-plan `git_diff` calls include exact staged or
     range arguments plus declared paths. Field absence may execute as worktree for compatibility,
     but validation identity remains `undeclared`.
   - Preserve broker-side one-time ref resolution and one identical literal three-dot range for
     helper-visible and authoritative evidence commands.
3. Add one shared collection-to-request validator in `utility-scope-audit.ts`.
   - Derive classified declarations from top-level and read-plan `git-status`/`git-diff` requests.
     Require `status` for status; explicit worktree/index exact mode; explicit range exact lowercase
     base/head/operator equality. Allow only legacy `undeclared` paired with worktree.
   - Require literal canonical pathset inclusion. Allow one compatible union-path manifest to cover
     multiple same-selection steps; use no filesystem ancestor semantics and no per-step attribution.
   - Reject missing evidence, narrowed paths, substituted mode, wrong range, orphan manifests, and
     conflicting/duplicate collections with stable reason codes. Preserve vacuous zero-Git-step plus
     zero-manifest success; reject zero-Git-step plus manifests.
   - Keep normalized selection in canonical query identity so distinct ranges coexist, while same
     query identity with different bytes fails closed.
4. Invoke the shared validator at both authority boundaries.
   - Runtime: validate collection against request before any completed result/clean notification can
     be persisted or sent. Failure enters the existing durable failed path with reason intact.
   - Bridge: validate persisted collection shape and request coverage before returning
     `get_task_result`; current scope jobs without evidence remain legacy/unverified, never clean.
   - Keep completion segments ordered by `utilityScopeAuditQueryIdentity`, with fields exactly
     `mode,count,clean,sha256`, followed by explicitly advisory synthesis.
5. Migrate fixtures only after source seams compile.
   - Convert singular manifests to collections. Convert any objective-only commit-range route fixture
     to structured range metadata; do not weaken C1.
   - Add parser/router and Direct-call controls for valid worktree/index/range plus all illegal C2
     forms.
   - Add shared/runtime/bridge controls for narrowed paths, substituted mode, wrong head with equal
     base, orphan range against undeclared, legacy undeclared/worktree success, top-level and
     read-plan coverage, vacuous branches, same-key equality/conflict, distinct-range coexistence,
     deterministic notification order, and replay.
   - Retain D16 path-class controls: added/untracked, deleted, rename/copy, staged, unstaged,
     committed range, tracked routing-ignored metadata, malformed/duplicate/truncated/count/hash
     tamper, synthesis omission, clean zero set, and non-scope legacy materialization.

### Verification and closure

1. Run targeted Biome and `git diff --check`, then focused affected files: scope-audit, tools,
   execution-tier, router, runtime, store, bridge, and Pi-harness tests. Utility stays hard-disabled;
   tests use local deterministic fixtures only.
2. Run mandatory commands from `loop-fork`: `bun run check`; canonical `bunx tsc --noEmit
   --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext
   src/cli.ts src/loop/caveman-skill.d.ts`; `bun run build`; and
   `LOOP_TEST_CERTIFICATION_MODE=single-file bun run test:ci`.
3. Write passing Harness and repository-root evals with empty `baseline_failures`; pass Harness
   preflight/stop-gate and `scripts/verify.sh harvto-d16-scope-audit-completeness
   harvto-d16-scope-audit-completeness`. No UI capture unless rendered behavior changes.
4. Reconcile authoritative Git scope using porcelain-v2, unstaged/cached name-status, exact-range
   diff-tree, numstats, ignore-all-space comparison, and D16 exclusions. Stage only explicit D16
   paths and create one D16 implementation commit without plans, root `.loop/`, or unrelated work.
5. Request Claude zero-write review of that exact SHA. Require literal `PASS`; if revised, correct,
   re-run required proof, create the new exact SHA, and review again. Do not close Harness first.
6. After PASS, close Harness exactly once. Inspect resulting lifecycle changes and commit them as a
   separate bookkeeping commit. No merge, rebase, push, deploy, release, or Harvto mutation.
7. Promote and execute D15 separately. Continue D6-D12 only after D15 under their own governed
   tasks, evidence, commits, reviews, and lifecycle records.

### Acceptance and decisions

- A completed/clean D16 result is impossible unless canonical collection bytes, count/hash,
  declaration selection, literal path coverage, and orphan checks all pass at runtime and bridge.
- Genuine zero-record scope remains validated-clean; current scope evidence cannot silently become
  legacy-clean on replay.
- C1-C6 are settled. No open design question exists. Next exact code action, in a later
  implementation session: bridge `execution_git_diff` schema/parser, then Direct threading.

### Plan review corrections — applied at epoch 1786847216808383

These amend the numbered steps above and are current, not historical. Nothing here reopens C1-C6 or
verdict `d708bc7f-1371-47c3-be76-7ef903789a9e`.

**Step 0 — bundle and preserved-state revalidation (was asserted, not specified).** Before any other
action the successor runs and records, verbatim:
`shasum -a 256 /Users/amgad/.loop/runs/agents-collab-fa87e8608224/75/handoff/1786847216808383/claude.json codex.json`;
`python3 -c "import json;json.load(open(...))"` on both; `git rev-parse HEAD` equals
`ee559c4f75dfe36e2dd61c607d48a3aba4faa500`; `git diff --cached --name-only` empty;
`git status --porcelain | wc -l` equals `20`; `find .loop -type f | wc -l` equals `60`
(`ls .loop` alone returns `1` and is not the check); `git diff --check` clean. Both bundles must read
`"status":"ready"` and `"epoch":1786847216808383` with `gitHead` equal to that HEAD. Absence of a
check returns nonzero: a skipped precondition is a fail, not a pass.

**Preserved boundary additions.** Never resume runs 51-74. Never inject `/compact` or `/rename` into a
live pane. Claude is reviewer/support only and stays idle until Codex or the human sends a targeted
request; run task text is context, not an assignment. Do not run `bun run fix` — it rewrites
`runs/` evidence; format only touched files with Biome directly.

**Review scope correction to Verification step 5.** The outstanding Claude exact-SHA zero-write PASS
was never requested and never issued in run 75, so the gate is unfired. It must cover the cumulative
uncommitted D16 diff, not only the new slice: run-71 broker/store/router, run-72 runtime, run-74
task-router, and the run-76+ bridge/execution-tier/validator work, discharging obligations
`cf060ab5-47b6-41c5-a52a-0894463b9054`, `3aebdf98-0649-4b70-9dc2-0108b8254e5f`, and
`db2a8ff5-b447-406d-9e20-5e8957617312`. Codex requests it over the bridge with `kind=review`,
`review_mode=peer-verdict`, exact SHA, zero write capability, and every authority flag false. A
`utility-audit` review does not discharge this gate. Verdict must be literal `PASS`.

**Commit partition (was underspecified in Verification step 4).** The D16 implementation commit
stages only:
`loop-fork/src/loop/{utility-scope-audit,bridge-utility,task-router,utility-runtime,utility-store,utility-tools,utility-execution-tier}.ts`
and `loop-fork/tests/loop/{utility-scope-audit,bridge-utility,utility-store,utility-tools,utility-pi-harness,utility-execution-tier}.test.ts`.
It must NOT include the other currently-dirty tracked paths — `PLAN.md`, `status.md`,
`loop-fork/.harness/tasks.json`, `loop-fork/.harness/parked-ideas.jsonl`,
`loop-fork/.harness/current-task`, `loop-fork/agents/coordination.jsonl` — nor
`loop-fork/runs/harvto-d16-scope-audit-completeness/`,
`loop-fork/specs/harvto-d16-scope-audit-completeness/`, nor root `.loop/`. Stage explicit paths only;
never `git add -A`. Those bookkeeping and evidence paths belong to the separate post-close commit in
step 6. Before committing, diff `git diff --numstat` against `git diff --numstat --ignore-all-space`
and stop if they disagree.

**Verification path and artifact corrections.**
- `scripts/verify.sh` lives at repository root, not under `loop-fork/`; invoke it as
  `./scripts/verify.sh harvto-d16-scope-audit-completeness harvto-d16-scope-audit-completeness`
  from the repository root, while `bun run check`, `bunx tsc ...`, `bun run build`, and
  `LOOP_TEST_CERTIFICATION_MODE=single-file bun run test:ci` run from `loop-fork/`.
- `loop-fork/runs/harvto-d16-scope-audit-completeness/eval.json` already exists from the exact-base
  red state. It must be regenerated from the post-implementation run, not reused; PASS requires
  `baseline_failures` empty. Never accept green by failure count — allowlist any tolerated failure by
  test NAME and require that list empty to release.
- Append the run entry to `loop-fork/runs/harvto-d16-scope-audit-completeness/task-log.md` and the
  run record to root `status.md` as part of the separate bookkeeping commit, not the D16 commit.
- `status.md` exists at repository root (2249 lines) and needs no creation step. Both it and
  `PLAN.md` are already dirty from the run-75 handover; do not overwrite either wholesale — append.

**Red-state and failure-branch handling.** The current cross-file worktree is intentionally
incomplete and is not typecheck-ready or test-ready; a successor must not read that red state as a
regression, and must not "fix" it by weakening C1-C6 or by relaxing a control. If a mandatory suite
goes red outside D16 scope, record the failing test names, stop, and report rather than widening
scope. Fixture migration stays blocked until the bridge parser, Direct threading, and shared
validator compile.

## Run-76 D16 post-fix focused boundary — 2026-08-15

Result: cumulative D16 source wiring and focused controls are complete at unchanged base/HEAD
`ee559c4f75dfe36e2dd61c607d48a3aba4faa500`; mandatory verification is next.

- Added strict top-level/read-plan `execution_git_diff` parsing, Direct index/range threading, and
  one shared collection-to-request validator used by runtime completion and bridge consumption.
- Enforced declared path coverage, exact mode/range/operator identity, orphan and vacuous branches,
  canonical collection ordering, same-key byte equality, distinct-query coexistence, deterministic
  notification state, full literal ref resolution, and failed authoritative inventory.
- Self-review closed command-kind early-return and staged-plus-range broker gaps before broad gates.
- Focused passing files: D16 scope `10/10`, bridge utility `5/5`, store `18/18`, tools `49/49`, Pi
  harness `15/15`, execution tier `12/12`; inherited runtime `56/56`, router `80/80`, bridge
  `109/109`. Targeted Biome, canonical source TypeScript, and `git diff --check` pass.
- Claude zero-write mid-implementation review request is
  `672dbd2e-4809-4240-992f-85be24fd8b96`; exact-SHA review remains unfired and separately required.
- Utility remains `0/off/0`; no helper route, spend, commit, staging, lifecycle action, Harvto
  access, merge, rebase, push, deploy, provider/model/dependency change, evidence deletion, or root
  `.loop/` mutation occurred.

Next: run mandatory check/typecheck/build/serial suite, regenerate both passing evals, run Harness
gates and root verifier, prove explicit D16 scope, commit only listed implementation paths, then
obtain Claude exact-SHA `PASS` before one Harness close.

## Run-76 D16 mandatory verification — 2026-08-15

Result: every pre-commit D16 verification gate passes with utility fixed at `0/off/0`.

- `bun run check`: 893 files pass; canonical `tsc` and `bun run build` pass.
- Complete certified serial suite: all 79 test files pass, including the 354-test focused and
  inherited D16 boundary.
- Harness eval and repository eval both say `pass` with `baseline_failures: []`.
- `./harness preflight --json` and `./harness stop-gate --json` pass for exact task
  `harvto-d16-scope-audit-completeness`.
- Root `./scripts/verify.sh harvto-d16-scope-audit-completeness
  harvto-d16-scope-audit-completeness` exits 0 through lint, typecheck, build, complete tests, and
  empty baseline allowlist. No UI changed, so no UI capture is required.

Next: prove normal versus ignore-all-space scope, explicitly stage only the 13 authorized D16
source/test paths, commit once, request exact-SHA Claude zero-write review, and require literal
`PASS` before the one Harness close.

## Run-76 D16 completion — 2026-08-15

Result: D16 is complete. Implementation commit
`7c7acdea58c16a3c72a64443f052849ad9fecf3d` contains exactly the authorized 13 source/test paths.
Claude returned literal zero-write `PASS` for that SHA, all final gates passed at the reviewed
commit, and Harness closed exactly once with post-task invariants passing.

Lifecycle state: task `harvto-d16-scope-audit-completeness` is `done`, eval is `pass`,
`.harness/current-task` is absent, the Git index is empty, and root `.loop/` remains untracked with
60 files. No Harvto, merge, rebase, push, deploy, release, dependency, provider, or model mutation
occurred.

Next: commit only the inspected bookkeeping/evidence/lifecycle records as a separate commit. D15
and D6-D12 remain separate governed tasks and are not started here.

## Run-76 D15 promotion and contract — 2026-08-15

Result: D15 is the sole active Harness task at exact bookkeeping base
`fb71f47bb126a39eae7f1613fa952c994421de5e`; no source or regression edit has started.

The canonical contract requires identity-bound launcher/agent registrations, positive pre-liveness,
bounded TERM/KILL with identity revalidation, direct post-absence proof, preservation of every
unowned PID, and durable failed/unresolved state instead of false `stopped`. Exact-base red uses
only isolated fixture-owned child processes.

Next: add and preserve the named exact-base regression against unchanged production, then request
Claude zero-write plan review before the bounded implementation.

## Run-76 D15 exact-base red — 2026-08-15

Result: the named real-process regression fails decisively at unchanged production base
`fb71f47bb126a39eae7f1613fa952c994421de5e`. Direct probes found the registered launcher PID
43762, registered Claude PID 43763, and unowned control PID 43764 live before cleanup. Current
cleanup returned no killed PIDs and left all three alive; the required result is both owned PIDs
absent while the control remains live.

The fixture `finally` block reaped every fixture child, and a direct follow-up `ps` returned no
rows. Exact command, identity records, observations, and failure are preserved under the D15 run
artifacts. Production remains unchanged; the temporary diagnostic print was removed without
changing assertions. Utility remains `0/off/0` and root `.loop/` remains preserved.

Next: request Claude zero-write plan review, resolve findings, then implement the bounded D15
ownership, reaping, and lifecycle-ordering fix.

## Run-76 D15 fresh-loop handover — 2026-08-15

Governess ordered a fresh-loop handover in decision
`5e8f7154-6387-4cd1-b5d6-c499181dea2a` when Claude reached its preparation threshold. Finish only
this handover boundary; do not start D15 production implementation, a broad suite, a commit, an
exact-SHA review, or a Harness lifecycle action in run 76.

Current objective remains active Harness task `harvto-d15-teardown-process-orphans` at exact
HEAD/base `fb71f47bb126a39eae7f1613fa952c994421de5e`, with eval pending. D15 must ensure stopped or
completed is impossible until exact run-owned launcher, main-agent, bridge, app-server, and tmux
identities are directly absent; ambiguity or survival must retain durable cleanup evidence and end
failed without signaling unowned or preserved-live processes.

Exact changed scope at handover:

- Bookkeeping/planning: `PLAN.md`, `status.md`, `loop-fork/.harness/{parked-ideas.jsonl,tasks.json}`,
  `loop-fork/.harness/current-task`, `loop-fork/agents/coordination.jsonl`, and untracked canonical
  `loop-fork/{runs,specs}/harvto-d15-teardown-process-orphans/`.
- Regression only: `loop-fork/tests/loop/run-process-cleanup.test.ts` adds the named isolated
  real-process red. No production source changed.
- Preserved excluded state: root `.loop/` remains untracked with exactly 60 files; the Git index is
  empty.

Checks/results: the named regression at unchanged production exited 1 with all fixture PIDs live
before cleanup, owned launcher 43762 and Claude 43763 still live afterward, unowned control 43764
still live, and `killed=[]`; its `finally` block reaped all three and a direct follow-up `ps` found
none. Exact evidence is in
`loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/red/reproduction.md`.
`git diff --check` passes, Harness reports D15 active/pending, and no path is staged.

Claude plan review request `b6ac6287-e543-49c7-bb11-5b94d579d006` was delivered after a body-free
terminal nudge and began, but no findings or verdict arrived before the Governess handover order.
Treat the plan as unreviewed. The main risk is cross-cutting teardown ordering: cleanup must prove
process absence and exact tmux death before lifecycle success while retaining retry evidence for
any unknown branch. Utility remains hard-disabled at `0/off/0`; no helper, spend, Harvto, remote,
dependency, provider/model, release, deployment, merge, rebase, push, evidence deletion, or root
`.loop/` mutation occurred.

Next bounded action in the fresh loop: verify the new charter and inherited state, pull any durable
Claude response to the pending D15 plan review, resolve its findings in the canonical plan, then
implement only the reviewed registry/registration/reaping/Governess boundary. Preserve the exact
red assertion and do not reuse run 76 for another broad slice.

### Late D15 plan-review verdict received after handover preparation

Claude returned `REVISE` in decision `4a26400d-72a9-458f-8bf1-964b1dcca385`. No production work
may begin from the current plan. The fresh-loop successor must first amend canonical
`spec.md`/`plan.md`/`verify.md` for these findings and re-request plan review:

- **F1 blocking:** bare `kill(pid, 0)` and `ps -p` both report an exited-but-unreaped zombie as
  present. Define settled absence as PID absent **or** exact `ps stat` state `Z`/defunct. Make the
  real-process regression await child `exit` deterministically before its post-cleanup assertion,
  and add an unreaped-parent control proving a zombie is reaped rather than unresolved.
- **F2 blocking:** cleanup can target its own launcher process. Walk exact PPIDs and never signal
  `process.pid` or an ancestor; persist `unresolved:self-or-ancestor` for an external reaper. Add a
  named no-self/no-ancestor signal control.
- **F3 high:** register only a main-agent `SessionStart`, never a `native-child` SessionStart. State
  that adding `exec` changes the process shape of every configured hook invocation, and add a
  native-child-no-record control.
- **M1-M3:** document the deliberate one-second `lstart` identity bound; probe the exact
  manifest-recorded tmux socket/session rather than a default socket; keep all enumeration confined
  to the fixture's own registry and never inspect or signal preserved live runs.

Claude accepted the registry shape, malformed-record fail-closed behavior, non-vacuous exact
`killed` assertion, lifecycle reordering direction, and focused gate list. The existing red need not
be recaptured; only its post-cleanup zombie/reaping instrument must be corrected before the fix.

## Run-76 D15 implementation handover — 2026-08-15

Result: the current atomic D15 implementation slice is coherent and preserved uncommitted at
HEAD/base `fb71f47bb126a39eae7f1613fa952c994421de5e`. Governess handover epoch
`1786849270478176` has been active since `2026-08-16T04:32:42.356Z`; run 76 stops here without a
commit or Harness lifecycle action.

Claude issued literal `PLAN PASS` in decision `92de3425-0e1c-42e6-a89d-bda26e7bb578` for canonical
hashes spec `9233cb254643fa5029c822808bcefb3c2df3e6136311258ccbcb4ab497c43c53`, plan
`5cbd5dd1870c61a859d09632a774a80aee1195911f7982f3cbc474bf8142326d`, and verify
`27b85e35e64cd066cea93a204f2dd24039bc322b4ea56227cd08e9adf3cb463b`. That verdict approves the
design only; the current code has not received implementation or exact-SHA review.

Current source/test scope is `loop-fork/src/loop/{governess,hooks/emit,hooks/settings,
run-process-cleanup,run-state,tmux}.ts` and
`loop-fork/tests/loop/{governess-exit,run-process-cleanup}.test.ts`. The slice adds exact
launcher/main-agent records, failure evidence, zombie-aware settlement and abandoned-run checks,
self/ancestor protection with deferred exact-self-launcher transfer, bounded identity-revalidated
TERM/KILL, SessionStart registration with native-child exclusion, tmux socket identity persistence,
and Governess cleanup/tmux proof before stopped.

Proportional checks pass: targeted Biome and Ultracite report all 8 files clean; canonical source
TypeScript exits 0; cleanup `17/17`, Governess exit `30/30`, Governess hooks `33/33`, tmux `103/103`,
and run-state `22/22` pass, for 205 focused tests and zero failures. `git diff --check` passes, the
index is empty, and root `.loop/` remains untracked with 60 files.

Incomplete gates remain intentional for the successor: the five mandatory named controls in
`verify.md` have not all been added, the partial implementation is unreviewed, and no build, full
serial suite, eval regeneration, Harness preflight/stop-gate, root verifier, scope proof, commit,
exact-SHA Claude review, or Harness close has run for D15.

Next bounded action: read both validated epoch bundles, inspect this preserved diff, and add only the
missing named D15 controls and any defects they expose. Then run the mandatory gates, regenerate
passing evals, prove and commit explicit implementation scope, obtain Claude literal exact-SHA
`PASS`, and close Harness exactly once. Preserve utility `0/off/0`, the empty index, and root
`.loop/`; do not recapture the exact-base red.

## 2026-08-16 — D6 formatter gate contract amendment awaiting PLAN PASS

Result: implementation SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827` remains unchanged and
independently code-correct, but Claude exact-SHA decision `903ea1ff-acc3-4968-ba7d-70151b01bc04`
failed evidence integrity. D6 red fixture byte provenance was lost by post-freeze formatting; the
loss is recorded outside red, command/output remain untouched, and no red file will change again.
The two D15 close-lifecycle files are restored byte-for-byte to implementation HEAD.

Supervisor decision `d0d24bc6-82a7-4a59-905a-592d52524892` authorizes one narrow campaign gate
repair: a separate `biome.jsonc` commit excluding generated `runs/**` evidence only. The amended
contract forbids source/test/spec exclusions, existing-override changes, global rule disablement,
unrelated ignores, evidence formatting, and implementation amendment/rebase.

Amended hashes are spec `cf1a423c759e941a5debfd89729e2b9ae2c1a7d28b7e17504bfa694fa868bc10`,
plan `3b50f713040019dc7f5a3112268cbef6244a14635e73bb82320d938d40c2c6e7`, tasks
`0bf974e3769aad738e7f3e56ac3fe377ca4697ff836c444bacc0283ddf3f2f6b`, verify
`7bf5885c926d239a42ebe6a37b5291c731a4b275b8cf881fe7d12aca1b6325a0`, and run plan
`90f8e05bf837a2f577c7437e797ae09b8945d3ad01abb276f4a45d5449c69cab`.

Next: obtain Claude literal zero-write `PLAN PASS` for the amended hashes. Do not edit
`biome.jsonc`, rerun a fixer, close Harness, or alter implementation first.

## 2026-08-16 — Run-78 D6/formatter root-cause fresh-loop handover

Governess decision `f819db4c-ae07-4f87-b874-8f9c7163e5b6` orders preparation now; do not start the
next broad slice in this loop.

Urgent supervisor decision `9d4620f7-1b3f-470c-8d3b-c243706ca7b3` supersedes the prior instruction
to amend D6. D6's canonical contract is restored exactly under original PLAN PASS
`80e774db-4748-4281-a6a0-1c9e54b7ccfc`: spec `aaa58574…06dfaa`, plan
`67fd510c…e19b48d2`, tasks `0bf974e3…f3f2f6b`, verify `5b4532f5…669b29a9e`, run plan
`4b840882…f73a7baf`. Implementation SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827` remains the
unchanged, independently code-correct two-file candidate.

Current blocker: D6 exact-SHA decision `903ea1ff-acc3-4968-ba7d-70151b01bc04` is literal `FAIL` on
evidence integrity and inherited formatter scope, not code. D6 red fixture original bytes are
unrecoverable after post-freeze formatting; this is recorded outside red, while untouched
command/output files corroborate only decisive semantics. D15 pre/post-close artifacts are restored
byte-equal to HEAD at `66666865…9d7e` and `fb0b63c0…7e71`. With pristine D15 bytes,
`bun run check` fails exactly on those two inherited files.

Authorized remedy is a separate root-cause task, suggested id `harvto-formatter-evidence-scope`,
with its own spec/plan/tasks/verify, exact-base red, one-file `loop-fork/biome.jsonc` fix, controls,
commit, and Claude exact-SHA review. Scope is only a narrow exclusion for generated
`loop-fork/runs/**`; no existing override/rule change, source/test/spec/root-runs exclusion, evidence
rewrite, `bun run fix`, implementation amend/rebase, or unrelated ignore is allowed.

State at handover: HEAD `254e1749ca67ad1d81cd434ef01db0aeabae5827`; index empty; no dirty
`loop-fork/biome.jsonc`, source, test, or D15 evidence path; Harness sole-active D6/eval-pending; five
tracked bookkeeping paths dirty; 20 non-root-`.loop` untracked D6 paths plus two present/ignored D6
plans; root `.loop/` remains 60 untracked files; utility remains `0/off/0` with no helper or spend.

Next bounded action: in the fresh loop, verify the new charter and state, then attempt the separate
formatter task's Harness lifecycle without parking or closing D6. If Harness refuses concurrent
promotion, preserve exact output, build the complete separate run directory manually, and report the
deviation for supervisor ratification. Do not reproduce red or edit config before that boundary is
recorded.

## 2026-08-16 — Governess exit handover epoch 1786863160636037

Current atomic step is complete. Preserve HEAD `254e1749ca67ad1d81cd434ef01db0aeabae5827`, the
empty index, all uncommitted bookkeeping/run evidence, D6's sole-active Harness state, and untouched
`loop-fork/biome.jsonc`. Decision `8415f50f-adb0-4026-88de-ece616c1b060` is discharged; original
D6 `PLAN PASS` `80e774db-4748-4281-a6a0-1c9e54b7ccfc` remains valid.

Fresh-loop next action: verify the replacement charter and this preserved state, then attempt the
separate `harvto-formatter-evidence-scope` Harness lifecycle without parking or closing D6. If
Harness rejects concurrent promotion, record the exact blocking output and stop for supervisor
ratification. Only that task may authorize a one-file `loop-fork/biome.jsonc` exclusion for
generated `loop-fork/runs/**`; after its exact-SHA `PASS`, return to unchanged D6 SHA `254e1749…`
for same-SHA review. Do not edit anything under D6 `artifacts/red/`.

## 2026-08-16 — Run-79 Governess prepare boundary

Governess decision `6bc8b2a2-f244-48fb-8815-7853e83fe17c` orders a fresh-loop handover now and
forbids starting another broad slice. This loop stops after durable handover preparation; it does
not receive or process a later review result.

Current objective: preserve Claude's literal exact-SHA `PASS`
`fed87397-a1a1-4e36-a984-2775a643b648` for formatter production commit
`2e6adb8c3c2cf502ffea28c714685b2ea14b9822`, received under request
`8fde0b7b-36b6-4c75-ba30-b8b3f5424510` only after an explicit bridge prompt during handover. The
verdict is recorded but not processed in this loop. The successor may record the separately
ratified standalone terminal result and its bookkeeping without `harness done`. D6 same-SHA review
is a later, separate action and does not begin here.

Exact committed scope is two commits: plan-freeze commit
`13b02be9b1783bbc7d955ff05e4470cb733dee9b`, parent
`254e1749ca67ad1d81cd434ef01db0aeabae5827`, contains exactly the five reviewed formatter contract
files; production commit `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`, parent `13b02be9…`, contains
one insertion in exactly `loop-fork/biome.jsonc`. The preserved uncommitted scope is tracked
bookkeeping only (`PLAN.md`, `status.md`, `loop-fork/.harness/{parked-ideas.jsonl,tasks.json}`, and
`loop-fork/agents/coordination.jsonl`) plus untracked root `.loop/`, D6 run/spec evidence, formatter
run/eval/memory/meta/task-log evidence, and the two root run directories shown by `git status`.
The index is empty.

Checks/results: exact-base Biome red was 909 checked files, exit 1, exactly two pristine D15
generated-evidence errors, and zero fixes. The one-line config change produced 189 checked files,
zero additions, exactly 720 run-only removals with 720/720 byte matches, selected/rejected source
and test fixtures, inherited-exclusion controls, and zero fixture residue. `bun run check`, canonical
TypeScript, build, all 79 serial test files, and the root verifier pass; dual evals pass with empty
baseline failures. D6/D15 evidence inventories, frozen D6 hashes, sole-active D6 Harness identity,
utility `0/off/0`, and the 60-file untracked root `.loop/` remain preserved.

Handover boundary: literal exact-SHA `PASS` has been received, but Governess ordered this loop to
finish only handover preparation. Do not record a terminal formatter result in Run 79, run formatter
`harness done`, review or transition D6, broad-stage, rewrite evidence, or disturb the preserved
dirty state.

Fresh-loop next bounded action: verify the replacement charter/handover, exact verdict message
`fed87397-a1a1-4e36-a984-2775a643b648`, HEAD `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`,
empty index, exact dirty scope, D6/D15 inventories, Harness hashes/current task, utility `0/off/0`,
and root `.loop/`. Then capture D6 sole-active/eval-pending pre-state, record exactly one standalone
terminal `PASS` in formatter task-log, meta, and both evals, capture matching D6 post-state, and make
one separate bookkeeping commit. Formatter `harness done` remains prohibited. Stop with an empty
index before any later D6 same-SHA review.

## 2026-08-16 — Claude reviewer handover (run-79 Governess prepare, epoch after exact-SHA PASS)

Authored by the Claude reviewer session, appended without editing prior text.

**Correction to the preceding section.** It states the fresh-loop next action is to call
`receive_messages` for request `8fde0b7b-36b6-4c75-ba30-b8b3f5424510` and branch on `PASS`/`REVISE`.
That request is ANSWERED. Literal exact-SHA `PASS` `fed87397-a1a1-4e36-a984-2775a643b648` was
delivered for commit `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`. Do not re-request it and do not
treat the verdict as pending.

### Objective

Formatter root-cause task `harvto-formatter-evidence-scope` is code-complete and approved. Remaining
work is its standalone terminal transition and separate bookkeeping, then D6 same-SHA re-review.

### Exact changed scope (two commits, six paths total)

- `13b02be9b1783bbc7d955ff05e4470cb733dee9b` — contract freeze, exactly five reviewed files:
  `loop-fork/specs/harvto-formatter-evidence-scope/{spec,plan,tasks,verify}.md` and
  `loop-fork/runs/harvto-formatter-evidence-scope/plan.md`. Parent `254e1749…`.
- `2e6adb8c3c2cf502ffea28c714685b2ea14b9822` — production, exactly `loop-fork/biome.jsonc`, one
  inserted line `"files": { "includes": ["!runs"] },`. numstat `1 0` under both normal and
  `--ignore-all-space`. No source, test, evidence, contract, `PLAN.md`, `status.md`, or `.loop/` path.

### Design conclusion reached during plan review (four rounds)

Biome 2.4.9 LAYERS a child `files.includes` after `extends`; it does not merge a catch-all safely. A
local positive `"**"` re-includes preset-excluded paths and triggers `lint/suspicious/noBiomeFirstException`
(error under `ultracite/biome/core`). A trailing `/**` folder form triggers `useBiomeIgnoreFolder`
(also error). The only form that is both semantically correct and self-lint clean is the single
negative `["!runs"]` with no local positive glob and no copied preset entry. Three earlier candidate
forms were rejected on measured evidence, not on style.

### Blockers, risks, authority

- No open blocker.
- `harness done` is PROHIBITED for the formatter task; Harness never admitted it.
- `2e6adb8c` must not be amended or rebased.
- D6 stays sole active and eval-pending; its code at `254e1749…` must not be reworked.
- Supervisor authority `9d4620f7-1b3f-470c-8d3b-c243706ca7b3` plus ratification
  `9a23e772…` / `99311508…` (one decision, two deliveries); ordering confirmed by `d2f32b69…`.

### Next bounded action

Standalone terminal bookkeeping commit by Codex, then resubmit unchanged D6 SHA
`254e1749ca67ad1d81cd434ef01db0aeabae5827` for same-SHA review carrying prior `FAIL` `903ea1ff…`
and formatter `PASS` `fed87397…`. Full evidence detail is in the matching `status.md` section.

## 2026-08-16 — Governess handover epoch 1786902912181400

Urgent handover `0a2d81fe-29df-48c9-9689-0e969eb1bbbc` requires this agent to stop after writing the
epoch bundle. Preserve HEAD `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`, empty index, all dirty
bookkeeping/evidence, exact-SHA formatter `PASS` `fed87397-a1a1-4e36-a984-2775a643b648`, and D6
sole-active/eval-pending state. No commit, terminal transition, formatter `harness done`, D6 work,
push, merge, deploy, or discard is authorized in this loop.

Fresh-loop next action remains the standalone terminal procedure: verify the epoch bundle and
protected state; capture D6 pre-state; record exactly one formatter terminal `PASS` in task-log,
meta, and both evals; capture matching D6 post-state; make one separate bookkeeping commit; and stop
with an empty index before later resubmitting unchanged D6 SHA `254e1749…` for same-SHA review.

## 2026-08-16 — Claude reviewer exit, epoch `1786902912181400`

Reviewer atomic step complete: exact-SHA `PASS` `fed87397-a1a1-4e36-a984-2775a643b648` for
`2e6adb8c3c2cf502ffea28c714685b2ea14b9822`. HEAD and index unchanged at exit; nothing staged or
committed by the reviewer. Bundle at
`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/79/handoff/1786902912181400/claude.json`.
Next bounded action remains the standalone formatter terminal procedure and separate bookkeeping
commit, then D6 same-SHA review at unchanged `254e1749ca67ad1d81cd434ef01db0aeabae5827`.
`harness done` stays prohibited; do not amend or rebase `2e6adb8c`.

## 2026-08-16 — Run-82 Phase A formatter terminal, resumed epoch `1786902912181400`

Supervisor correction `a73e92c8-3691-4d16-93e8-460894398c5e` makes run 82 the executable
successor and authorizes the already-approved Phase A standalone formatter terminal procedure.

- Frozen terminal tuple: `PASS`,
  `fed87397-a1a1-4e36-a984-2775a643b648`,
  `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`,
  `2026-08-16T20:58:51Z`.
- Frozen JSON keys: `standalone_terminal_status`, `exact_sha_review_verdict_id`,
  `production_commit`, and `standalone_terminal_recorded_at`.
- Meta transitions are exactly `status: active -> done`,
  `lifecycle: standalone-ratified-exact-sha-pass-received-terminal-pending-handover-prepared ->
  standalone-ratified-exact-sha-pass-terminal-recorded`,
  `standalone_terminal_status: pending-fresh-loop -> PASS`, plus the timestamp key.
- Pre/post proof keeps D6 sole active/eval-pending, Harness hashes exact, HEAD
  `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`, index empty, utility `0/off/0`, root `.loop/`
  at 60 files and zero tracked, D6 inventory 17/17, and D15 inventory 22/22.
- Existing eval values are unchanged; task-log prefix is byte-identical. Frozen verdict ID and
  `standalone_terminal_status` each occur exactly once per authorized surface. Removed-file
  accounting remains 718/720 with only the already-authorized formatter `eval.json` and
  `meta.json` mismatches.

Next: stage exactly the four formatter terminal surfaces plus this `PLAN.md` and append-only
`status.md`; compare normal and ignore-all-space numstats, prove cached scope, create one
bookkeeping commit, re-hash both run-79 bundles, then request one zero-write same-SHA Claude review
of unchanged D6 `254e1749ca67ad1d81cd434ef01db0aeabae5827`. Formatter `harness done` remains
prohibited.

## 2026-08-16 — Run-82 D6 review handover boundary, epoch `1786902912181400`

Governess decision `6ecf831f-a49d-41f8-98d2-0869e581905f` orders fresh-loop preparation after
Claude reached its context threshold. Finish only the current review-request atomic step; do not
start D6 close, bookkeeping, D7, or another broad slice.

- Formatter terminal/bookkeeping is committed at
  `ef17eb08139a7300316a3564782c216e7f19cfaf`, parent exact production SHA
  `2e6adb8c3c2cf502ffea28c714685b2ea14b9822`, with exactly six authorized paths.
- One unchanged-D6 zero-write same-SHA review request was accepted as
  `d0fe2757-a111-4d49-8e24-5abb5b1bd3e8` for
  `254e1749ca67ad1d81cd434ef01db0aeabae5827`. No verdict arrived before preparation.
- Silence is not `PASS`. Never duplicate this request or close D6 without a literal Claude verdict
  naming the exact SHA.
- Current state remains HEAD `ef17eb08139a7300316a3564782c216e7f19cfaf`, empty index, D6 sole
  active/eval-pending, exact Harness hashes, utility `0/off/0`, 60 untracked root `.loop/` files,
  and byte-identical run-79 bundles.

Fresh-loop next action: validate the governed handover and preserved state, then continue the
existing review thread/request and consume literal `PASS` or `REVISE`. On `PASS`, capture D6
pre-close status/hashes and terminal counts, run exactly one D6 Harness close, prove one positive
transition, and create separate bookkeeping. On `REVISE`, stop without code rework, retry, or hand
repair.

## 2026-08-16 — Run-82 D6 REVISE handover, epoch `1786902912181400`

Claude decision `3ef105fc-210f-4b56-8dcb-1903fc05406d` is literal `REVISE` for exact unchanged
D6 SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827`. It authorizes no close.

- Code is approved; no D6 code, contract, red evidence, implementation commit, or lifecycle rework
  is allowed.
- Formatter PASS and terminal bookkeeping discharged the inherited formatter/evidence-integrity
  gate. Reviewer independently reran `bun run check`: 189 files, no fixes, exit 0.
- Remaining gate is dual eval regeneration from real green mandatory runs. Local evidence corrects
  the review text: the loop-fork eval exists but is `pending`; root eval is `fail`; both carry the
  stale formatter baseline and Harness eval remains pending.
- Governess prepare decision `6ecf831f-a49d-41f8-98d2-0869e581905f` still blocks another broad
  slice in this loop. No mandatory suite, eval write, staging, commit, re-review, or close starts
  here.

Fresh-loop next action: revalidate HEAD `ef17eb08139a7300316a3564782c216e7f19cfaf`, empty index,
D6 sole-active/eval-pending state, protected inventories, root `.loop/`, bundles, and utility
`0/off/0`; run the complete mandatory D6 gates; regenerate both evals only from actual green
results; then ask supervisor/Governess whether materially changed evidence permits one follow-on
same-SHA review. Never infer PASS or close from the code-approved REVISE.

## 2026-08-16 — Supervisor ruling for D6 REVISE correction loop

Supervisor decision `4662cdff-a52a-47ef-86fc-97c3ca2e56b7` resolves the same-SHA sequencing
question. Exactly one follow-up review of unchanged D6
`254e1749ca67ad1d81cd434ef01db0aeabae5827` is authorized after, and only after:

1. a fresh real run of every specified D6 mandatory gate at current formatter-enabled HEAD;
2. both D6 eval surfaces exist and pass with `baseline_failures: []` and empty by-name allowlist;
3. bounded D6 eval/evidence/status updates are recorded with zero D6 code or frozen-red change.

This is the charter REVISE correction loop, not duplicate verdict shopping. Context prepare still
forbids running the broad gates here. Successor performs the rerun, writes only authorized
D6 eval/evidence/status surfaces, proves unchanged implementation SHA, then sends exactly one
follow-up review. D6 close remains prohibited until literal exact-SHA `PASS`.

## 2026-08-16 — Governess handover epoch `1786912909823827`

Human-requested graceful handover `3bfa1458-d26e-4a62-b68d-e3f5a40ecac9` stops run 82 after
the D6 REVISE correction-loop ruling is durably recorded. No mandatory rerun, eval regeneration,
follow-up review, D6 close, D7 work, staging, commit, push, merge, deploy, or discard begins here.

Codex bundle must publish at
`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/82/handoff/1786912909823827/codex.json`
with status `ready`, exact HEAD `ef17eb08139a7300316a3564782c216e7f19cfaf`, empty index,
complete dirty scope, checks, blockers, and the fresh-loop next action.

Successor action remains exact: validate the bundle and preserved state; run every D6 mandatory gate;
regenerate both evals from actual green results with empty baseline failures and by-name allowlist;
prove D6 code/contracts/red/Harness remain unchanged; then submit the one supervisor-authorized
follow-up review for unchanged SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827`. Only literal
`PASS` permits one close.

## 2026-08-17 — Run-83 D6 PASS and close complete; bookkeeping is the only current action

The run-83 correction and review atomic steps are complete. Request
`58b6ea69-ce58-4125-853f-2c048160cd93` received literal Claude exact-SHA `PASS`
`2bf89efd-4237-42f5-b3c3-a61bbf3df8c4` for unchanged D6
`254e1749ca67ad1d81cd434ef01db0aeabae5827`. The one authorized close then exited 0 at
`2026-08-17T04:57:50Z` and was not retried.

Positive close proof: among 62 task-index records, only D6 changed. It moved
`active/eval-pending` to `done/eval-pass` and gained `ended_at`; the other 61 records are
byte-equivalent. The two pre-existing active records `active-launch-interlock` and
`context-pressure-current-lineage` remain active unchanged. Post-close counts are 2 active, 58 done,
and 2 parked. There is no active D6 and no current-task marker; this does not assert that no active
task exists repository-wide.

Reviewed evidence remains frozen. The present-tense `Blocked inherited gate` prose in
`artifacts/green/verification.md` is historical and superseded by run-83 verification
`run83-d6-4e293d78-44d3-4451-b942-0b92fab3aa0c` and exact PASS
`2bf89efd-4237-42f5-b3c3-a61bbf3df8c4`; do not edit that reviewed file. The Harness task record's
pre-close pending eval was stale relative to the pass eval file and is now pass through normal
close refresh. The baseline checker covers allowlist predicates; the separate shape check covers
the required unit dimension. Untracked D6 files will be staged as whole-file additions, so their
normal/ignore-all-space numstat equality is not represented as meaningful whitespace proof.

Current authorized action is exactly one D6 bookkeeping commit. Explicitly stage these categories
only: the five reviewed contracts; D6 run plan, eval, task-log, memory, meta, parked-idea copy,
pre/post-task artifacts, debt and regression-harvest artifacts, and run-83 green evidence; root D6
eval; D6 promotion/terminal rows in parked ideas, task index, coordination, and debt register; the
completion spec; this `PLAN.md`; and append-only `status.md`. The frozen four-file red directory,
D6 source/test, formatter evidence, `.loop/`, and unrelated dirty state remain excluded. Expected
cached cardinality is 39 paths. Prove tracked normal/ignore-space numstats, classify untracked files
as additions, verify exact cached paths/hashes and `git diff --cached --check`, then commit once
without amendment. The commit message must name run 83, epoch `1786912909823827`, PASS
`2bf89efd-4237-42f5-b3c3-a61bbf3df8c4`, and the historical verification-section supersession.

After commit, verify empty index, exact committed scope, terminal D6 state, unchanged code/contracts/
red/evals/reviewed verification, bundle hashes, root `.loop/`, and utility `0/off/0`. Append exact
commit/check/risk/next-action proof and publish the governed handover. Do not promote or start D7 in
this run.
