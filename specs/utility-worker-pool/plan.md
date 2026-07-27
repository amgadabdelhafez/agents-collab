# Plan

1. Add bounded concurrency configuration with a default of two.
2. Count active routed, claimed, and running jobs after stale-job recovery.
3. Defer utility-eligible jobs when no slot is free while continuing other routes.
4. Add regressions, run focused/full verification, and deploy governess only.
