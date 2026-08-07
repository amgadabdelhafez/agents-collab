# status — Provider-Neutral OSS Agent Seat

Session: loop runs `agents-collab-fa87e8608224/7` then `/8` (recovery successor),
branch `codex/glm-full-agent`,
base commit `0f69b9a99f9163bf9f83075530e26aed21258463`. Plan: `PLAN.md`.
Spec bundle: `specs/oss-agent-seat/{spec,plan,tasks,verify}.md`.

## State

Run 8 is the recovery successor after incident
`6b0c37a8-2ead-485c-a6b4-46e10c51c560`. The run-7 implementation is preserved and
audited, not restarted. The run-7 compiled eval escaped isolation and has been
rewritten; see "Run 8 — recovery" below, which supersedes the run-7 eval claims.

## What was done

**Identity split.** `loop-fork/src/loop/types.ts` now declares
`Agent = "claude" | "codex" | "oss"`, `RetiredAgent = "gemini" | "cursor" | "copilot"`,
and `HistoricalAgent`. `agents.ts` exports `AGENTS`, `RETIRED_AGENTS`, `isAgent`,
`isRetiredAgent`, `isHistoricalAgent`, and three migration-message helpers.
Narrowing `Agent` made every retired branch a compile error, which is how the
retired seats were found rather than hunted by grep.

**CLI surface.** `--oss-only`, `--oss-model`, `--oss-reviewer-model` (spaced and
`=` forms), `LOOP_OSS_MODEL`, `DEFAULT_OSS_MODEL = "openrouter/z-ai/glm-5.2"`,
plus `LOOP_OSS_API_KEY_FILE` and `LOOP_OSS_RELEASE_AUTHORITY` in `HELP`. Retired
flags and retired values stay *recognised* so they fail closed with a message
naming `oss` instead of a generic "Unknown argument".

**OSS adapter** (`loop-fork/src/loop/oss-adapter.ts`, new). Run-scoped
`<runDir>/oss-config/opencode.json` (mode 0600) holding exactly one MCP server —
this run's bridge, source `oss` — plus an explicit `{edit, bash, webfetch}`
permission policy. `buildOssRunArgs` emits `opencode run --format json`.
`parseOssSessionId` extracts the session from either event shape.
`resolveOssCredentialEnv` reads a mode-0600 key file into the child environment
only. `resolveOssSessionId` recovers a pane session by title on resume.

**Seat wiring.** `runner.ts` (buildCommand, resolveModel, `legacyAgentEnv`,
session capture), `tmux.ts` (`buildOssCommand`, pane env, manifest write),
`paired-options.ts` (config generation, resume lookup, retired fail-closed),
`run-state.ts` (`ossSessionId`, `HistoricalAgent` parsing), `bridge.ts`,
`bridge-store.ts`, `bridge-utility.ts`, `governess*.ts`, `session-pressure.ts`,
`iteration.ts`, `cli.ts`, `install.ts`. Added `src/oss-loop.ts`; removed
`src/{gemini,cursor,copilot}-loop.ts`. Removed the now-unreachable
`injectProjectBridgeConfig`, which merged the bridge into the user's own
`.cursor/`, `.gemini/`, and `.github/copilot/` project files.

**Reviewer authority** (`loop-fork/src/loop/review-authority.ts`, new). `claude`
and `codex` hold release authority by default; `oss` is advisory unless
`LOOP_OSS_RELEASE_AUTHORITY=1`. `runReviewWith` reports `approved: true` only
when an authoritative reviewer passed, adds `advisoryReviewers` to
`ReviewResult`, and still lets an advisory FAIL block.

## Proof run

- Focused: 411 pass / 0 fail across 9 changed-surface test files.
- Full governed: `env -u TMUX scripts/verify.sh oss-agent-seat oss-agent-seat`
  exit 0 — lint, typecheck, build, 1560 tests over 69 files, 0 failures, empty
  named baseline allowlist. Log: `runs/oss-agent-seat/artifacts/verify.log`.
- **SUPERSEDED — AS RAISED IN RUN 7, DO NOT RELY ON.** Run 7 recorded a compiled
  eval of 47 checks against binary sha256
  `4f310f41235ca8a0acb1c1e8a3b8d0b71d89f33fe26b4a372dd775c1a0162e19`, plus a
  base-commit control (`48742c35f65...`) described as showing "retired flags that
  launch". Those eval executions are the incident: the script had no environment
  isolation, so the probes ran against the live run directory. The numbers are
  retained only as a record of what run 7 believed. Run 8 rewrote the eval and
  re-derived every figure; see "Run 8 — recovery".
