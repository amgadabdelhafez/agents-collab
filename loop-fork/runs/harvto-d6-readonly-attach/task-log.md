# Task harvto-d6-readonly-attach

Created: 2026-08-16T07:07:05Z
Mode: emergent
Description: D6 P2: reproduce and fix targeted recovery delivery being blocked by a stale read-only tmux viewer without unsafe pane injection.

## What I changed

- Promoted D6 exactly once after D15 closed and its separate bookkeeping commit
  `ee1e7736d876d4b387f13580ec25ddf1c606e873` existed with an empty index.
- Created the canonical D6 spec, plan, tasks, verification contract, and run plan before source or
  regression edits.
- Traced the owner to `src/loop/tmux.ts`: pane evidence records only
  `window_active_clients`, and `matchesClaudeSuggestionSnapshot` rejects every nonzero count even
  though tmux exposes exact `client_readonly` state.

## Why

A stale read-only viewer cannot edit pane input, but current code cannot distinguish it from a
writable client. The safe correction is exact-target client-mode evidence with fail-closed stability,
not removal of the concurrent-writer gate.

## Notes

- Exact base is `ee1e7736d876d4b387f13580ec25ddf1c606e873`.
- Utility remains positively disabled at `0/off/0`; no helper route or spend occurred.
- Root `.loop/` remains untracked with 60 preserved files.
- No source, test, red fixture, staging, commit, Harvto, remote, provider/model, dependency, release,
  or deployment mutation has occurred.

Next: obtain Claude literal zero-write `PLAN PASS` for the canonical contract and hashes before the
named exact-base regression is added.

## Plan review gate

- Frozen canonical hashes: spec
  `c8ab3f92b1e512424fcc982a9579ec24b3feb3b79f8d325ab8c3c9b2ea781f1f`, plan
  `d9ff5baaf20d836cf38f2a44dbd85226e0b25b31680f291566639a5b7fca9402`, tasks
  `7591a66b51e832057022ba78b0373da43a7d8ead40fb673be558d79e2d2342ff`, verify
  `657999c36454f3ab1d744b423d9ea2d3bb7a4391b865dae99c2c7d55d61f923e`, and run plan
  `6c89fec8cf4605c8c28a62df3a01904510b357a9ad8bddcf8fa744e6e8365c90`.
- Claude request `b09a991e-23fb-4366-a663-78cf986f95b9` is the sole pending Claude bridge item.
  Exact pane inspection found an old non-empty draft, so safe terminal notification cannot run and
  no literal plan verdict has arrived.
- Codex did not clear, submit, type into, or otherwise mutate the Claude pane. Supervisor escalation
  `9961797c-a5bf-4d0f-8461-9cea17dc9a5e` requests safe attention or a fresh governed reviewer.
- HEAD remains the exact base, the index is empty, source/test diff is empty, Harness remains solely
  active on D6, root `.loop/` remains 60 files, and utility remains `0/off/0`.

Blocked next action: safely resolve the stale Claude composer, then consume literal `PLAN PASS` or
`REVISE`. Do not duplicate the request or begin the red/source branch first.

## Plan review REVISE

- Claude decision `cf16415b-f17f-4f1f-90cc-6a1327e290f1` returned literal `REVISE` with zero writes,
  helpers, provider calls, or spend after independently matching base, hashes, Harness, utility,
  root `.loop/`, index, and zero source/test diff.
- B1 now binds the post-send changed-suggestion raw active-client check to the same read-only
  classifier and requires a named `candidate-changed` control.
- B2 now proves target-window membership by exact pane-listed identities intersected with
  session-bound per-client modes; count is only a fail-closed cross-check.
- B3 preserves the fixed-arity marker, requires separately delimited identity evidence and malformed
  arity controls, and defines synthetic-shim empty-set semantics without vacuous success.
- The contract now records that injected-output tests prove policy/query construction, not deployed
  tmux output; unsupported live output remains fail closed.

Next: freeze revised hashes and request a fresh zero-write plan verdict at the unchanged exact base.

## Plan PASS and exact-base red

- Claude decision `80e774db-4748-4281-a6a0-1c9e54b7ccfc` returned literal `PLAN PASS` with zero
  writes, helpers, provider calls, or spend after independently matching exact base, frozen revised
  hashes, two-file scope, empty source/test diff, and absence of prior red evidence.
- The named regression was then added as the only source/test delta and run once at exact base with
  the canonical command. It failed with exit `1`: expected `empty`, received `indeterminate` at the
  unchanged `snapshot.activeClients !== 0` gate, with no `sendKeys` call.
