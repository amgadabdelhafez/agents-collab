# status — Claude kickoff submit guard

Session: loop run `agents-collab-fa87e8608224/9`,
branch `codex/claude-kickoff-submit-guard`,
base commit `defdf74949e34fe69b0f8e8601bba0afa152585f`. Plan: `PLAN.md`.
Spec bundle: `specs/claude-kickoff-submit-guard/{spec,plan,tasks,verify}.md`.

Supersedes the `oss-agent-seat` handoff from runs 7 and 8, which shipped on
`codex/glm-full-agent`.

## State

Implementation complete and verified locally. Not committed yet; stopping at the
review gate. No merge, rebase, push to main, install, or deploy performed.

## What was done

**Root cause located and verified verbatim.** `createPairedPaneLayout` in
`loop-fork/src/loop/tmux.ts` submitted the launcher kickoff fire-and-forget:
`tmux load-buffer` → `tmux paste-buffer -d -p` → `tmux send-keys Enter`, then
returned success unconditionally. `unblockClaudePane` runs *before* the paste
and returns at `ready-empty`, so nothing observed the kickoff turn.

**Producer evidence captured.** Preserved run-147 (`SessionStart` only, 0-byte
transcript) and run-148 (`SessionStart` + `UserPromptSubmit`) hook streams, plus
three live captures from local Claude Code `2.1.223`: the
`no MCP server configured with that name` banner over a ready composer, the
stranded `❯ [Pasted text #1 +6 lines]` composer, and that composer with an
unrelated human draft appended. Checked in under
`loop-fork/tests/fixtures/claude-code/2.1.223/kickoff-channel-race/` with
`normalize.mjs` and a `fixture-index.json` whose per-file SHA-256 values are
recomputed and asserted by a test.

**New pure module** `loop-fork/src/loop/claude-kickoff.ts`:
`parseClaudeHookEvidence`, `kickoffTurnStarted`, `parseClaudeCliVersion`,
`compareClaudeCliVersion`, `formatClaudeCliVersion`, `resolveKickoffCapability`,
`readComposerBody`, `classifyKickoffComposer`. No I/O, so every regression
replays captured bytes.

**Launcher wiring** in `tmux.ts`: `submitLaunchBootstrap` stays synchronous and
preserves both panes' original submission order and timing, recording the
pre-paste evidence baseline and capturing the composer body between its own
paste and its own Enter. `confirmClaudeKickoff` then polls bounded, performs at
most one guarded direct-submit `Enter`, and otherwise throws
`ClaudeKickoffUnconfirmedError` (plain `Error`, so it terminalizes rather than
waiting for a human). `TmuxDeps` gained `claudeCliVersion`, `readTextFile`, and
`readClaudeTranscriptVersion`. `RunManifest` gained `claudeCliVersion`.

**Codex review incorporated.** Codex's design review
(`6923d9c7-2aae-4a66-980f-5b46dff95b34`) required five changes; all adopted after
independent verification, and the spec bundle was revised before implementation
continued. The most important: `<runDir>/transcript.jsonl` is the loop run
transcript, not Claude's — Codex, OSS, and bridge writes grow it, so using its
growth as confirmation would have failed open. Dropped entirely in favour of
`readClaudeTranscriptVersionFromProjects`.

## Second Codex review incorporated

Codex approved the revised design (`9e8310eb-6447-43d4-8cae-64efd5e31731`) with
one required correction and one conjunction rule, both adopted after independent
verification of the cited code:

- **Event set corrected.** `Notification` and `Stop` removed from the
  turn-progress set. Verified at `hooks/emit.ts::lifecycleState`: that function
  maps `UserPromptSubmit`, `PreToolUse`, and `PostToolUse` to `working`, and maps
  `Notification` and `Stop` to `input-required`, so either could fire without
  proving this kickoff began.
- **Transcript conjunction.** The Claude project transcript version no longer
  confirms alone. Its version is `size:mtimeMs`, which also moves when session
  metadata grows after `SessionStart`, so it now confirms only alongside a
  composer that no longer holds the launcher-owned kickoff. The composer is read
  on every confirmation poll for this reason.
- **Ownership chain made explicit.** The composer is now positively verified
  empty immediately before the paste; failing that check declines the ownership
  claim, which costs the recovery keystroke and nothing else.

## Proof and checks run

- `env -u TMUX -u TMUX_PANE scripts/verify.sh claude-kickoff-submit-guard claude-kickoff-submit-guard`
  → **exit 0**: lint, narrow typecheck, build, 1619 tests across 80 files with
  0 failures, and an empty named baseline allowlist.
- `bun run test:file -- tests/loop/claude-kickoff.test.ts` → 32 pass, 0 fail.
- `bun run test:file -- tests/loop/claude-kickoff-launch.test.ts` → 14 pass, 0 fail.
- `bun run test:file -- tests/loop/tmux.test.ts` → 103 pass, 0 fail.
- `bun run test:file -- tests/loop/run-state.test.ts` → 23 pass, 0 fail.
- `bun run test:file -- tests/loop/paired-loop.test.ts` → 21 pass, 0 fail.
- `bun run test:file -- tests/loop/launch-reservation.test.ts` → 11 pass, 0 fail.
- `scripts/smoke-claude-kickoff-guard.sh` → exit 0: launch exits 1, stderr proves
  it failed for the kickoff guard specifically, survivors 0, isolated run base.
