# Plan: Claude kickoff submit guard

Base commit: `defdf74949e34fe69b0f8e8601bba0afa152585f` (deployed integration
lineage; **not** `origin/main`, which does not contain this tip).
Branch: `codex/claude-kickoff-submit-guard`. Package under change: `loop-fork/`.

## Verified facts this plan rests on (measured, not assumed)

- Kickoff submission site, verbatim from `loop-fork/src/loop/tmux.ts`
  (`createPairedPaneLayout`, `pasteLaunchBootstrap` at line 2808):
  `tmux load-buffer` then `tmux paste-buffer -d -p` then `tmux send-keys Enter`,
  with no post-Enter check. `createPairedPaneLayout` returns immediately after.
- `unblockClaudePane` (line 2530) runs **before** the paste and returns on
  `input.kind === "ready-empty"`. It never observes the kickoff turn.
- `TmuxDeps` (line ~170) exposes `capturePane`, `capturePaneSnapshot`, `nowMs`,
  `sendKeys`, `sleep`, `spawn`, `log`, `env`, `cwd`. It has **no** file-reading
  member, so evidence reads need new injected deps.
- `createPairedPaneLayout` already receives `runDir`, so `<runDir>/hooks/claude.jsonl`
  is in scope without new plumbing.
- `<runDir>/transcript.jsonl` is **not** Claude's session transcript. It is
  written by `appendRunTranscriptEntry` (`run-state.ts:1285`) from
  `paired-loop.ts:238` and `bridge-store.ts:632`, and `governess.ts:6936` reads
  it as bridge traffic. Codex raised this in review and it is confirmed by those
  call sites, so transcript-growth confirmation was dropped: Codex, OSS, and
  bridge activity would grow it without Claude starting a turn.
  `bridge-runtime.ts:156 readClaudeTranscriptVersionFromProjects` is the
  existing convention for Claude's real project transcript and is reused instead.
- Measured healthy submit latency on this producer: `UserPromptSubmit` lands
  **0.651 s** after Enter (`SessionStart` `2026-08-07T02:42:12.930Z`,
  `UserPromptSubmit` `2026-08-07T02:42:13.673Z`, Claude Code 2.1.223, hooks
  wired exactly as `claude-hook-settings.json` does). Run 148's +97 s gap is a
  human pressing Enter, not machine latency. Timeouts below are derived from
  0.651 s, not guessed.
- Local Claude Code is `2.1.223 (Claude Code)` — the exact affected version, so
  a genuine producer capture is obtainable on this machine.
- Existing producer-fixture precedent:
  `loop-fork/tests/fixtures/claude-code/2.1.220/dev-channel-preconnect-warning/`
  with a `fixture-index.json` sidecar.

## Design

### New module `loop-fork/src/loop/claude-kickoff.ts`

Pure functions, no I/O, so every regression is deterministic:

- `parseClaudeHookEvidence(text)` → `{ hookSequence, sawUserPromptSubmit }`
  from a `hooks/claude.jsonl` body. Tolerates blank, trailing partial, and
  unparseable lines; `hookSequence` is the maximum observed `sequence`.
- `ClaudeKickoffEvidence = { hookSequence, sawUserPromptSubmit, transcriptVersion }`
  where `transcriptVersion` comes from
  `readClaudeTranscriptVersionFromProjects`, **not** `<runDir>/transcript.jsonl`.
- `kickoffTurnStarted(before, after)` → boolean. True when `after` gained a
  `UserPromptSubmit` the baseline did not have, or strictly advanced
  `hookSequence`, or has a different non-empty `transcriptVersion`. Strict
  comparisons only, so truncation or rotation can never read as growth.
- `parseClaudeCliVersion(raw)` → `{ major, minor, patch } | undefined`, parsing
  `2.1.223 (Claude Code)`.
- `resolveKickoffCapability(version, provenHealthy)` →
  `{ confirmRequired, recoveryAllowed }`, where `provenHealthy` is the **exact
  set** of versions carrying a checked-in healthy producer fixture:
  - `confirmRequired` is `true` for every input, including `undefined`.
  - `recoveryAllowed` is `false` only on an exact member of `provenHealthy`.
  - everything else, including unknown and unparseable, stays guarded.

  No `<=` range: one healthy 2.1.220 capture proves 2.1.220, not every lower
  version, and semver ordering is not capability evidence.
- `readComposerBody(paneText)` → the composer text after the `❯` marker, or
  `undefined` when no composer line is visible.