- Mutation (binding ruling `06fa755e-e432-4239-bb9a-fe924a2989dc`): deleting
  `&& authoritativeReviewers.length > 0` from `review.ts` made exactly the two
  named authority regressions fail (`Expected: false / Received: true`).
  Recorded at `runs/oss-agent-seat/artifacts/mutation-authority-check-deleted.txt`.
  `review.ts` restored byte-identically (sha256
  `cc4ada95b037ff9124234c7b6dc80ba9fc4ce4fe862e4a13cf2fc1692818572a`).

## Environment facts measured this session

- `opencode` 1.4.3. `opencode run --session <unknown>` errors
  `Session not found: <id>`, so session ids cannot be pre-assigned.
- `OPENCODE_CONFIG=<file>` does **not** isolate; `OPENCODE_CONFIG_DIR=<dir>`
  does drop the operator's global config. Proved with a positive control (a fake
  global config holding an MCP server `user-noise`), not assumed.

## Pre-existing failures, by name

`tests/loop.test.ts` fails 3 tests **inside a tmux pane** on both base `0f69b9a`
and HEAD, identically by name:
`runCli defaults empty argv to paired interactive tmux mode`,
`runCli starts paired interactive tmux without resolving a task`,
`runCli awaits auto-update before handing off promptless paired tmux startup`.
Cause: `src/cli.ts:80` gates `shouldAwaitAutoUpdate` on `!process.env.TMUX`.
All three pass with `TMUX` unset. Not introduced here; the baseline allowlist
stays empty because the governed run unsets `TMUX`.

## Risks and open questions

1. A repository-level `opencode.json` can still contribute MCP entries to the
   OSS seat. The spec's requirement (no unrelated *user* config) is met; project
   config is out of scope and recorded as a limit.
2. First-launch tmux OSS session ids are recovered on the next resume by title.
   `parseOssSessionListing` was proved against fixtures; the live listing shape
   was only observed empty. A failed lookup starts a fresh session rather than
   blocking launch — deliberate, and worth a reviewer's eye.
3. Bridge messages targeting a retired identity now fail to parse. Manifests
   stay readable (that is what the spec protects); the bridge is a delivery
   queue where an undeliverable target should fail closed.
4. `--oss-only` sets `review = oss`, so an OSS-only run never opens the release
   gate without `LOOP_OSS_RELEASE_AUTHORITY=1`. Intended: the first OSS reviewer
   run is experimental with a native gate-holder.

## Next actions

Superseded by "Run 8 — recovery / Next actions" below.

## Note on the "team of agents with worktree isolation" instruction

Not done, and deliberately so. This run's governing delegation policy disables
proactive provider-native subagent fleets: Direct, Nanny, and Au Pair are the
worker tiers, and a native profile may only be spawned after a settled helper
route fails and the Governess grants a read-only fallback lease. Bounded work
was routed through `route_task` instead — the `review-authority.ts` module came
back as an Au Pair patch, reviewed, and applied through the guarded
`apply_task_patch`. If a real agent fleet is wanted here, that needs an explicit
policy change rather than a bypass.

---

# Run 8 — recovery successor

Recovery after incident `6b0c37a8-2ead-485c-a6b4-46e10c51c560`. Run-7 source
changes preserved and audited; implementation was **not** restarted.

## What the incident was

`evals/smoke/oss-agent-seat.sh` invoked the real compiled launcher with real
launch argv and no environment isolation:

    bounded "${SMOKE_LOOP_BINARY}" "${selector}" "${retired}" --proof x

Run identity comes from `resolveStorageRoot(process.env.HOME)` →
`$HOME/.loop/runs` (`loop-fork/src/loop/run-state.ts:680`) and from
`resolveRepoId(cwd)` (`run-state.ts:699`). With neither overridden, every probe
resolved the **live** run directory. A probe that failed to fail-closed launched
for real: it wrote the manifest, spawned panes and placeholder processes, and
reconciliation killed the Codex proxy. The old `bounded()` used
`perl -e 'alarm shift; exec @ARGV'`, which signals only the direct child, so
detached grandchildren survived. The harness's safety depended on the exact
property under test — a fail-open test.

## The rewritten eval

`evals/smoke/oss-agent-seat.sh` is now safe independently of the code under test:

- unique temp `$HOME` (run storage cannot resolve to the real root) and a unique
  temp git repo as cwd (unique repo id, so any escape is detectable by name);
- `env -i` for every probe — inherited `TMUX`, `LOOP_*`, and credentials dropped;
- `PATH` shadowed by non-network stubs for claude/codex/opencode/gemini/cursor/
  copilot/tmux/ssh/curl/wget/nc; only `git` is real;
