# Test certification hardening

## Problem

The redraw smoke intermittently fails but deletes the temporary evidence needed
to diagnose the race. Separately, bare `bun test` deterministically exits 133
near `single-loop.test.ts` on both the reviewed candidate and its base, while
the per-file `test:ci` runner passes. A developer can therefore see only a
partial bare-suite run without a useful preserved crash record.

## Requirements

- On redraw-smoke failure, preserve the exact temporary directory and print a
  concise path plus bounded tails of the relevant logs/state. Successful runs
  must retain their existing cleanup behavior.
- Reproduce the bare-suite exit 133, identify the first causal cross-file or
  lifecycle interaction, and remove it without weakening assertions.
- If the runtime itself cannot be repaired locally, make the unsupported bare
  certification path fail immediately and actionably before partial tests run;
  never allow a misleading partial green.
- Keep the canonical sorted per-file suite and empty baseline allowlist.
- Fold in the reviewed `readSync` `bytesRead` check only if it remains a local,
  behavior-preserving correction.

## Acceptance

- A forced redraw-smoke failure names a preserved evidence directory and emits
  bounded diagnostics; a passing smoke leaves no temp directory behind.
- Bare `bun test` either completes the full suite successfully or fails before
  executing a partial suite with explicit guidance to `bun run test:ci`.
- `bun run test:ci`, `bun run check`, typecheck, build, and the focused smoke
  regression pass with an empty named baseline allowlist.
- No live binary deploy occurs without independent exact-SHA review.

## Non-goals

- Changing production routing, helper permissions, or run-101 hook activation.
- Silencing, skipping, or allowlisting existing test failures.