- `classifyKickoffComposer({ paneText, expectedComposerBody })` →
  `"empty" | "kickoff-owned" | "foreign" | "indeterminate"`. `"kickoff-owned"`
  requires an **exact** match against `expectedComposerBody`, the body the
  launcher itself captured after its own paste into a verified-empty composer.
  Only `"kickoff-owned"` permits recovery. An idle 2.1.223 composer renders a
  greyed `Try "…"` suggestion rather than a blank line (fixture
  `01-ready-with-channel-error.txt`), which classifies as `"empty"`.

### Integration in `loop-fork/src/loop/tmux.ts`

1. Add `TmuxDeps` members `readTextFile(path) => string | undefined`,
   `readClaudeTranscriptVersion(runDir) => string`, and
   `claudeCliVersion() => string | undefined`, with real implementations in
   `defaultDeps` (the transcript reader delegating to
   `readClaudeTranscriptVersionFromProjects`).
2. Add constants next to the existing `CLAUDE_PROMPT_*` block:
   `CLAUDE_KICKOFF_CONFIRM_MAX_POLLS`, `CLAUDE_KICKOFF_CONFIRM_POLL_DELAY_MS`,
   `CLAUDE_KICKOFF_RECOVERY_MAX_POLLS`, `CLAUDE_KICKOFF_PROVEN_HEALTHY_VERSIONS`.
   Confirm window `40 × 500 ms = 20 s`, recovery window `20 × 500 ms = 10 s`;
   both roughly 30x and 15x the measured 0.651 s healthy latency, and both
   injectable so regressions drive them without wall-clock waits.
3. Add `ClaudeKickoffUnconfirmedError` alongside the existing
   `ClaudeStartupReadinessTimeoutError` family, naming the pane, the observed
   CLI version, and the exact missing evidence.
4. Split submission from confirmation so peer startup timing is unchanged:
   - `submitLaunchBootstrap(pane, agent, promptPath)` stays synchronous and
     keeps today's `load-buffer` → `paste-buffer` → `send-keys Enter` order for
     both panes. For a Claude pane it additionally records the baseline evidence
     before `load-buffer`, and captures the post-paste composer body **between**
     `paste-buffer` and `send-keys Enter` as the launcher-owned expected state.
   - Both panes submit first, in the current order, then only Claude panes are
     awaited via `confirmClaudeKickoff(...)`.
5. `confirmClaudeKickoff` polls `kickoffTurnStarted`; on timeout, and only when
   `recoveryAllowed` and the captured expected composer body exists and the
   live composer matches it exactly and a fresh evidence read still shows no
   turn, sends exactly one `Enter` and polls again; otherwise, and on continued
   silence, throws `ClaudeKickoffUnconfirmedError`. Recovery is guarded by a
   single local boolean and never re-pastes.
6. The throw propagates through `createPairedPaneLayout` into
   `startPairedSession`'s existing failed-start cleanup
   (`terminalizeFailedStart` / `cleanupOwnedPersistentTransport`). It is not a
   `ClaudeStartupInputRequiredError`, so it takes the terminalizing path, and
   the success manifest update never runs because it happens only after
   `createPairedPaneLayout` returns.
7. Add `claudeCliVersion?: string` to `RunManifest` in `run-state.ts` with
   round-trip coverage, and record the observed version there.
8. Export the new symbols through the existing test-export block.

### Producer fixture

`loop-fork/tests/fixtures/claude-code/2.1.223/kickoff-channel-race/`:

- `run-147-hooks-claude.jsonl` — verbatim copy of the run-147 hook stream
  (`SessionStart` only) from `/Users/amgad/.loop/runs/harvto-b1e274e66299/147/hooks/claude.jsonl`.
- `run-148-hooks-claude.jsonl` — the manual-recovery comparison, truncated to the
  first `UserPromptSubmit` and normalized.
- `01-stranded-composer.txt` — pane capture from a real local Claude Code
  `2.1.223` started with an unresolvable development-channel server name, with
  the kickoff pasted and Enter pressed, captured with `tmux capture-pane -p`.
- `fixture-index.json` — provenance: producer version, capture command, source
  run paths, per-file SHA-256, and the normalization applied.

Normalization is a checked-in script so the fixture is reproducible and its
transform is reviewable rather than hand-edited.

## Risks

- The captured pane is width- and theme-dependent. Mitigated by pinning the
  capture terminal size in `fixture-index.json` and matching on stable substrings
  rather than exact layout.
- A slow but healthy machine could exceed the confirmation window and take the
  recovery path. Recovery is idempotent-safe (Enter into a kickoff-only composer)
  and the duplicate guard re-checks evidence immediately before sending, so the
  worst case is one harmless keystroke, not a double submission.
- Adding `await` to a previously synchronous helper changes the launch timing
  profile. Covered by keeping every existing launch regression green.

## Out of scope

- The Governess `working` misread of a stranded composer.
- Bridge runtime delivery confirmation (already covered by
  `specs/claude-pane-delivery-confirmation`).
