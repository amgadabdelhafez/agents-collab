# Plan

1. Extend run-process cleanup with a fail-closed current-repository GC.
2. Invoke it beside existing Claude bridge startup maintenance, after the
   immediate version/help bypass.
3. Close the local persistent session in paired-layout rollback.
4. Contain tmux-snapshot and per-run cleanup errors so startup maintenance is
   non-fatal and retryable.
5. Add adversarial ownership, liveness, repository-isolation, failure-
   containment, and CLI tests.
6. Run focused and full verification, then obtain an exact-SHA review before
   deployment.