- The first run, fixture-owned pane/session/window identities, positively read-only client record,
  empty emitted-query list for the direct probe fixture, and zero-key observation are frozen under
  `artifacts/red/`. The command will not be rerun or the evidence recaptured.

Next: implement the frozen identity/mode classifier and controls only in `src/loop/tmux.ts` and
`tests/loop/tmux.test.ts`.

## Implementation and verification

- Implemented pane-bound client identity parsing in a separate record while preserving the fixed
  cursor marker arity, plus a session-bound per-client mode query and exact target-window
  intersection classifier.
- Bound the same stable read-only evidence key through the initial matcher, quiet boundary,
  acknowledged probe, draft restoration, and post-send changed-suggestion classifier.
- Added deterministic controls for exact query shape, malformed/duplicate/wrong-target parsing,
  query failure/timeout, explicit empty and synthetic evidence, writable/missing/mismatched modes,
  client identity/mode races, other-window isolation, and `candidate-changed` under read-only
  viewers.
- All mandatory gates, both eval schemas, Harness preflight/stop-gate, and the root verifier pass
  with no baseline failures. Repository formatting normalized generated JSON only; sorted semantic
  hashes stayed unchanged, and red command/output bytes were untouched.
- Implementation commit `254e1749ca67ad1d81cd434ef01db0aeabae5827` has parent exact base and exactly the two authorized
  source/test paths. The index and post-commit source/test diff are empty.

Next: obtain Claude zero-write literal exact-SHA `PASS`; do not close Harness first.

## Exact-SHA FAIL: evidence integrity

- Claude decision `903ea1ff-acc3-4968-ba7d-70151b01bc04` returned literal `FAIL` with zero writes,
  helpers, provider calls, or spend. It independently confirmed commit `254e1749…` is correct and
  must not change; the failure is solely evidence integrity and gate authority.
- `artifacts/red/fixture.json` was canonical-formatted around `2026-08-16T08:07Z`, after its recorded
  preservation time. Its original untracked bytes are unrecoverable. This provenance loss is now
  recorded outside the frozen red directory; untouched `command.txt` and `output.txt` corroborate
  the decisive red semantics and were never modified or recaptured.
- The two tracked D15 close-lifecycle JSON files were restored through reverse `apply_patch` hunks.
  Their worktree SHA-256 values exactly equal implementation HEAD, and their Git diff is empty.
- With those prior-task proofs restored, `bun run check` fails only on their inherited formatting.
  Claude independently established the same failure exists at exact D6 base `ee1e7736…` because
  generated run evidence is not excluded by `biome.jsonc`.
- The earlier formatter/root-verifier passes on the evidence-mutated tree are invalidated. Both
  evals are no longer passing, Harness remains active, and no close or bookkeeping commit is
  authorized.

Blocked next action: wait for the supervisor's scope decision on the repository-level generated
evidence formatter exclusion, then resubmit the unchanged implementation SHA honestly.

## Supervisor-authorized contract amendment

- Claude relayed supervisor decision `d0d24bc6-82a7-4a59-905a-592d52524892`, authorizing exactly
  one narrow `biome.jsonc` exclusion for generated `runs/**` evidence in its own commit. It forbids
  excluding source/tests/specs, changing existing overrides, global rule disablement, unrelated
  ignores, implementation amendment/rebase, and evidence rewriting.
- F1/F2 remediation remains complete: the D6 provenance loss is recorded outside red, nothing under
  red was edited again, and both D15 close-lifecycle files remain byte-equal to implementation HEAD.
- The canonical contract and mirrored run plan now record the amended boundary, separate commit,
  pristine-evidence gate, exact implementation SHA, and fresh zero-write plan requirement.
- Amended frozen hashes: spec `cf1a423c759e941a5debfd89729e2b9ae2c1a7d28b7e17504bfa694fa868bc10`,
  plan `3b50f713040019dc7f5a3112268cbef6244a14635e73bb82320d938d40c2c6e7`, unchanged tasks
  `0bf974e3769aad738e7f3e56ac3fe377ca4697ff836c444bacc0283ddf3f2f6b`, verify
  `7bf5885c926d239a42ebe6a37b5291c731a4b275b8cf881fe7d12aca1b6325a0`, and run plan
  `90f8e05bf837a2f577c7437e797ae09b8945d3ad01abb276f4a45d5449c69cab`.
