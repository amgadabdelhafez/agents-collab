# Task governess-pane-cleanup

Created: 2026-07-28T02:55:36Z
Mode: emergent
Description: Clean up the Governess board hierarchy and signal density

## What I changed

- Split primary agents and helpers into separate aligned tables.
- Removed helper request IDs, empty primary-agent columns, redundant event
  totals, and repeated model identity.
- Replaced duplicate `bridge latest` prefixes with one grouped directional
  block and stripped lightweight Markdown wrappers from its summaries.
- Consolidated worker routing, delivery, performance, context, and failures
  into four rows; humanized and capped route-reason categories.
- Replaced the raw 16-column Nanny model table with one health line and one
  runtime line while retaining full model identity, usage, cache, slots,
  memory, architecture, quantization, MoE, batching, and output limits.
- Entered the terminal alternate screen so recurring refreshes do not append
  duplicate board frames to tmux history.

## Why

The previous 187-column board mixed unrelated roles, repeated transport
metadata, truncated useful values, and exposed raw implementation telemetry
without a readable hierarchy.

## Notes

Regression: yes
Regression id: governess-pane-signal-hierarchy
Regression symptom: The Governess pane was visually dense, repetitive, and
hard to scan despite having spare vertical space.
Regression guard: tests/loop/governess.test.ts

## Verification

- `bun test tests/loop/governess.test.ts`: 63 pass, 0 fail.
- `bun run build`: passed.
- Harness preflight and stop gate: passed.
- `git diff --check`: passed.
- Live Loop 57 renders 15 non-empty rows at 187×20 and retains only one board
  frame in tmux history across refreshes.
- Claude PID `70452`, Codex PID `70454`, Nanny PID `192`, Au Pair PID `197`,
  and dashboard PIDs `75034`, `75036`, and `75039` were preserved; only the
  Governess pane was respawned.
- Repository-wide `bun run check` still reports the existing generated-run
  formatting backlog (334 diagnostics across 501 files); it was not used as a
  passing acceptance gate for this focused cleanup.
