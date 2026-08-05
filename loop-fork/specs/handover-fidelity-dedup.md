# handover-fidelity-dedup

Task started 2026-08-05T06:14:27Z, mode planned.

## Scope

- Bind predecessor driver/reviewer effort and continuation bytes into the
  verified handover manifest.
- Relaunch from those exact frozen values.
- Clear stale Governess pane viewport/history once on renderer startup, then
  retain bounded line-delta updates.
- Codify teardown-first durability preconditions and retire `1e04e5fb`
  without reuse.

## Consumer trace

The duplicate display rows are not duplicated persisted entities. The state
file has no agent/helper row arrays; config resolution creates one agent per
manifest-owned left/right pane; each tick creates one row per config agent and
at most one row per helper tier. Cost, statistics, role balance, handover
pressure, quota presentation, and enforcement consume the current tick rows
before rendering. The observed duplicate was stale terminal-frame residue
across a killed alternate-screen renderer, so reconciliation belongs at the
first-frame producer boundary.
