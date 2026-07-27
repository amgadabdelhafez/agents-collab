# Plan: Governess Codex Usage Refresh

## Approach

Refresh the manifest-derived session reference immediately before every
governess tick. Adopt only non-empty identifiers and retain the last known-good
binding when the manifest is missing or malformed. Keep transcript parsing and
Usage Tracker behavior unchanged.

## Sequence

1. Add a small binding-refresh function around the canonical run manifest.
2. Invoke it before `governessTick` reads usage.
3. Add focused regressions for late, changed, and transiently missing bindings.
4. Run focused, full, build, verify, and independent evaluation checks.
5. Install the verified binary and respawn only run 50's governess pane.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Binding source | Current run manifest | It is already canonical for session/thread IDs. |
| Refresh cadence | Once per governess tick | Repairs drift promptly without a second watcher. |
| Empty manifest value | Preserve known-good value | Prevents a transient read from blanking a healthy row. |

## Affected subsystems

- Governess runtime — refreshes agent metadata before observation.
- Governess usage — unchanged parser, exercised through refreshed bindings.
- Run state — read-only manifest access.

## Risks

- Repeated manifest reads add small I/O → Mitigation: one tiny JSON read per tick.
- A changed thread could mix sessions → Mitigation: the manifest is the same
  authority used for bridge routing and explicit resume state.

## Not doing

No quota, pricing, bridge, lifecycle, or renderer redesign.