- `bounded()` rewritten with `use POSIX qw(setsid)` — each probe is its own
  session, a timeout kills the whole **process group**, then an unconditional
  `kill(KILL, -pgid)` reaps grandchildren;
- hard probe cap, trap-based teardown on EXIT/INT/TERM;
- **instrument check before any launch-shaped probe**: one real launch must be
  observed resolving run storage into the sandbox, else abort exit 2 with nothing
  further run. Absence of evidence returns nonzero;
- **producer-backed survivor proof** in teardown, 4 checks: no member left in any
  recorded probe process group; every stub pid the stubs recorded about
  themselves is dead; `pgrep -f <marker>` empty; the real storage root gained no
  directory for this smoke's repo id.

Two silent fail-opens were found and fixed in the rewrite itself: a shell-variable
probe counter that incremented inside `$(...)` subshells so the cap never fired
(observed "2 probe(s)" after ~35 probes), and a `mktemp` path with a doubled
slash that broke every path comparison against the launcher's normalised argv.

## Blocker found in peer review, and the fix

Codex reviewed the first rewrite and found a concrete escape that PATH stubs
cannot close. I verified both claims against source before accepting them:

1. `loop-fork/src/loop/update.ts:132-138` reaches the GitHub release API through
   runtime `fetch()`. `env -i` and PATH stubs only shadow spawned binaries, so
   the harness's "non-network" property was **false as originally claimed**.
2. Worse: `update.ts:157-163` `applyBinary` renames a staged binary over
   `process.execPath`, and `cli.ts:413` calls `applyStagedUpdateOnStartup()`
   before argument parsing. `process.execPath` was the real binary, outside the
   sandbox — so the smoke could have overwritten the artifact under test.

Supporting evidence I already had and misread: an earlier discovery run created
`<sandbox>/home/.cache/loop/update/last-check.json`, which only `saveCheckTime()`
writes. The auto-update path had been running in the sandbox the whole time.

Codex also found three defects in the proof itself: teardown signalled every
historical pgid (a recycled pgid could belong to an unrelated process), `rm -rf`
status was ignored so a surviving sandbox could be reported as clean, and the
`pgrep -f` check was described as proving more than argv matching proves.

Fixes, all in `evals/smoke/oss-agent-seat.sh`, no product source change:

- **Sandboxed binary.** Probes run a copy at `${SMOKE_TMP}/under-test/loop`,
  sha256-verified equal to the requested artifact before any probe. `execPath`
  is inside the sandbox, so a staged update cannot reach the real binary.
- **Network stopped at source.** `shouldThrottle()` (`update.ts:84-92`) reads
  `$HOME/.cache/loop/update/last-check.json` and skips the check when it is under
  six hours old; `CACHE_DIR` derives from `homedir()`, which is the sandbox. The
  harness seeds that file with a 60-second-old sentinel.
- **The seed is fail-closed, not merely quiet.** The sentinel's sha256 is
  recorded and teardown asserts it is byte-identical. If the throttle stops
  working, `saveCheckTime()` rewrites it and the run reports an escape. Teardown
  also asserts no `loop-staged` binary exists.
- **pgid ownership re-validation.** `owned_members()` requires a group member's
  command line to reference the sandbox before teardown signals or counts it.
- **Checked removal.** `if ! rm -rf "${SMOKE_TMP}" || [ -e "${SMOKE_TMP}" ]` → exit 3.
- **Narrowed claim.** Check 2 now reads "no process carries marker ... in its
  argv", with an explicit note that `pgrep -f` does not prove absence of
  listeners or sessions.

## Proof re-derived in run 8 (nothing banked from run 7)

All results below are from the **fixed** harness. The first rewrite's smoke
results are superseded: they were obtained while the auto-update escape was open.

