# D-019 tmux GC target binding

## Problem

Claude registration GC and abandoned-run process cleanup still inspect ambient
tmux. A live run on a different socket can appear dead, authorizing config
removal, process signals, or failed-state mutation.

## Required behavior

- Derive liveness only from each run's manifest-backed target.
- Missing, invalid, conflicting, timeout, or command-error identity is unknown
  and preserves config, processes, and manifest state.
- Confirmed absence on the exact recorded socket may contribute dead evidence.
- Same-named sessions on distinct sockets remain independent.
- Every unavailable-target skip emits a field-complete structured record.

## Acceptance

- Degraded cases at both consumers issue no ambient tmux command and perform no
  destructive effect.
- Valid targets emit exact `tmux -S <socket> ... -t <session>` argv.
- Focused suites, scoped static, build, diff check, and independent zero-write
  review pass.
