# Plan

1. Capture the exact Run 42 manifest bytes as a test fixture with the released,
   terminal, and legacy-target fields that triggered the conflict.
2. Extend the typed manifest boundary to retain only a syntactically and
   semantically valid UTC workspace release timestamp, accepting the existing
   camel-case and legacy snake-case keys without inventing release state.
3. Add a small terminal-release predicate beside launch reservation. Apply it
   only after tmux liveness returns unknown for an unusable target and only
   when run and launch-attempt PIDs are both positively dead.
4. Add direct negative controls for active, unreleased, invalid release,
   surviving run PID, surviving launch-attempt PID, live tmux, and usable-target
   unknown cases. Assert non-mutation on every refused case.
5. Run focused tests first, then the full named suite, static check, build, and
   diff check. Record the exact command, exit status, and failure names under
   `runs/loop-resume-terminal-reservation-v1/`.
6. Commit one frozen candidate. A different agent performs a zero-write review
   against that exact SHA and the parent integration SHA.
7. Only after PASS and fresh install authority, build and install locally,
   record the installed SHA-256, and retry the explicit `--tmux` certification.
   Preserve the new run long enough to prove both initial submissions and
   bridge identities, then use supported lifecycle control.

## Ownership

- One headless paired Loop is the sole source writer.
- The reviewer makes zero writes.
- The supervisor may inspect, relay, and run lifecycle controls but does not
  edit product source after the writer is launched.
