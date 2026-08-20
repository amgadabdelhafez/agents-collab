# D-012: Helper token utilization and transcript growth

## Status

Queued for a fresh isolated governed loop. Do not implement this defect in the
tmux-socket-normalization worktree.

## Confirmed failure

Run 21's first six Au Pair jobs made 71 model calls and consumed 2,415,697
cumulative tokens: 2,186,679 input and 229,018 output. Cached input accounted
for 1,940,843 of the input total, leaving 245,836 uncached input. The six jobs
cost about $0.96 despite several results being unusable.

Three jobs individually consumed about 636K, 647K, and 588K tokens. The 588K
job ran for 15 minutes, exceeded its runtime limit, and returned no artifact.
Other high-token jobs returned corrupt patches rejected by independent
`git apply --check`.

The initial context capsules were only about 6-19 KB. Token growth came from
9-17 model calls and 8-16 tool rounds per job repeatedly replaying accumulated
instructions, file reads, search output, patch drafts, errors, and prior model
output. Provider caching lowered price but did not bound latency, context
pressure, or wasted execution.

## Required behavior

- Enforce explicit per-profile ceilings for model calls, tool rounds, elapsed
  time, cumulative input, uncached input, output, and total tokens.
- Stop a helper before the next model call when any ceiling would be exceeded,
  and persist the exact exceeded limit as a failed terminal outcome.
- Bound and summarize tool-result bytes before they enter later model calls;
  do not replay an unbounded accumulated tool transcript.
- Terminate early after repeated invalid patch production, repeated identical
  tool calls, or failure to advance producer evidence.
- Make budgets proportional to the declared task scope and execution profile;
  small search or two-file patch tasks must not inherit an open-ended budget.
- Report `input`, `cached input`, `uncached input`, `output`, `total`, model
  calls, tool rounds, elapsed time, and cost as distinct fields. Cached input is
  a subset of input and must never be presented as additional unique work.
- Preserve task-level usage after success, rejection, timeout, cancellation,
  and handover so Governess totals can be independently reproduced from
  `utility/usage.jsonl`.
- Join utilization to D-009 outcome classifications so a corrupt artifact,
  routing failure, timeout, or unusable null result cannot count as useful
  helper utilization.

## Regression evidence required

- A deterministic expanding-tool-transcript fixture reaches the configured
  budget, fails before another provider call, and records the exact reason.
- A 6-19 KB initial capsule with repeated tool rounds remains within the
  declared cumulative-token and transcript-byte bounds.
- Search, read-only audit, and two-file patch profiles each have independently
  tested budgets appropriate to their scope.
- Repeated corrupt-patch and no-progress fixtures terminate early rather than
  running until the global timeout.
- A timeout fixture records partial usage and a failed outcome with no false
  artifact or success credit.
- Panel totals exactly reconcile to a seeded `utility/usage.jsonl`, including
  the invariant `uncached input = input - cached input` and
  `total = input + output`.
- A release eval proves useful-result tokens and failed/wasted tokens are shown
  separately and that no cached tokens are double-counted.
