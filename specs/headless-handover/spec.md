# Headless handover completion

## Problem

Harvto runs 98 and 99 required manual teardown after an agent TUI disappeared.
Governess could deliver a graceful handover request through the bridge, but its
exit phase still depended on the missing tmux pane. The default pane probe
returned `undefined` for both a confirmed missing pane and an unavailable tmux
control plane. `agentHasExited` correctly treats unknown evidence as live, so a
validated bundle from a headless agent could never satisfy
`allHandoverAgentsExited`, launch the replacement, and trigger run-owned
teardown.

## Requirements

1. A bounded tmux probe that runs successfully but reports a missing target
   must produce affirmative exited evidence distinct from control-plane
   unavailability.
2. A timed-out, thrown, or otherwise unavailable tmux control probe remains
   unknown and must not authorize handover completion or teardown.
3. Once a headless agent has accepted the handover request and published a
   valid epoch-bound bundle, Governess must not attempt terminal `/exit` for
   its missing pane. The missing pane satisfies only the TUI-exited condition;
   the existing bundle, notification, replacement-readiness, manifest
   acceptance, epoch fence, and teardown policy gates remain mandatory.
4. Live agent panes retain the existing guarded `/exit` path. A busy or
   non-empty composer remains protected from injection.
5. After replacement acceptance, existing run-owned cleanup remains the only
   process teardown owner and must reap the old run's registered bridge and
   app-server processes before killing the old tmux session.
6. The current production run is read-only. Verification must use unit or
   isolated private-tmux fixtures and must not exercise teardown against a live
   Harvto session.

## Non-goals

- Automatically killing an agent whose pane liveness is unknown.
- Changing handover bundle contents or replacement-launch acceptance.
- Adding a second teardown owner or an unfenced external kill command.
- Addressing the separate Codex update-dialog investigation.

