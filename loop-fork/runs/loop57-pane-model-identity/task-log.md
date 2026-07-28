# Task loop57-pane-model-identity

Created: 2026-07-28T02:04:14Z
Mode: emergent
Description: Keep helper roles in pane borders and show each job model in pane transcript lines

## What I changed

- Kept `nanny.<session>` and `au-pair.<session>` as tmux pane-border titles.
- Replaced redundant helper-role labels in pane transcript lines with the short
  model families `QWEN` and `GLM`; full model/version details stay in Governess.
- Replaced generated Nanny/Au Pair role text in response lines with the model
  name.
- Bound completed transcript entries to the model recorded for that job, with
  the configured tier model used only as a fallback for active/unmeasured jobs.
- Removed the Governess project-summary/advisory injection from Nanny so both
  helper panes contain only their own request/tool/result stream.
- Show each job ID once on its request header and prioritize the real request
  objective and result summary over generic tool-count pane summaries.

## Why

The pane border already communicates the helper role. The body should identify
the `QWEN` or `GLM` family for each request, tool call, and result without
repeating Nanny/Au Pair, full version strings, or job IDs on every line.

## Notes

Regression: yes
Regression id: helper-pane-model-identity
Regression symptom: Helper pane lines repeated role titles and hid the model.
Regression guard: tests/loop/utility-runtime.test.ts

## Verification

- Focused pane/observability/tool tests: 87 pass, 0 fail.
- Full `bun run test:ci`: 1,105 pass, 0 fail across 55 files.
- Compiled binary build: pass.
- An explicit regression proves missing-path suggestions do not traverse a
  symlinked declared scope root.
- Live panes: Nanny `%4` shows only its `QWEN` work stream; Au Pair `%3` shows
  only its `GLM` work stream. Neither shows the Governess project summary.
- Each visible job ID appears once, followed by the actual request objective,
  tool activity, status, and worker result summary.
- Pane borders remain `nanny.harvto-loop-57` and
  `au-pair.harvto-loop-57`.
- Claude `%0` PID `70452` and Codex `%1` PID `70454` were preserved.
