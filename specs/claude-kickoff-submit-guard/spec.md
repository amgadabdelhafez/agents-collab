# Spec: Claude kickoff submit guard

## Problem

Harvto run `147` launched a paired loop, reported a running loop in
`manifest.json`, and produced no Claude work at all. The launcher-owned kickoff
sat unsubmitted in the Claude composer as `[Pasted text #1 +5 lines]` while
Claude Code v2.1.223 displayed `no MCP server configured with that name`. The
bridge MCP server and every other pane were alive. The supervisor recovered only
by manually pressing Enter on the same charter in run `148`.

Preserved producer evidence, `/Users/amgad/.loop/runs/harvto-b1e274e66299`:

| Artifact | Run 147 (failed) | Run 148 (manual recovery) |
|---|---|---|
| `hooks/claude.jsonl` | 1 line: `SessionStart` at `2026-08-07T02:03:29.493Z` | `SessionStart` at `02:12:37.390Z`, then `UserPromptSubmit` at `02:14:14.585Z` |
| `transcript.jsonl` | 0 bytes | 38231 bytes |
| `manifest.json` | `claudeSessionId` set, run reported started | same |
| `governess.jsonl` | repeated `{"state":"working"}` verdicts for `claude` | normal progression |

The launcher believed it had succeeded, and the Governess independently
misread the stranded composer as `working`, so nothing escalated.

### Root cause

`createPairedPaneLayout` in `loop-fork/src/loop/tmux.ts` submits the kickoff
fire-and-forget:

```ts
runTmuxCommand(deps, ["tmux", "load-buffer", "-b", buffer, promptPath], ...);
runTmuxCommand(deps, ["tmux", "paste-buffer", "-d", "-p", "-b", buffer, "-t", pane], ...);
runTmuxCommand(deps, ["tmux", "send-keys", "-t", pane, "Enter"], ...);
```

`runTmuxCommand` success means tmux accepted the keystroke. It is not evidence
that Claude started a turn. `unblockClaudePane` runs *before* the paste and
returns as soon as the composer reaches `ready-empty`; the development-channel
MCP registration can still fail asynchronously after that point, and the
resulting error render swallows the Enter. Nothing after the paste ever checks
that a turn began, so `createPairedPaneLayout` returns success unconditionally.

### What this is *not*

This is deliberately distinct from two existing features:

- `specs/claude-pane-delivery-confirmation` confirms **runtime bridge messages**
  injected into an **already-running** Claude session. It never runs at pane
  spawn and does not observe the launcher-owned kickoff.
- `specs/paste-submit-readiness` orders paste ingestion **before** Enter. It says
  nothing about whether the Enter produced a turn.

This spec covers only the **initial launcher-owned kickoff at pane spawn**.

## Goal

The launcher either positively confirms the launcher-owned kickoff started a
Claude turn, performs exactly one safe direct-submit recovery and confirms that,
or fails visibly with a nonzero launch failure and cleans up. A manifest must
never report a successfully submitted running loop while the kickoff is stranded.

## Requirements

1. **Turn-start evidence, not keystroke success.** After the kickoff Enter, the
   launcher must confirm a Claude turn began from producer evidence:
   a **baseline-relative** `UserPromptSubmit` in `<runDir>/hooks/claude.jsonl`,
   or strict sequence progression on `PreToolUse` / `PostToolUse`. `tmux
   send-keys` exit status is never sufficient.

   The turn-progress event set is exactly the events
   `hooks/emit.ts::lifecycleState` maps to `working`. `Notification` and `Stop`
   are excluded: that function maps both to `input-required`, and either can
   fire without proving this kickoff began. A bare `state: "working"` field is
   never trusted on its own.

   A newer **Claude project session transcript** version, read through the
   existing `readClaudeTranscriptVersionFromProjects` convention, is secondary
   and **never confirms on its own**. Its version is `size:mtimeMs`, which also
   moves when session metadata grows asynchronously after `SessionStart`. It
   confirms only in conjunction with a composer that no longer holds the
   launcher-owned kickoff, matching the cleared-composer convention the runtime
   bridge delivery path already uses.

   `<runDir>/transcript.jsonl` must **not** be used. It is the loop run
   transcript written by `appendRunTranscriptEntry` from `paired-loop.ts` and
   `bridge-store.ts`, so Codex, OSS, and bridge activity grow it without Claude
   starting a turn. Treating its growth as confirmation would fail open.

   Hook parsing must be defensive: ignore blank and trailing partial lines,
   require strict sequence progression, and never read truncation or rotation
   as growth.
