# Bridge Turn-Idle Freshness

## Problem

`isClaudeTurnActive` (src/loop/bridge-runtime.ts, added by the bridge
single-delivery fix) decides turn state from the *last* Claude hook journal
entry alone, ignoring its age. Two confirmed live defects follow:

1. **Mid-turn error reads as idle (medium).** `lifecycleState` in
   `src/loop/hooks/emit.ts` maps any error-flagged payload to state `"failed"`
   *before* the event-name mapping, so an errored `PostToolUse` mid-turn
   journals as `{event:"PostToolUse", state:"failed"}`. `isClaudeTurnActive`
   only treats `starting`/`working` as active, so the bridge worker can inject
   into an active turn during the window until the next hook event (live run
   31 shows real windows up to ~9s).
2. **Resume wedge (high).** A resumed paired run relaunches claude with
   `--resume` and no prompt (`tmux.ts` `leftPrompt` is `undefined` when
   `hadAgentSession`), so the journal tail stays `SessionStart`/state
   `"starting"` while Claude idles at an empty composer. `isClaudeTurnActive`
   returns `true` forever and all automatic Codex→Claude delivery is blocked —
   an idle Claude never runs a turn, so there is no `receive_messages`
   fallback either. This regresses the documented `--run-id` resume flow.
   A stale `"working"` tail (Claude crashed or a Stop hook was lost) wedges
   the same way.

## Required behavior

1. A recent `"failed"` journal tail counts as turn-active so an errored tool
   call mid-turn does not open an injection window.
2. `"failed"` turn-activity has a freshness bound: a terminally-failed session
   stops blocking delivery once the tail ages past the bound.
3. `"starting"` has a short staleness bound: a resumed session idling at an
   empty composer unblocks automatic delivery shortly after `SessionStart`.
4. `"working"` has a staleness bound generous enough to cover real intra-turn
   hook silences (tool gaps ~9s observed; final-response writing can run
   minutes) so mid-turn injection is not reintroduced, while a dead session
   eventually unblocks.
5. The legacy no-`state` event fallback (SessionStart/UserPromptSubmit/
   PreToolUse/PostToolUse) honors the same bounds by event kind.
6. A journal tail without a parseable `ts` keeps today's behavior (treated as
   fresh) — `runHookEmit` always stamps `ts`, so this only affects
   hand-written or truncated lines, and blocking is the safer default there.

## Safety invariants

- Delivery never injects into a pane whose journal tail shows fresh turn
  activity (`starting`, `working`, or `failed` within bound).
- Pane-readiness checks (`isClaudePaneReady`, submission confirmation) remain
  in force after the turn-activity gate passes; staleness never bypasses them.
- Time comparisons come through an injectable clock in
  `bridgeRuntimeCommandDeps` so tests stay deterministic (repo rule: prefer
  module-level mocks over DI-only seams).

## Compatibility

- No change to the hook journal format or `hooks/emit.ts` emission.
- `isClaudeTurnActive(runDir)` callers need no changes; the clock defaults to
  wall time.
- Existing regression fixtures for fresh `"working"` tails keep passing (they
  pin the mock clock near the fixture `ts`).

## Acceptance criteria

- [x] Fresh `failed` tail blocks delivery (no send-keys), message stays pending.
- [x] Stale `failed` tail (past bound) allows delivery to an idle pane.
- [x] Fresh `starting` tail blocks delivery.
- [x] Stale `starting` tail (resume wedge) allows delivery to an idle pane.
- [x] Stale `working` tail allows delivery; fresh `working` still blocks.
- [x] `bun test tests/loop/bridge.test.ts` passes; full `bun test` shows only
  the 4 known Codex-launch baseline failures; `bun run check` is clean.

## Non-goals

- Changing `lifecycleState` mapping in `hooks/emit.ts` (the `failed` tag is
  useful signal; the consumer is what mis-read it).
- A positive idle signal from the Claude TUI (spinner parsing etc.).
- Codex/Gemini/Cursor pane-readiness behavior.
