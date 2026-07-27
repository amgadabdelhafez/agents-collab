# Plan: Governess Usage Snapshot Cost Stability

1. Preserve the current disabled/authentication semantics.
2. On transient request failure, synthesize only `pricing` through the existing
   local cached/bundled catalog resolution path.
3. Add a success-to-timeout regression proving equal cost output and no quotas.
4. Run focused/full/build/Harness verification and independent evaluation.
5. Rebuild and respawn only run 50's governess pane, then sample several ticks.

## Risks

- Returning stale quotas could affect role policy, so the fallback must be
  pricing-only.
- Authentication failures must remain visible as unavailable rather than being
  silently classified as transient.
