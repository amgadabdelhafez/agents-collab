# Plan: Automatic Worker Tool Widening

1. Preserve the run-51 telemetry breakdown as the baseline and record the
   exact safe/unsafe command corpus in task-owned tests.
2. Add red-first request/profile tests for focused checks, listings, literal
   grep, bounded awk/tail reads, exact stderr merging, and security negatives.
3. Extend request persistence with a validated execution cwd and extend the
   broker with bounded non-recursive directory listing.
4. Implement the smallest literal classifier grammar for the four new
   families, mapping each to one satisfiable execution profile.
5. Run focused suites, full tests, static checks, build, and diff validation;
   fix only regressions introduced by this task.
6. Obtain independent security/correctness evaluation and pass Harness gates.
7. Repair the live-discovered journal-lock contention race with bounded retry,
   fresh-lock protection, and ownership-safe cleanup; add a process-contention
   regression and repeat independent evaluation.
8. Install the freshly built executable inode, restart only the
   governess/worker display processes, and prove concurrent live focused-test
   plus inspection canaries.
