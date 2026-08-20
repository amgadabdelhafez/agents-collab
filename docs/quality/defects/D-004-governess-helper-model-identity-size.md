# D-004: Governess hides helper model version and size

Status: queued
Severity: P2
Subsystem: Governess helper model observability
First confirmed: agents-collab Run 15, 2026-08-07

## User-visible failure

The Nanny row is labeled only `qwen`, even though the live model evidence names
the configured version as `Qwen3.6-35B-A3B-4bit`. The GLM and Qwen helper rows
also omit model size from the column corresponding to agent effort, preventing
an at-a-glance comparison of the actual helper capacity in use.

## Required behavior

- Render Nanny with its configured, version-qualified Qwen model identity rather
  than the generic family label `qwen`.
- Render the authoritative model size for both GLM and Qwen in the helper rows'
  effort column.
- Derive identity and size from the active configuration/provider metadata; do
  not hardcode the Run 15 values.
- Render an explicit `unknown` state when size metadata is unavailable.
- Keep model identity and size stable across refreshes and visually aligned with
  the corresponding main-agent columns.

## Acceptance tests

- Fixtures cover at least two Qwen versions and two GLM configurations with
  different sizes, plus missing metadata.
- The rendered Nanny label includes the exact configured Qwen version.
- The GLM and Qwen effort-column cells show their exact derived sizes.
- Provider/config changes update the row on the next refresh without restarting
  unrelated panes.
- A live-pane audit verifies displayed identity and size against the run-scoped
  configuration and provider evidence.

## Delivery lane

Implement in a fresh isolated governed loop. Do not modify the live Governess
pane or current tmux socket-normalization candidate as part of filing this
defect.
