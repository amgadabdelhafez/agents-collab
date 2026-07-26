# Spec: Lower-Agent Pane Cleanup

## Problem

The first lower-agent observability release exposes the right evidence but the
presentation is noisy at the deployed tmux geometry. The governess pane uses a
separate LOWER table whose columns do not align with Claude and Codex, both the
agent and local-LLM rows overflow a 176-column pane, and the 58-column utility
pane repeats status while truncating the useful part of requests and results.
Removing the entire structured summary also hid the two operational fields that
remain useful: current progress and next action.

## Goal

Make both panes readable at the deployed 58x20 utility and 176x20
governess sizes. Treat utility as a third monitored agent row, emphasize actual
request/result content and per-job economics in its own pane, and restore only
two compact governess lines for Progress and Next.

## Requirements

1. Render utility directly below Claude/Codex in the existing AGENT table using
   the same columns and a single shared header. Remove the standalone LOWER
   header/table.
2. Map utility data honestly into the common columns: state, age, model,
   completed/failed run count, cumulative cost, token split, job/model/tool
   activity, and latest job id. Unsupported context and quota fields render as
   unavailable.
3. Tighten AGENT and local-LLM column widths so every rendered header and row is
   at most 176 visible columns and no data row wraps at the deployed geometry.
4. Replace the utility pane's repetitive nine-line header with a compact status
   block that retains availability, state, job counts, calls, tools, token
   split, cost, routing/delegation, and current/last work.
5. Group recent utility activity by job and show the actual requester objective,
   bounded tool outcome, final response or blocker, duration, calls, tokens, and
   per-job cost. Prefer outcome/evidence over repeated boilerplate and long path
   prefixes, while retaining enough file/line identity to understand the task.
6. Keep transcript normalization, terminal-control stripping, credential
   redaction, width caps, and height caps from the prior release.
7. Render exactly two compact structured-summary lines at the bottom of the
   governess board: Progress and Next. Do not restore Project or Objective.
8. Progress/Next and every table remain within the live pane's row budget; the
   agent and utility state rows take priority when height is constrained.
9. Do not change routing, worker scheduling, prompts, budgets, tool authority,
   or provider behavior.
10. Refresh only the utility and governess display panes after release; preserve
    Claude and Codex pane IDs/PIDs. Do not push remotely.
11. The implementation and release refresh preserve the tmux geometry exactly:
    Claude top-left, Codex top-right,
    governess bottom-left, and utility bottom-right at the existing split sizes.
    Do not resize, move, create, or remove panes.

## Acceptance criteria

- [x] Governess tests show one AGENT header followed by Claude, Codex, and
      utility rows using identical column boundaries.
- [x] Visible AGENT and LLM headers/rows are at most 176 characters.
- [x] Utility pane tests prove grouped request/tool/result output includes job
      duration, calls, tokens, cost, response evidence, and failure blockers at
      58x20 without overflow.
- [x] Governess renders only Progress and Next from the structured summary and
      respects the row budget.
- [x] Focused and broad utility/governess/bridge/tmux tests pass; build and
      `git diff --check` pass; unrelated full-suite baselines are isolated.
- [x] Independent evaluator records PASS in
      `runs/lower-agent-pane-cleanup/eval.json` before integration.
- [x] Live loop 47 shows the cleaned panes while Claude/Codex IDs and PIDs are
      unchanged.

## Non-goals

- Fixing the three observed burst claim-timeout failures or adding worker slots.
- Changing what the lower agent sees, can access, or returns over the bridge.
- Restoring the project or objective summary lines.
- Changing the four-pane tmux layout or proportions.