All results below were produced against the frozen harness
`evals/smoke/oss-agent-seat.sh` sha256
`de70cfc31a4e635375b6b5aea52e98c9780c663d9c5688947c5c8a4027c457a1`. Every log
now prints the harness's own sha256 as its first line, so a log cannot inherit
the credibility of a different harness version (Codex's evidence-binding point).

- **Failed-normalisation leak, raised by Codex and fixed.** `mktemp -d` created
  the sandbox before the minimal trap was armed, so a failure in the normalising
  `cd` would have left the raw directory behind. The trap is now armed on the
  line immediately after `mktemp`, and it removes `SMOKE_TMP_RAW` rather than
  `SMOKE_TMP` — a failed `cd` sets `SMOKE_TMP` to the empty string, so a trap
  reading only that would `rm -rf ""` and leak the very directory it exists to
  remove. Verified with a positive control that forces the `cd` to fail: exit 1,
  no sandbox left behind.
- **SIGPIPE teardown leak, found from evidence during the sweep.** A stray
  sandbox survived a run. Rather than assume it was the guard control's
  deliberately preserved evidence, I traced it: piping the smoke's stdout into a
  truncating consumer (`| head -2`) kills the script with SIGPIPE, whose default
  action skips the EXIT trap entirely. Both traps now list `HUP PIPE`, and
  teardown ignores PIPE internally so its own report lines cannot kill it
  part-way through cleanup. KNOWN LIMIT, stated rather than papered over: with
  stdout a closed pipe, teardown completes but its report lines fail to write and
  the survivor checks have been observed producing false positives in that state.
  The failure is conservative — exit 3, sandbox preserved — but a piped run's
  teardown output is not authoritative. Run it unpiped or redirect to a file.
- **Network guard positive control (instrument verified before use).** Seeding
  the sentinel seven hours old disables the throttle. The launcher then ran an
  update check and rewrote the sentinel, and the guard fired: exit 3,
  `SURVIVOR: auto-update throttle sentinel was rewritten`, evidence preserved.
  The guard is therefore non-vacuous. The preserved sandbox's
  `.cache/loop/update/last-check.json` contained a fresh `saveCheckTime()`
  timestamp, which is direct producer-backed proof that the launcher performed
  the update check once the throttle was disabled.
- **Containment control (hostile launcher).** A stand-in that reproduces the
  incident — writes `$HOME/.loop/runs/hostile-repo/1/manifest.json`, invokes an
  agent with a run-scoped config path, calls `tmux`, spawns a detached
  `( sleep 600 ) &`, then sleeps 300 — ran 12 probes (cap) with 24 stub
  invocations. Teardown: zero survivors on all six checks. Independent post-hoc:
  `pgrep -fl "sleep 600"` none, `pgrep -fl hostile-loop` none, no `hostile` entry
  under `~/.loop/runs`, both live tmux sessions intact.
- **Fail-closed branches tested.** `LOOP_SMOKE_MAX_PROBES=4` → exit 2 at probe 5.
  `LOOP_SMOKE_BINARY=/usr/bin/true` → exit 2, "Isolation is unproven, so
  launch-shaped probes are refused. Nothing further ran."
- **Head binary.** Exit 0, 34 probes, 0 failures, all six survivor checks clean,
  including `auto-update throttle sentinel intact; no update check ran`, against
  binary sha256 `bb2839af0cac35bb2db8ecb040a9214cd69577df1c16c3a19facb73b0ee7b9c7`.
- **Discrimination control.** Same eval against a binary built in run 8 from base
  commit `0f69b9a99f9163bf9f83075530e26aed21258463` (sha256
  `298b4cacc374dc4977e136ac693e02d541f63914bae63fc156cbe9353a9555fa`; run 7's
  `48742c35f65...` was not reused): exit 1, 46 failures, zero survivors. The eval
  discriminates and is not fail-open. **Correction to run 7's framing:** zero
  retired probes exited 0 under the base binary, so this control did *not*
  reproduce "retired flags that launch". Containment of a genuinely launching
  binary is evidenced by the hostile control, not by this one.
- **Artifact integrity across every run above:** `loop-fork/loop` sha256
  `bb2839af0cac...` before and after — unchanged. Run-8 manifest sha256
  `7252aacf4c805f38becf053f95a53e53fbba1e0ace0bacce42a18cc5971d04a0` unchanged;
  storage root entry count 16 → 16; both tmux sessions intact throughout.
- **Governed verification, run after the isolation proof, not before.** Codex
  held that the charter's chronology ("focused tests and governed verification
  only after isolation is proven") is a proof-ordering requirement independent of
  which files verify.sh covers. Accepted. `env -u TMUX scripts/verify.sh
  oss-agent-seat oss-agent-seat` was re-run *after* the harness was cleared at
  `de70cfc3...`: exit 0 — lint, typecheck, build, **1560 pass / 0 fail**,
  baseline allowlist empty. Harness sha256 identical before and after the run;
  binary `bb2839af0cac...` unchanged; no runtime debris in the tree.
- **Binding ruling `06fa755e-e432-4239-bb9a-fe924a2989dc`, re-derived.** Mutating
  `loop-fork/src/loop/review-authority.ts` `case "oss": return policy.ossReleaseAuthority;`
  → `return true;` (occupancy grants authority) fails 3 named tests:
  `an OSS reviewer APPROVE cannot open the release gate without a policy grant`,
  `an advisory OSS APPROVE does not open the gate even beside a native pass`,
  `release authority is a property of policy, never of seat occupancy`.
  The opposite mutation → `return false;` fails 2:
  `an OSS reviewer APPROVE opens the release gate only under an explicit grant`,
  `release authority is a property of policy, never of seat occupancy`.
  Restored; sha256 back to
  `e899ea82b94d2df03bcd2022d4cd6756183432ef48ce5868e21472042f7e0d4e`; baseline
  27 pass / 0 fail. The suite contains no literal `OSS-APPROVE` token — the
  approval token is the `REVIEW_PASS` constant. Codex reviewed this and holds
  that the semantic named regression satisfies the ruling; flagged for the
  supervisor rather than decided here. Known comment drift: the comment at
  `tests/loop/oss-agent-seat.test.ts:586` names `review.ts` while these two
  mutations target `review-authority.ts`; run 7's deletion artifact still matches
  the comment. Non-blocking, recorded.

## Defect found and fixed in run 8

`loop-fork/package.json` `bin` still declared `"cursor-loop": "./src/cursor-loop.ts"`
and `"gemini-loop": "./src/gemini-loop.ts"` — both source files are deleted — and
declared no `oss-loop`, although `loop-fork/src/oss-loop.ts` exists and
`install.ts:19` defines `OSS_ALIAS_NAME = "oss-loop"`. A global install would have
created two broken retired aliases and no `oss-loop`. Fixed: those two entries
removed, `"oss-loop": "./src/oss-loop.ts"` added. The compiled eval cannot catch
this class of defect because it certifies the binary, not the package manifest.

## Quarantine

`.cursor/mcp.json`, `.gemini/settings.json`, `.github/copilot/mcp.json` were
generated debris from the removed `injectProjectBridgeConfig`, each pointing at
run 7 with a retired identity. Moved out of the working tree; contents and
sha256 preserved in `runs/oss-agent-seat/artifacts/quarantine-manifest.txt`.
`/.loop/` added to `.gitignore` and left on disk because the live run writes
utility artifacts there. None of it is staged.

## Known limits of the survivor proof

Stated as limits rather than claimed away:

- The marker check matches processes whose **argv** carries a sandbox path.
  `pgrep -f` does not read the environment, so it does not by itself prove the
  absence of listeners or sessions. A survivor that both re-sessions itself and
  carries no sandbox path in argv would evade that specific check; the
  process-group check covers the detached-grandchild case, and the stubs shadow
  every spawner.
- `env -i` drops `PATH` entries such as `/opt/homebrew/bin`, so a spawn site
  depending on a tool present only there would behave differently in-sandbox than
  in production. Every spawn site was not audited.
- Teardown re-validates process-group ownership before signalling, but the
  check and the kill are separate operations. A group that exits between them
  and has its pgid immediately reused would be signalled on stale information.
  Closing that fully needs a pidfd-style anchor the shell does not have. Codex
  classified this as a residual race rather than a blocker; recorded, not fixed.
- The network guard depends on the launcher's own throttle contract
  (`CHECK_INTERVAL_MS`, `CHECK_FILE` under `homedir()`). If that contract changes,
  the sentinel assertion fails the run rather than silently going online — but it
  is a harness-side guard, not a product-level fail-closed switch. Whether the
  launcher should own an explicit "no auto-update" flag is an open product
  question raised with Codex and left to the supervisor.

## Peer review outcome

Codex reviewed across several rounds and found defects I had missed. In order:
the runtime `fetch()` auto-update escape and the `applyBinary` overwrite of
`process.execPath` (both confirmed by me at source before acceptance); blind
signalling of historical pgids; an unchecked `rm -rf` that could report a
surviving sandbox as clean; a `pgrep -f` overclaim; control logs that did not
bind to a harness SHA; and a residual pre-trap window after `mktemp`. All are
fixed or explicitly recorded as limits. Codex's final decision:

> CLEAR on exact harness SHA
> `de70cfc31a4e635375b6b5aea52e98c9780c663d9c5688947c5c8a4027c457a1`.

Clearance is void if the tree or harness changes, verification fails, or debris
appears.

## Next actions

1. Commit the branch — no merge, no push, no install, no deploy. (Done below.)
2. Request exact-SHA supervisor review through the durable bridge, then STOP.
3. Supervisor decisions still open: whether the launcher should own an explicit
   fail-closed "no auto-update" flag rather than the harness depending on the
   throttle contract, and whether the binding ruling's "OSS-APPROVE" wording
   requires a literal token (the suite uses the `REVIEW_PASS` constant).
