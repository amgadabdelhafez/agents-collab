# D-022 Governess runtime tmux target binding

## Problem

The main Governess runtime still composes capture, pane probes, labels, key
delivery, respawn, border setup, replacement readiness, and teardown from bare
session or pane strings.

## Required behavior

- Default runtime dependencies derive every session and pane command from the
  current manifest handle.
- Legacy string callbacks may identify a requested pane/session but cannot
  supply socket authority; unmatched or degraded identity fails closed.
- Replacement liveness and readiness use the replacement manifest target.
- Predecessor workspace release preserves exact tmux identity through teardown
  while durably releasing only the workspace reservation.
- No ambient tmux command remains in the production Governess runtime.

## Acceptance

- Injected-spawn tests bound the complete default runtime command set and prove
  exact `-S` socket plus session/pane targeting.
- Missing, invalid, conflicting, mismatched, and changed targets issue zero tmux
  commands/effects.
- Handoff tests prove workspace release and exact subsequent teardown ordering.
- Focused suites, scoped static, build, diff check, and independent zero-write
  review pass.
