# Utility command and read recovery

## Problem

Harvto loop-98 proves Au Pair now receives work, but two jobs failed for
avoidable harness reasons:

- `f2c3b932-319e-4bc4-90fe-590fa4d6a434` gathered useful evidence, then GLM
  repeatedly requested the same 600-line read despite the broker's 500-line
  correction. The argument-sensitive repeat breaker correctly stopped it, but
  a safe in-scope range can be narrowed without another model round.
- `51e7cba5-05dd-47df-965b-18d8d0928c08` was an unprofiled command packet.
  The router accepted it and exposed `run_check` even though there was no exact
  command or command cwd. Its desired registered worktree appeared only in
  narrative text, so every attempted check was denied after spending model
  calls.

The registered-worktree resolver can adopt absolute scopes, but focused-check
argv is not carried through the normalized workspace boundary. Its current
test covers cwd/scopes only, not executable delivery.

## Requirements

1. A `kind=command` packet without a deterministic `execution_profile` must be
   rejected by `route_task` before a job or model call is created.
2. The rejection must tell the requester how to submit an exact focused check:
   profile, cwd, argv, and absolute scopes when selecting a registered linked
   worktree.
3. Focused-check argv path operands must normalize with absolute registered
   worktree scopes and persist in the verified workspace decision.
4. The worker must execute only the normalized exact argv in the adopted
   worktree. Mixed, unrelated, stale, or unregistered roots remain denied.
5. A model-driven read exceeding 500 lines may be narrowed to the first 500
   lines only when no exact classified read boundary exists. The result must
   report truncation, the requested end, and the next start line so it cannot
   be mistaken for a complete read.
6. Exact classified reads remain fail-closed when their persisted boundary is
   malformed or oversized.
7. The three-identical-call breaker and three-rejected-round breaker remain
   unchanged.

## Scope

- Utility route validation and guidance.
- Registered-worktree focused-check argv normalization.
- Broker-side safe narrowing for model-driven file reads.
- Focused, full, and replay-style verification.
- No changes to live loop-98, routing tier selection, credentials, or worker
  authority.
