# Plan

1. Keep the bounded 1-through-8 concurrency configuration and raise its default
   from two to four.
2. Count active routed, claimed, and running jobs after stale-job recovery.
3. Defer utility-eligible jobs when no slot is free while continuing other routes.
4. Add regressions, run focused/full verification, and deploy governess only.
