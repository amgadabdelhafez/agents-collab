# D-031 Governess tmux skip records

## Problem

Later Governess target-binding slices correctly made unavailable or mismatched
manifest identity issue zero tmux commands, but two effect surfaces still
returned or threw without emitting the field-complete `TmuxSkipRecord` required
by T-10 and verify 10: default Governess runtime effects and the pane-death
respawn helper.

## Required behavior

- Record every unavailable-target Governess runtime effect before throwing.
- Record every pane-death respawn skip caused by missing, invalid, conflicting,
  changed, or mismatched manifest authority.
- Records contain consumer, effect, run, session, pane, socket state, and reason.
- Keep exact target commands and existing fail-closed behavior unchanged.

## Acceptance

- Missing, invalid, conflicting, and mismatched default-runtime targets issue
  zero tmux commands and emit exact field-complete records.
- Pane-death degraded identity issues zero inspect/journal/respawn effects and
  emits an exact field-complete `respawn-pane` skip.
- Existing exact-target commands, restart budget, and journal ordering pass.
- Focused suites, migration checker, typecheck, static check, and independent
  review pass.
