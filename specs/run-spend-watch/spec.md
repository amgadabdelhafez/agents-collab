# Run-level spend watch

## Problem

On 2026-07-26 four commits removed every spend control the utility worker had:

- `144c831 feat(loop): remove worker cost caps and raise tokens` — deleted
  `maxJobCostUsd` ($0.05/job), `maxRunCostUsd` ($0.25/run incl. reservations),
  `LOOP_UTILITY_MAX_RUN_USD`, the reservation accounting
  (`recordedUtilityCostUsd`, `activeUtilityReservationUsd`,
  `remainingUtilityRunBudgetUsd`) and the reported-cost execution abort.
- `4c5bc4b refactor(loop): remove generic cost rejection` — deleted the router's
  `budget-exceeded` branch, "so no dollar estimate can gate routing anywhere".
- `894773e feat(loop): remove worker token limits` — deleted `maxTokens` /
  `maxTotalTokens` and their env controls.
- `c23d831 feat(loop): remove worker step budget` — deleted `maxSteps`.

They were right to go. Every one of them was a **per-job gate that failed work
in flight**:

- Job `4fd7f78a` did 3 model calls and 8 tool calls, then died at 16,970 tokens
  against a 16,000 ceiling — mid-extraction, output discarded.
- Four consecutive loop-48 jobs died on the 16-step budget, and per the run log
  "every failure escalates to a driver pane" — i.e. the cap spent the founder's
  attention, the one resource the retro identifies as scarcest.
- The dollar caps were removed as "per-job and per-run dollar caps that the
  operator no longer wants".

What is left is a 15-minute `maxJobRuntimeMs` on unbounded OpenRouter spend.

Two further facts found while reading the current tree:

1. A run-level budget alert **already exists** in `governess.ts`
   (`config.budgetUsd`, `BUDGET_WARN_FRACTION` 0.8, `kind: "budget"`
   escalations at 80% and 100%). It is **dead**: `LOOP_GOVERNESS_BUDGET` occurs
   exactly once in the repository — at its own read site — and `budgetUsd`
   falls back to `0`, which disables the branch.
2. That alert would be aimed at the wrong money anyway. Its `totalCost` is
   `rows.reduce((sum, row) => sum + row.usage.costUsd, 0)` over `AgentRow[]`,
   i.e. **Claude + Codex subscription API-equivalent** dollars. Those are not
   cash; July's ceiling was quota (103 hrs at the Codex weekly cap, 97 hrs
   rate-limited), not dollars. The **only real cash** in the system — OpenRouter
   utility-worker spend, journaled per job to `<runDir>/utility/usage.jsonl` —
   is summed for display and watched by nothing.

## Requirements

- Watch spend at the **run** level, never per job. Nothing in this feature may
  reject a route, abort a conversation, or fail a job that is already running.
- Track the two money streams **separately**, because they are not the same
  good:
  - `billableUsd` — real cash (OpenRouter workers), from `utility/usage.jsonl`,
    latest event per `jobId`.
  - `attributedUsd` — subscription API-equivalent (Claude/Codex). Reported for
    context; may raise a notice; may **never** contribute to a kill.
- Escalate on cumulative billable spend at two levels (notice, alert), deduped
  once per run per level, through the existing `EscalationEvent` channel.
- Hard-kill only on a **runaway**, which requires **both** cumulative spend at
  or above the kill threshold **and** a sustained burn rate over a measurement
  window. A single expensive-but-legitimate job must never trigger a kill —
  that is the loop-47 failure restated at run level.
- A kill stops **admission of new** utility jobs and escalates urgently. It does
  not abort in-flight work.
- Ship a dry-run mode and make it the **default**. In `observe` the watch
  computes and journals the identical decision, reports `wouldKill`, and cannot
  enforce. Enforcement requires opting in to `enforce`.
- Journal every evaluation to `<runDir>/spend-watch.jsonl` so a week of observe
  mode produces the evidence needed to pick real thresholds.
- Never write a secret to the journal or an alert. Amounts, levels, counts only.

## Acceptance

- `observe` and `alert` modes return `enforced: false` for every input,
  including inputs far above every threshold.
- Cumulative spend above `killUsd` with burn below `runawayUsdPerHour` yields
  level `alert`, never `runaway`.
- Burn above `runawayUsdPerHour` with cumulative below `killUsd` yields at most
  `alert`, never `runaway`.
- Attributed (subscription) spend alone never produces a kill at any magnitude.
- Notice and alert escalate exactly once per run.
- Billable spend reads the latest event per `jobId` (no double count on retry)
  and survives malformed JSONL lines.
- Full suite stays at the 4-failure Codex-launch baseline; build passes.
