# run-spend-watch task log

- 2026-07-27: Worked in a dedicated worktree (`/Users/amgad/qtr-ops-spend`,
  branch `qtr/ops-spend`) off `main`. The primary checkout was on
  `fix/baseline-failures-named-allowlist` and was never touched; loop 56's
  tmux session, worktree and processes were left alone.

- Archaeology. The spend controls were removed by four commits on 2026-07-26,
  in this order:
  - `7ff6a83 feat: raise worker limits and show bridge traffic` (16:14) — first
    raised ceilings rather than removing them.
  - `144c831 feat(loop): remove worker cost caps and raise tokens` (17:22) —
    deleted `maxJobCostUsd` ($0.05), `maxRunCostUsd` ($0.25),
    `LOOP_UTILITY_MAX_RUN_USD`, the reservation accounting
    (`recordedUtilityCostUsd`, `activeUtilityReservationUsd`,
    `remainingUtilityRunBudgetUsd`, `requestReservationUsd`) and the
    reported-cost abort inside `assertUtilityBudget`.
  - `4c5bc4b refactor(loop): remove generic cost rejection` (17:24) — removed
    the router's `budget-exceeded` branch and tier/run budget fields, "so no
    dollar estimate can gate routing anywhere".
  - `894773e feat(loop): remove worker token limits` (17:31) and
    `c23d831 feat(loop): remove worker step budget` (18:47).

- Why they hurt, from the specs written alongside them. `worker-unbounded-cost`:
  job `4fd7f78a` "successfully made three model calls and eight bounded tool
  calls, but failed after 16,970 cumulative tokens because the 16,000-token job
  ceiling was too small for a multi-document extraction"; the dollar caps were
  "per-job and per-run dollar caps that the operator no longer wants".
  `worker-unbounded-steps`: "four consecutive utility jobs failed with 'worker
  reached its step limit without completion' ... and every failure escalates to
  a driver pane." The common defect is not the existence of a limit but its
  level: each was a per-job gate that destroyed work already in flight and
  spent founder attention.

- Two findings that changed the design (see spec):
  1. A run-level budget alert already exists in `governess.ts` — `budgetUsd`,
     `BUDGET_WARN_FRACTION` 0.8, `kind: "budget"` escalations at 80%/100%. It
     is dead: `LOOP_GOVERNESS_BUDGET` appears exactly once in the repository,
     at its own read site, and defaults to `0`, which disables the branch.
  2. That alert sums `AgentRow.usage.costUsd` — Claude/Codex subscription
     API-equivalent dollars, not cash. The only real cash, OpenRouter
     utility-worker spend in `<runDir>/utility/usage.jsonl`, is displayed by
     `utility-observability.ts` and watched by nothing.

- Implemented `src/loop/governess-spend.ts` (run-scoped, never per job):
  separate `billableUsd` (cash) and `attributedUsd` (subscription) streams;
  notice/alert thresholds on cash; and a kill that requires **both** cumulative
  spend ≥ `killUsd` and burn ≥ `runawayUsdPerHour` sustained over a window, so a
  single expensive job cannot trigger it. Mode defaults to `observe`, which
  computes and journals the identical decision but reports `wouldKill` and
  cannot enforce. Every evaluation appends to `<runDir>/spend-watch.jsonl`.

- Wired `watchRunSpend` into `governessTick` next to the existing escalation
  collection, plus `spendHistory` / `spendNotified` on the run state with the
  same defensive restore the file already uses, so a governess respawn does not
  reset the burn window. The existing dead `budgetUsd` path was left alone.

- Verification: 926 pass / 4 fail (baseline 890/4; the same four Codex-launch
  expectations). Biome 147 and tsc 150 both exactly at baseline; `governess.ts`
  alone is 47 biome errors before and after. Build succeeds and now bundles 71
  modules rather than 70, confirming the module is reachable from the CLI.
  The `governess.ts` diff is purely additive (92 insertions, 0 deletions) —
  incidental biome reformatting of unrelated lines was reverted so the
  supervisor reviews only this feature.

- Not done deliberately: no enforcement is on anywhere, no live loop was
  touched, and the shipped thresholds are placeholders. The point of observe
  mode is that a week of `spend-watch.jsonl` supplies real numbers first.