- HEAD remains unchanged implementation SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827`; index,
  source/test diff, and `biome.jsonc` diff are empty.

Next: obtain Claude literal zero-write `PLAN PASS` for these amended hashes before touching
`biome.jsonc`.

## Superseding decision and fresh-loop handover

- Urgent decision `9d4620f7-1b3f-470c-8d3b-c243706ca7b3` supersedes
  `d0d24bc6-82a7-4a59-905a-592d52524892` on sequencing and contract scope. D6 must keep its original
  frozen contract and two-file boundary; the formatter repair is a separate bounded root-cause task
  with its own full lifecycle.
- The uncommitted D6 contract amendment was rolled back before any `biome.jsonc` edit. Exact original
  hashes are restored: spec `aaa58574…06dfaa`, plan `67fd510c…e19b48d2`, tasks
  `0bf974e3…f3f2f6b`, verify `5b4532f5…669b29a9e`, run plan `4b840882…f73a7baf`.
- Implementation SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827`, its exact two-file path set,
  source/test bytes, empty index, and empty `biome.jsonc` diff remain unchanged.
- The separate task is authorized to change only `loop-fork/biome.jsonc`, excluding generated
  `loop-fork/runs/**` evidence from formatter/lint scope. It may not touch existing overrides,
  source/tests/specs, rule severities, root `runs/`, or frozen evidence. Suggested id:
  `harvto-formatter-evidence-scope`.
- Its exact-base red is the supervisor-characterized formatter failure against committed D15
  pre-close bytes extracted outside the repository. Required controls include pristine evidence
  green, checked-file-count delta fully explained by `runs/**`, source/test fail-open protection, a
  temporary uncommitted source lint violation, and exact one-file commit scope.
- Harness still has D6 solely active and may refuse concurrent promotion. Do not park or close D6 to
  work around it. If promotion fails, preserve exact output, create a complete separate run directory
  manually, and flag the lifecycle deviation for supervisor ratification.
- Governess decision `f819db4c-ae07-4f87-b874-8f9c7163e5b6` orders a fresh-loop handover now. No
  formatter-task creation, red reproduction, config edit, test run, commit, or review begins in this
  loop.

Next bounded action in the fresh loop: verify the new launch charter and this state, then attempt the
separate formatter task's Harness lifecycle without mutating D6 active state. Stop and record the
exact constraint if Harness refuses promotion.

## 2026-08-16T21:19:20.273Z — Same-SHA REVISE: dual eval gate only