- `bun run check` (ultracite, repo-wide) → 839 files, 0 errors.
- `bun run build` → OK.
- `normalize.mjs` reproduces all five checked-in fixture artifacts
  byte-identically from the raw captures, verified with `cmp`.
- `@biomejs/biome check` on all seven touched files → clean, no fixes applied.
- `tsc --noEmit`: 216 errors with the change, **216 on a clean base checkout**;
  0 in `src/loop/{tmux,run-state,claude-kickoff}.ts`; the 28 in
  `tests/loop/tmux.test.ts` measured at 28 on base too. Delta is zero, measured
  rather than assumed.
- Producer capture cleanup verified positively by re-enumerating `pgrep -f`
  after each kill: `ZERO SURVIVORS`, no fixture tmux sessions, no fixture
  buffers. Run 148's live session, run directory, and repo identity were never
  touched.
- `bun install` was needed for `bun run build`; `bun.lock` SHA-256 is
  byte-identical before and after (`31d0bdb8a54bae9fd4dc29d287013e2a1821041072839b9859c6c9362273c321`).

### Pre-existing flake in tests/loop/bridge.test.ts, established by measurement

Three governed verify runs failed before the green one, each on a **different**
test in `tests/loop/bridge.test.ts`, each at a ~5000 ms per-test timeout rather
than an assertion: `bridge queues cross-agent messages for every Claude/Codex to
OSS pair`, `bridge native fallback request is pending until Governess grants it`,
and `get_task_result delivers only its exact queued utility handover`.

I did not retry until green and call that proof. The decisive control was a
**time-matched base run**: with this branch stashed, the unmodified base commit
reproduced `bridge native fallback request is pending until Governess grants it`
at 5000.37 ms. The flake is pre-existing.

Mechanism: those tests spawn full `bun src/cli.ts __bridge-mcp` cold starts
against bun's fixed 5 s per-test deadline, and cold start on this machine
measures 57-3430 ms. Sampling ended at HEAD 14 runs / 3 failures and BASE 14 runs
/ 1 failure. Cold-start medians, n=15 each on a quiet machine: BASE 708 ms
(p90 2037, max 3135) against HEAD 827 ms (p90 2920, max 3430). The distributions
overlap heavily and the 119 ms median gap sits far below the minimum effect
detectable at that variance, so no regression is claimed and none is measurable.
Flagged for the reviewer rather than tuned away, because the timeout belongs to
an unrelated test file.

### Instrument note: run the suite with TMUX unset

Three `tests/loop.test.ts` auto-update assertions fail when the suite runs from
inside a tmux pane, because `shouldAwaitAutoUpdate` (`src/cli.ts:79`) is
`!process.env.TMUX && isPromptlessPairedTmuxLaunch(opts)`. With
`env -u TMUX -u TMUX_PANE` the same file is **41 pass, 0 fail**. There is no base
test defect; an earlier note in this file claimed one and was wrong. A full
per-file sweep of all 80 test files inside tmux showed those three as the only
failures anywhere, and they are environmental.

Raw `tsc --noEmit -p tsconfig.json` is not the repo's gate; `scripts/verify.sh`
runs a narrow `tsc` over `src/cli.ts` plus `src/loop/caveman-skill.d.ts`, which
exits 0. The broad form reports 216 errors on a clean base checkout and 216 with
this change, 0 of them in the touched source files.

## Open questions

- Sent to Codex and unanswered at time of writing: confirm the
  composer-provenance mechanism (capture between `paste-buffer` and `Enter`,
  exact equality, refuse-and-fail-closed when the capture is indeterminate), and
  whether the secondary Claude-project-transcript signal should stay in or the
  guard should be hook-progression-only. Proceeding with both signals.

## Risks

- The run-147 **strand** is a timing race and was **not** reproduced live. Two
  attempts (channel error present, launcher-identical paste + Enter, once with
  an 8 s settle and once with tight zero-settle polling) both submitted
  normally. The regression's deterministic basis is the preserved run-147 hook
  stream plus the real 2.1.223 composer captures. Recorded in
  `fixture-index.json` under `provenanceNotes` so the fixture is never later
  misread as a reproduction.
- Pane captures are width and theme dependent; matching is on stable substrings
  and terminal size is pinned in `fixture-index.json`.
- The Governess independently misread the stranded composer as `working` in run
  147. That is a separate defect, explicitly out of scope; this change makes the
  launcher fail before the Governess ever sees such a run.

## What should happen next

1. Finish the remaining verification: full per-file suite sweep with failures
   allowlisted by name against the measured base, `scripts/verify.sh
   claude-kickoff-submit-guard`, the isolated zero-survivor smoke, and the eval.
2. Commit on `codex/claude-kickoff-submit-guard` with explicit paths only.
3. Send the exact-SHA review request to the supervisor over xchan and stop.
   Do not merge, rebase, push main, install, or deploy.
