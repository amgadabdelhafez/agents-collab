# Plan: Driver bootstrap role activation

## Approach

Keep the complete charter authoritative and add only role-specific activation
to the constant-size pointer bootstrap. Pass the already-known paired role into
charter materialization, emit a direct primary or support instruction, and
extend the realistic-charter regression to verify both content and byte bounds.

## Sequence

1. Add a narrow launch-bootstrap role type and pass it from paired layout
   preparation into charter materialization.
2. Add conditional primary/support activation lines after hash verification.
3. Extend focused constant-size transport assertions for both panes.
4. Run focused tests, full verification, and exact-SHA review.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Authority | Complete charter remains authoritative | Bootstrap only activates the role; it does not duplicate mission content. |
| Primary behavior | Start only when charter contains a concrete mission | Preserves taskless interactive sessions. |
| Support behavior | Wait unless charter assigns separate work | Preserves reviewer politeness and avoids duplicate implementation. |
| Transport | Existing pointer plus SHA-256 | No prompt-size regression or second payload path. |

## Affected subsystems

- CLI and tmux launch charter materialization.
- Constant-size paired launch regressions.

## Risks

- Primary wording could override an interactive wait charter. Mitigation: make
  initiation conditional on a concrete mission in the verified charter.
- Support wording could suppress separately assigned work. Mitigation: retain
  an explicit charter-assignment exception.
- Added text could exceed the byte cap. Mitigation: assert both variants remain
  below 1 KiB using the realistic-size transport test.

## Not doing

No runtime topology, process lifecycle, bridge, or complete-charter behavior is
changed in this slice.