- Claude decision `3ef105fc-210f-4b56-8dcb-1903fc05406d` returned literal `REVISE` for exact
  unchanged D6 SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827`.
- Code review is approved on the merits. Prior B1-B3 findings are closed, fixture provenance loss is
  accepted as bounded and disclosed, and formatter PASS plus terminal bookkeeping discharges the
  inherited formatter/evidence-integrity gate. D6 code must not be reworked, amended, rebased,
  recommitted, or parked.
- Close remains prohibited because both D6 eval surfaces are not green. Local correction to one
  reviewer observation: `loop-fork/runs/harvto-d6-readonly-attach/eval.json` exists at SHA-256
  `d184de549ae07321b63bfc5b404b46d57076b2ecf510f31527045c113a51bc67`, but reads
  `pending` with the now-stale inherited formatter baseline. Root eval SHA-256
  `ee8b037e88c390a33f9857c82113b7dab5aa049db4f7bbe5b5c81c7953a95bea` reads `fail`;
  `scripts/check-baseline-allowlist.py` exits 1 on it.
- No eval was field-flipped. No gate, D6 close, staging, commit, helper route, or second review
  request ran after the verdict.
- Fresh-loop next action: rerun the complete authorized D6 mandatory gates with formatter exclusion
  active, regenerate both evals from actual green results with `baseline_failures: []` and empty
  by-name allowlist, record proof, then obtain supervisor/Governess ruling on whether materially new
  evidence permits one follow-on same-SHA review request. Never close on this `REVISE`.

## 2026-08-16T21:27:34.481Z — Supervisor authorizes conditional same-SHA follow-up

- Supervisor decision `4662cdff-a52a-47ef-86fc-97c3ca2e56b7` authorizes exactly one follow-up
  same-SHA review for `254e1749ca67ad1d81cd434ef01db0aeabae5827` only after the evidence set
  materially changes through a fresh real run of every specified mandatory gate.
- Before that review, both D6 eval surfaces must exist and pass with `baseline_failures: []` and
  empty by-name allowlist. This is the charter REVISE correction loop, not duplicate verdict
  shopping.
- D6 code and frozen red evidence remain immutable. This context-prepared run starts no broad rerun,
  eval write, staging, commit, review, or close.
- Successor writes only bounded D6 eval/evidence/status surfaces after actual green results, proves
  zero code change, then submits the one authorized follow-up review. Only literal exact-SHA
  `PASS` from that review can permit one D6 close.

## 2026-08-17 — Run 83 fresh D6 correction gates

- Verification identity `run83-d6-4e293d78-44d3-4451-b942-0b92fab3aa0c` was frozen at
  `2026-08-17T04:28:25Z` before the first execution write.
- Fresh direct gates passed in reviewed order: `bun run check` checked 189 files with no fixes;
  canonical TypeScript exited 0; build bundled 3051 modules; and all 79 certified serial test files
  passed. Every command's before/after Git status plus dirty-file content-hash inventory matched.
- Both existing eval schemas were regenerated from those real results without deleting keys. Both
  now pass with `baseline_failures: []`; the loop-fork required `unit` dimension also passes.
  Independent baseline checks passed on both eval files.
- Harness preflight and stop-gate passed for active D6 with eval pass. Root verifier then repeated
  lint, canonical TypeScript, build, all 79 serial test files, and the root baseline gate; it exited
  0. Raw outputs are the nine predeclared run-83 files under `artifacts/green/`.
- Post-gate integrity passed: HEAD remains `ef17eb08139a7300316a3564782c216e7f19cfaf`, index empty,
  D6 implementation commit and worktree source/test hashes exact, all five contracts and four red
  hashes exact, D15 and formatter inventories byte-identical, both Harness hashes exact, run-82
  bundles exact, root `.loop/` 60 files and zero tracked, and utility `0/off/0`.

Next: submit exactly one zero-write follow-up peer-verdict review for unchanged D6 SHA
`254e1749ca67ad1d81cd434ef01db0aeabae5827`, naming prior `REVISE`
`3ef105fc-210f-4b56-8dcb-1903fc05406d` and supervisor authorization
`4662cdff-a52a-47ef-86fc-97c3ca2e56b7`. Do not close D6 or start D7 before literal exact-SHA
`PASS`.

## 2026-08-17 — Run 83 exact-SHA PASS and single close

- Follow-up review request `58b6ea69-ce58-4125-853f-2c048160cd93` produced literal Claude
  `PASS` decision `2bf89efd-4237-42f5-b3c3-a61bbf3df8c4` for exact unchanged implementation SHA
  `254e1749ca67ad1d81cd434ef01db0aeabae5827`. No second request, code edit, or frozen-red edit ran.
- Immediately before close, Harness reported D6 current/meta-active/eval-pass. The task index had
  62 unique records: 3 active, 57 done, and 2 parked. Its D6 record carried the expected stale
  `eval_status: pending` while the authoritative eval file carried pass.
- Exactly one `./harness done harvto-d6-readonly-attach` ran. It exited 0 at
  `2026-08-17T04:57:50Z`; post-task state invariants passed, debt scan recorded one D6 LOC-growth
  indicator, and regression harvest truthfully skipped because the task log has no bug-fix marker.
- Positive transition proof found exactly one changed task record among all 62: D6 moved
  `active/pending` to `done/pass` and gained `ended_at`. All other 61 records are byte-equivalent.
  The two pre-existing active records, `active-launch-interlock` and
  `context-pressure-current-lineage`, remain active and unchanged. Counts are now 2 active, 58
  done, and 2 parked; no active D6 remains and `.harness/current-task` is absent.
- D6 meta changed only `status: active -> done` plus matching `ended_at`. Coordination gained one
  D6 `done` row. The completion spec, post-task artifacts, debt scan, task index, and debt register
  are the expected Harness close outputs. Eval hashes remain loop-fork
  `1a39c272dfe2f1a5698c26ceefdf4b1558c1c0b7c337de1f77835e6b780ea233` and root
  `3756b01bf2de35b95d304e38d25499dab5b70ffc348b104ac01b3739a1af6652`.
- Reviewer finding F1 is recorded without changing reviewed evidence: the `Blocked inherited gate`
  section in `artifacts/green/verification.md` is historical and superseded by the preceding fresh
  run-83 verification record plus the exact-SHA PASS above. Its present-tense wording is not
  current state.
- Source/test, five reviewed contracts, four frozen-red files, D15 and formatter inventories,
  run-82 bundles, root `.loop/`, HEAD, and empty index revalidated unchanged after close. Utility
  remains `0/off/0`. The baseline script covers verdict/allowlist constraints; the separate eval
  shape check covers the required `unit` dimension.

Next: create exactly one explicit D6 bookkeeping commit. Stage only D6-owned contracts, evals,
green and Harness lifecycle evidence, D6 Harness bookkeeping, `PLAN.md`, and append-only
`status.md`; exclude D6 source/test, frozen red, `.loop/`, formatter evidence, and unrelated work.
Do not start D7 before the commit is verified and a governed handover is published.
