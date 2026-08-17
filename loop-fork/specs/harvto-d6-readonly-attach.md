# harvto-d6-readonly-attach

Task completed 2026-08-17T04:57:50Z, mode emergent.

## What was built

- Promoted D6 exactly once after D15 closed and its separate bookkeeping commit
  `ee1e7736d876d4b387f13580ec25ddf1c606e873` existed with an empty index.
- Created the canonical D6 spec, plan, tasks, verification contract, and run plan before source or
  regression edits.
- Traced the owner to `src/loop/tmux.ts`: pane evidence records only
  `window_active_clients`, and `matchesClaudeSuggestionSnapshot` rejects every nonzero count even
  though tmux exposes exact `client_readonly` state.

## Decisions made

- Promoted parked idea `specs/harvto-d6-readonly-attach.md` into active task `harvto-d6-readonly-attach`.

## Open items at completion

- Implement the promoted idea and complete normal verification.

## Trajectory

- 001 - initial (2026-08-16T07:07:05Z)
- 002 - promoted parked idea (2026-08-16T07:07:05Z)
