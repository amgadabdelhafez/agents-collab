# Task harvto-d4-live-peer-unconsumed

Created: 2026-08-13T08:42:39Z
Mode: emergent
Description: D4 P0: reproduce routed-peer messages remaining unconsumed while the exact target peer is live, then fix with delivery evidence.

## What I changed

Added replay-safe reconciliation for durable `routed-peer` utility jobs. The runtime now repairs the
state-transition-before-dispatch crash window with a stable bridge dedupe key, waits for exact
request delivery plus a correlated reverse peer response, completes once with the peer result, and
fails once when the bridge records an existing durable terminal resolution.

Added deterministic controls for a positively live Claude peer, exact inbox consumption and
response correlation, dispatch replay, duplicate suppression, unknown liveness, dead-letter
failure, unrelated traffic, and epoch restart. Updated D4-only specifications, evidence, evals,
matrix status, and handoff records.

Coupled the result-bearing consumer to its producer by requiring the peer review instruction to
return the verdict with bridge message type `decision`; acknowledgements and generic or
legacy-untyped progress remain nonterminal.

## Why

The unchanged D4 base durably entered `routed-peer` and appended/delivered the exact peer request,
but no component consumed the correlated peer response into a terminal utility result. The job
therefore remained non-terminal forever even after the live peer consumed and answered it.

## Notes

Bridge liveness, retention, delivery, and terminal-resolution policy remain owned by the existing
D1 bridge implementation. Utility reconciliation does not infer success or failure from live or
unknown liveness. No UI, Harvto, dependency, provider, model, remote, deployment, or release path
changed. Verification evidence is in `artifacts/baseline-reproduction.md` and
`artifacts/fix-verification.md`.

Exact review commit `b77cf81d7ffb2e9178e4a72030335fae764090df` received Claude zero-write
`PASS` via bridge decision `c059a661-7e85-458b-ade9-338b3cca568c`. Harness closure completed once
at `2026-08-13T12:09:58Z`.
