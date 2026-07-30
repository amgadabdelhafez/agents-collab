# Verify: tmux redraw backpressure

## Automated acceptance

- A simulated tmux timeout during the first pane capture issues no more tmux
  captures or mutations in that tick.
- The failed cycle still writes a Governess frame containing an explicit degraded
  marker and newly refreshed durable evidence.
- No recovery, nudge, delivery, role mutation, or liveness transition is emitted
  from stale pane evidence.
- A later successful capture clears the marker and restores current observations.
- A Unicode-rich pane snapshot larger than 10 KiB does not change tick semantics
  or truncate the safety decision input.
- Existing Governess, tmux, bridge, lifecycle, and utility routing tests pass.
- `scripts/verify.sh`, build, and `git diff --check` pass.

## Live acceptance

- Run against a private tmux socket/session with realistic pane output and a
  deliberately unavailable control path.
- The board reports degradation within one bounded command timeout and resumes on
  the first healthy cycle.
- No main-agent pane is restarted or signalled by the smoke.
- Exact reviewed commit, binary SHA-256, and evaluator verdict are recorded before
  deployment.
