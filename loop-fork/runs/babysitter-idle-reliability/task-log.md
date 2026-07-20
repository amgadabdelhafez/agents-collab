# Task babysitter-idle-reliability

Created: 2026-07-20T05:44:09Z
Mode: planned
Description: Deterministic waiting-human fallback, idle reassess-once, freshest-evidence summary, one-shot autonomy nudge

## What I changed

`src/loop/babysitter.ts`:
- `detectWaitingHumanFromTails` (exported): deterministic, tail-scoped
  (last 12 non-empty lines) human-directed-question detector. `WAITING_HUMAN_RE`
  matches clear human-directed phrasing; `WAITING_PEER_RE` vetoes peer/review
  waits. `applyDeterministicWaiting` OR-combines it into the waiting state each
  tick, so a conservative/absent LLM read no longer leaves the pair silently
  waiting.
- `nextWaitingAssessment` (exported, pure): schedules the first per-episode
  waiting judgment, then AT MOST one retry if the first read was inconclusive
  and the pair is still idle past `BOTH_IDLE_REASSESS_MS`. The background `.then`
  never downgrades a waiting already confirmed this episode.
- `maybeSendAutonomyNudge`: one-shot, per-episode-deduped nudge to the current
  driver when both are idle > `AUTONOMY_NUDGE_IDLE_MS`, not human-blocked, none
  limited/crashed, and the driver's tail is a generic "standing by" (not a
  peer/human wait). Message tells it to pick the next safe unblocked PLAN/STATUS
  item, keep scope/frozen constraints, and not ask for routine priority.
  Deduped via `notified.autonomyNudge` (reset when not both idle).
- `runBabysitter`: forces an immediate summary refresh when a new both-idle
  episode begins (board Next is most likely stale exactly then).

`src/loop/babysitter-llm.ts`:
- `SUMMARY_SYSTEM_PROMPT` now tells the model the pane TAIL is the CURRENT state
  (prefer it over older prompt/prior-session history), base Next on the freshest
  completion/stop-rule/decision, and never invent human instructions (no
  fabricated "resume X"/"enter API key").

## Why

Loop-24 stalled: both panes said "standing by"/"waiting for your input" and
asked the human to choose, yet `waitingConfirmed` stayed false (sole reliance on
one conservative local-LLM JSON answer), and the board kept a stale/hallucinated
"resume Blender / enter API key" Next after both lanes were closed.

## Notes

- Focused proof: `bun test tests/loop/babysitter.test.ts
  tests/loop/babysitter-llm.test.ts` → all pass (54 + 19). 14 new tests:
  detector cases + sanitized loop-24 replay, `nextWaitingAssessment` schedule,
  autonomy-nudge fire/dedupe/3 vetoes (human-wait, peer-wait, limited),
  waiting-confirmed wiring, strengthened summary prompt.
- Full suite: 572 pass / 3 fail. The 3 failures are pre-existing tmux `runCli`
  auto-update mock assertions that fail identically on the clean base
  (feat/babysitter-pane), unrelated to this slice.
- `bun run build` succeeds. Net-zero new biome findings on the touched source
  files (per-rule diagnostic multiset identical to base).
- Live install + single-pane babysitter restart proof appended after Codex
  review.

Regression: yes
Regression id: babysitter-idle-stall-no-autonomy-nudge
Regression symptom: Both agents idle and not human-blocked, but the loop never nudges the driver and the board shows a stale/invented Next.
Regression guard: tests/loop/babysitter.test.ts
