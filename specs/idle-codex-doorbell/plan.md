# Plan

1. Add a worker regression where Codex app-server delivery fails but its live
   pane is idle and eligible for notification.
2. Add a worker regression that records the actual idle delays used across
   consecutive no-work cycles.
3. Add the missing Codex notification fallback and bounded worker backoff.
4. Repair any fail-closed integrated-lineage blocker exposed by the mandatory
   verification gate without widening runtime behavior.
5. Run focused bridge tests, the repository verification gate, and a build.
6. Commit the isolated branch and request exact-SHA supervisor review.
