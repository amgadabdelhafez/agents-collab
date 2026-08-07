# PLAN — Claude kickoff submit guard

Spec bundle: `specs/claude-kickoff-submit-guard/{spec,plan,tasks,verify}.md`
Branch: `codex/claude-kickoff-submit-guard`.
Base commit: `defdf74949e34fe69b0f8e8601bba0afa152585f` — the deployed integration
lineage. **Not** `origin/main`, which does not contain this tip.
Package under change: `loop-fork/`, plus the root `specs/` bundle.

Supersedes the previous plan for `oss-agent-seat`, which shipped on
`codex/glm-full-agent`.

## Defect

Harvto run `147` reported a running paired loop while the launcher-owned Claude
kickoff sat unsubmitted in the composer as `[Pasted text #1 +5 lines]` behind a
Claude Code 2.1.223 `no MCP server configured with that name` startup error.
Supervisor recovered manually in run `148`.

Root cause, verbatim from `loop-fork/src/loop/tmux.ts` (`createPairedPaneLayout`):
`tmux load-buffer` then `tmux paste-buffer -d -p` then `tmux send-keys Enter`,
fire-and-forget, then return success. `runTmuxCommand` success means tmux
accepted the keystroke, never that a turn began. `unblockClaudePane` runs
*before* the paste and returns at `ready-empty`, so nothing after the paste ever
observes the kickoff.

## Verified environment facts (measured this session, not assumed)

- `<runDir>/transcript.jsonl` is **not** Claude's session transcript. Written by
  `appendRunTranscriptEntry` (`run-state.ts:1285`) from `paired-loop.ts:238` and
  `bridge-store.ts:632`; read as bridge traffic by `governess.ts:6936`. Codex,
  OSS, and bridge activity grow it without Claude taking a turn, so it cannot be
  kickoff evidence. Raised by Codex in review, then confirmed at those call
  sites. `bridge-runtime.ts:156 readClaudeTranscriptVersionFromProjects(runDir,
  projectsDir)` is the real convention and is reused.
- Preserved producer evidence, `/Users/amgad/.loop/runs/harvto-b1e274e66299`:
  run 147 `hooks/claude.jsonl` holds exactly one line, `SessionStart` at
  `2026-08-07T02:03:29.493Z`, and `transcript.jsonl` is 0 bytes; run 148 holds
  `SessionStart` `02:12:37.390Z` then `UserPromptSubmit` `02:14:14.585Z` with a
  38231-byte transcript. Run 147's `governess.jsonl` repeatedly verdicts
  `{"state":"working"}` for claude, so the stranded composer also fooled the
  Governess.
- Local Claude Code is `2.1.223 (Claude Code)` — the affected build.
- Measured healthy latency: `UserPromptSubmit` lands **0.651 s** after Enter
  (`SessionStart 2026-08-07T02:42:12.930Z`, `UserPromptSubmit
  2026-08-07T02:42:13.673Z`). Run 148's +97 s gap is human reaction time, not
  machine latency. Confirmation windows are derived from 0.651 s.
- An idle 2.1.223 composer is not blank: it renders `Try "how does <filepath>
  work?"`. This is why `unblockClaudePane` already carries a
  `"suggested-placeholder"` kind and a cursor probe.
- The test suite must be run with `TMUX` unset. `shouldAwaitAutoUpdate`
  (`src/cli.ts:79`) is `!process.env.TMUX && isPromptlessPairedTmuxLaunch(opts)`,
  so running the suite from inside a tmux pane makes three `tests/loop.test.ts`
  auto-update assertions fail for environmental reasons. `env -u TMUX -u
  TMUX_PANE bun run test:file -- tests/loop.test.ts` is 41 pass, 0 fail. There
  is no base test defect; the earlier reading of one was an instrument error.
- The typecheck gate is the narrow `tsc` inside `scripts/verify.sh`, over
  `src/cli.ts` plus `src/loop/caveman-skill.d.ts`. It **exits 0** with this
  change, and that green exit is the acceptance evidence.