2. **Baseline before mutation.** The evidence baseline must be captured before
   the paste so a pre-existing hook line cannot be misread as confirmation.
3. **Bounded wait.** Confirmation polls on a bounded schedule and terminates.
   The bound must be derived from a measured healthy submit latency, not
   guessed, and the constants must be injectable so regressions can drive them.
4. **One safe recovery, gated on positively captured launcher provenance.**
   A generic `[Pasted text #N +M lines]` marker does **not** identify
   launcher-owned bytes: any paste renders that marker. Ownership must instead
   be established by construction:
   a. the composer is verified empty immediately **before** the launcher paste;
   b. immediately **after** the paste and **before** the first Enter, the
      launcher captures the exact resulting composer body as the expected
      launcher-owned state;
   c. recovery may send exactly one additional `Enter` only when the current
      composer body matches that captured expected state **exactly**, and a
      re-read of the evidence immediately before sending still shows no turn.
   If the post-paste ownership capture is missing or indeterminate, recovery is
   refused and the launch fails closed. The recovery never re-pastes the buffer
   and never runs twice.
5. **Duplicate prevention.** No path may submit the kickoff twice. If evidence
   shows the turn started at any point, no further keys are sent.
6. **Fail closed.** If confirmation still does not arrive, the launch fails with
   a distinct nonzero error naming the pane and the missing evidence. The
   existing failed-start cleanup must run, leaving zero survivors.
7. **Version/capability guard.** What actually triggers recovery is *runtime
   capability evidence*: a channel-dependent launch was requested, no turn
   evidence arrived, and the composer still holds the positively captured
   launcher-owned state. Version is a secondary, narrow gate: only versions
   with a checked-in **healthy producer fixture** are exempted from the
   recovery step, and only by **exact match**. A `<=` range is not permitted —
   one healthy 2.1.220 capture proves 2.1.220, not every lower version, and
   semver ordering is not capability evidence. Unknown and unparseable versions
   stay guarded. Confirmation is required on every version. The observed version
   is recorded in the run manifest for forensics, which requires a
   `RunManifest` field plus its round-trip coverage in `run-state.ts`.
8. **Claude only.** Codex, OSS, and other panes are unaffected, and adding the
   guard must not delay a peer pane's kickoff: both panes submit in the current
   order and timing, and only the Claude confirmation is awaited afterwards.
9. **Producer-backed regression.** Coverage must consume a checked-in,
   deterministically normalized fixture derived from real Claude Code producer
   output (run-147 hook stream and a captured v2.1.223 pane), not a synthetic
   hand-written approximation only.

## Scope

- `loop-fork/src/loop/tmux.ts` kickoff submission path and its test exports.
- One new module for the evidence, capability, and composer-classification logic.
- Checked-in producer fixture plus its normalizer.
- Named deterministic regressions and the governed verify script entry.
- No changes to routing, Governess policy, bridge runtime delivery, or any live
  run directory, repo identity, or port owned by run `148`.

## Non-goals

- Fixing Governess's `working` misread of a stranded composer (separate defect;
  this spec makes the launcher fail before Governess ever sees the run).
- Changing `--dangerously-load-development-channels` usage or the bridge MCP
  registration protocol.
