# D-013: Governess premature preparation threshold

## Status

Shipped in loop v1.0.37 at local main commit
`4785838b7ccaef2519f3a657e09ad06d87476558` and remains present in v1.0.38.
Assistant turn counts no longer trigger preparation or handoff; measured
context and compaction pressure remain valid triggers. Continue to monitor live
UAT and reopen only with new producer evidence.

## Confirmed failure

Run 24 received `prepare a fresh-loop handover now` when the Codex driver
reached the fixed threshold of 14 assistant turns. The run was only minutes
old and was still completing one bounded G1 prerequisite-commit check. The
threshold fired before the focused post-commit tests, binding validation, G2,
G3, G4, or C1 dispatch could complete.

The same preparation policy repeatedly fragmented the tmux-normalization work
across short successor runs. Each successor then paid the full charter,
handoff-validation, bridge-recovery, and review setup cost again. Turn count
alone did not establish context pressure, stalled progress, excessive elapsed
time, or an unsafe atomic boundary.

## Required behavior

- Treat assistant-turn count as one signal, never an unconditional handover
  trigger.
- Defer preparation while a bounded atomic step is actively advancing, unless
  a hard context, safety, or runtime limit requires immediate handoff.
- Require positive pressure evidence such as measured context utilization,
  elapsed time, token budget, repeated no-progress cycles, or an explicit
  human request.
- Define a maximum deferral window so an agent cannot hold preparation
  indefinitely; after that window, finish or fail the atomic step explicitly.
- Persist the exact trigger evidence, threshold values, current atomic-step
  identity, and deferral decision in Governess state and the handoff bundle.
- Do not count bootstrap, bridge-recovery, status polling, or handoff-only
  exchanges as equivalent to implementation/review progress turns.
- Preserve the active atomic result and its pending peer response through
  succession under D-002 rather than restarting the slice.

## Regression evidence required

- A run at 14 assistant turns with low context pressure and advancing producer
  evidence defers preparation until its bounded atomic step reaches a terminal
  result.
- A run at the same turn count with hard context pressure prepares immediately
  and records the exact pressure evidence.
- Bootstrap and polling-heavy fixtures do not consume the productive-turn
  budget that triggers preparation.
- A maximum-deferral fixture forces a terminal handoff without losing the
  active atomic result or pending peer verdict.
- A replay of Run 24 reaches G1 focused verification without premature
  succession, while still handing off cleanly when the real pressure threshold
  is met.
