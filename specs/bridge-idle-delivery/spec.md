# Bridge idle-time delivery

## Problem

Loop 48's Codex verdict message stayed pending indefinitely. Two defects in the
single-owner delivery fix compound at idle time:

1. Claude Code renders a grayed-out type-ahead suggestion in the idle composer.
   `tmux capture-pane -p` strips styling, so `claudeComposerText` cannot tell
   the suggestion from a real human draft; `isClaudePaneReady` never returns
   true and automatic delivery is blocked for as long as a suggestion is shown.
   Before single-owner delivery this did not bite because injection happened
   mid-turn, when no suggestion is rendered; delivery now only happens at idle,
   exactly when the suggestion appears.
2. The bridge worker retries the head message every ~250 ms and holds the
   delivery claim through the full 3 s readiness poll, so the claim file is
   fresh most of the time and `receive_messages` filters the message out.
   The head message becomes near-invisible to polling as well (and later
   messages can be polled before it, out of order).

### 2026-08-05 recurrence

Run 132, launched from a binary that already contained the SGR-2 fix, recorded
no successful Claude tmux notifications. Four Claude-bound messages required
manual wakes; the latest sat for 19 minutes while the hook journal said
`input-required`. Claude Code 2.1.221 renders generated prompt suggestions with
its semantic `suggestion` color, which may be a blue/bright-blue or theme RGB
SGR span instead of SGR 2. The dim-only classifier therefore still mistakes
that ghost text for a foreign draft. Run 133's fresh pane accepted automatic
nudges, so this is a long-lived suggestion-state recurrence, not a missing
route or dead bridge worker.

## Requirements

- Composer text rendered entirely in dim styling (SGR 2, the observed
  type-ahead style: `ESC[39m❯ ESC[2m<suggestion>ESC[0m`) counts as an empty
  composer for readiness and for submission confirmation.
- Composer text rendered entirely in Claude Code 2.1.221's semantic
  `suggestion` colors also counts as an empty composer. Recognized styles are
  the shipped ANSI blue/bright-blue variants and the shipped light/dark RGB
  suggestion palette; unrelated colors must not be stripped.
- Any residual composer text is still a foreign draft; injection stays blocked.
- The delivery claim is acquired only after the target pane passes readiness;
  the not-ready wait must never hold a claim, so a blocked head message stays
  pollable via `receive_messages` the whole time.
- After acquiring the claim, delivery re-checks that the message is still
  pending and the pane is still ready (single attempt) before injecting, so
  the single-owner guarantee against concurrent polling is preserved.
- Codex and generic pane delivery keep their existing readiness semantics.
- No main agent pane is restarted during deployment; only the bridge worker.

## Acceptance

- A regression proves a dim type-ahead suggestion does not block delivery.
- A producer-backed regression proves the 2.1.221 semantic suggestion-color
  variants do not block delivery, while an unrelated colored draft does.
- A regression proves plain composer text still blocks delivery and never
  creates a claim file while the pane is not ready.
- A regression proves a message consumed via polling during the readiness wait
  is not injected afterwards.
- Existing bridge delivery, retry, queue, dedup, and single-owner tests pass.
- Live: the stuck loop-48 verdict message is delivered exactly once after the
  bridge worker restart, with all pane PIDs unchanged.
