# Verify: Exact Replay Release Gate

## Contract

- [x] Registration, stamp, and observations require schema version 1.
- [x] Stamp is `CONCUR`, names a commit containing the exact registration bytes,
      comes from a different author, and predates measurement.
- [x] All execution bindings match the registration exactly.
- [x] Registered case IDs and input hashes match both arms exactly once.

## Derived gates

- [x] Success rate and success-rate drop are derived from paired cases.
- [x] Token, tool-call, and latency ratios are derived from totals.
- [x] Correction churn uses CHANGES upper bound plus driver retractions and
      reviewer disproofs; ambiguous verdicts are bounded.
- [x] A baseline denominator of zero cannot permit positive candidate usage.
- [x] Any failed threshold yields nonzero CLI exit.

## Proof

- [x] `bun test tests/loop/replay-release-gate.test.ts`
- [x] `bun run build`
- [x] changed-file `ultracite check`
- [x] `git diff --check`
- [ ] independent exact-SHA verdict recorded separately
