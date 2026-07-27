# Plan: Governess Usage Display Stability

1. Wrap the existing tracker reader with a small process-local cache keyed per
   provider.
2. Refresh a provider only when that provider is present in the latest snapshot;
   fill an absent provider only while its cached observation is fresh.
3. Clear the cache when the underlying reader returns disabled/auth failure and
   bound all retention with a short TTL.
4. Add regressions for transient, partial, expiry, and auth-failure transitions.
5. Run focused/full/build/Harness checks, obtain independent evaluation, then
   rebuild and respawn only live run 50's governess pane.

## Risks

- Stale quotas can influence role-pressure policy, so retention must be short
  and bounded.
- A partial response must not replace the healthy provider's cached value with
  an absent field.
