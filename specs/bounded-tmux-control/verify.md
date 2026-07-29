# Verification

1. A simulated hung tmux probe returns `unknown` within the configured bound.
2. Bridge send remains durably queued, returns, and does not clear tmux state
   or inject through app-server while liveness is unknown.
3. Codex proxy does not stop on unknown and does stop on confirmed death.
4. Paired launch/resume exits nonzero without creating or selecting a
   conflicting session when control commands time out.
5. Governess does not recover, tear down during handover, or duplicate a
   replacement from unknown tmux evidence. Explicit human teardown remains
   bounded and records an unconfirmed tmux kill.
6. Interactive attach remains unbounded and user-controlled.
7. Focused tests and `scripts/verify.sh bounded-tmux-control
   bounded-tmux-control` pass with an empty baseline allowlist.
8. Exact-SHA independent review is recorded before deployment.
