# D-021 Governess pane target binding

## Problem

The pane-death helper inspects and respawns a Governess pane with bare tmux
session/pane arguments. A hook from one server can therefore inspect or mutate
the same names on another server.

## Required behavior

- Read the current manifest handle and derive an `OwnedPaneTarget` before every
  tmux observation or effect.
- Inspect and respawn only through socket-qualified pane composers.
- Missing, invalid, conflicting, or changed ownership remains non-authoritative
  and performs no tmux effect.
- Revalidate active manifest ownership and the owned pane target immediately
  before recording and respawning.
- Preserve the existing durable restart budget and journal ordering.

## Acceptance

- Tests assert every tmux argv includes the exact recorded socket and pane.
- Degraded targets and ownership drift make zero respawn calls.
- Same pane/session names on another socket cannot influence the result.
- Focused suites, scoped static, build, diff check, and independent zero-write
  review pass.
