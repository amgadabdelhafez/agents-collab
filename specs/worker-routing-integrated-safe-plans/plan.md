# Plan

1. Integrate the four-slot and runaway-guard commits into the completed
   broader-tool branch, resolving runtime/test overlap without dropping either
   boundary.
2. Add red classifier/router/runtime regressions for structured read plans and
   bounded grammar additions.
3. Implement read-plan classification by composing only existing safe
   classifiers; expose the read-only tool union in runtime.
4. Add reason-category telemetry with legacy inference and update the governess
   routing rows.
5. Run focused/full verification, build, Harness gates, and independent review.
6. Atomically install and restart only the governess pane so classifier and
   spawned-worker broker use the same binary.