- Diagnostic only, never a gate and never a substitute for one: raw
  `tsc --noEmit -p tsconfig.json` reports 216 errors on a clean checkout of
  `defdf749` and 216 with this change, 0 of them in
  `src/loop/{tmux,run-state,claude-kickoff}.ts`. That parity says this change
  added nothing to a pre-existing pile; it says nothing about acceptance.

## Decisions

1. **Evidence** — baseline-relative `UserPromptSubmit` in
   `<runDir>/hooks/claude.jsonl`, or strict `sequence` progression on
   `PreToolUse` / `PostToolUse`; never a bare `state: "working"`.
   `Notification` and `Stop` are **excluded**: `hooks/emit.ts::lifecycleState`
   maps both to `input-required`, so either can fire without proving this
   kickoff began. Secondary is Claude's own project transcript version, which
   never confirms alone — only alongside a composer that no longer holds the
   launcher-owned kickoff. All comparisons strict, so truncation or rotation
   reads as no progress.
2. **Provenance, not pattern** — a generic `[Pasted text #N +M lines]` marker
   identifies nobody. The composer is verified empty before the paste, the
   resulting body is captured between the launcher's own `paste-buffer` and its
   own first `Enter`, and recovery requires exact equality against that capture.
   No capture means no recovery. The composer classification and the evidence
   read that authorize the recovery `Enter` must come from **one snapshot**: a
   stale "owned" classification paired with a fresh "not started" evidence read
   would authorize an `Enter` into text a human had since typed.
3. **Version guard** — recovery is exempted only on an **exact** member of a
   producer-proven-healthy set, and that set ships **empty**. No `<=` range, and
   no member: the repository's only other Claude fixture,
   `tests/fixtures/claude-code/2.1.220/dev-channel-preconnect-warning`, records
   `captureSafety.promptSubmitted: false` and `promptSubmission: false` on every
   action, so it proves startup-modal handling and not a healthy kickoff.
   Listing 2.1.220 would have disabled the guard for a build on evidence that
   does not exist. Every version stays guarded until a real healthy-kickoff
   capture exists. Confirmation is unconditional.
4. **Ordering** — submission stays synchronous and unchanged for both panes;
   only the Claude confirmation is awaited afterwards, so a Claude confirmation
   never delays a Codex or OSS kickoff.
5. **Failure class** — `ClaudeKickoffUnconfirmedError` extends plain `Error`,
   deliberately not `ClaudeStartupInputRequiredError`, so it takes
   `terminalizeFailedStart` instead of the leave-it-up-for-a-human path.

Decisions 1-4 are corrections adopted from Codex's design review
(`6923d9c7-2aae-4a66-980f-5b46dff95b34`); each was independently verified before
adoption.

## Acceptance criteria

`specs/claude-kickoff-submit-guard/verify.md`, items 1-14.

## Verification approach

Focused module and launcher regressions driven entirely from the checked-in
producer fixture with `sleep` stubbed; the governed `scripts/verify.sh` with a
**required-empty** named baseline allowlist (`scripts/check-baseline-allowlist.py`
fails if any name remains, so nothing is tolerated); the **governed narrow
typecheck exiting 0**, which is the typecheck gate; `bun run build`; and an
isolated smoke whose zero-survivor check enumerates the exact PIDs its stubs
recorded and refuses to pass if none were recorded, with that non-vacuity guard
demonstrated firing on a positive control.

The typecheck gate is the green exit-0 narrow `tsc` run inside
`scripts/verify.sh` over `src/cli.ts` and `src/loop/caveman-skill.d.ts`. Nothing
else substitutes for it. The broad `tsc --noEmit -p tsconfig.json` error-count
comparison recorded above is a **supplementary diagnostic only** — it exists to
show this change introduced no new errors into a pre-existing pile, and an
error-count parity may never stand in for a green governed gate.
