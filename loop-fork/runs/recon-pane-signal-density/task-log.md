# Task recon-pane-signal-density

Created: 2026-07-28T02:29:20Z
Mode: emergent
Description: Compact routes, tools, and results panes to the important signal

## What I changed

- Removed request IDs and raw route internals from route rows while preserving
  destination, state, age, and objective.
- Grouped equivalent tool calls and retained tool name, count, success/failure,
  and failure detail.
- Extracted the first useful line from direct-tool result payloads, removed
  JSON/Markdown wrappers, and suppressed a completed result while the same job
  is already shown as awaiting bridge delivery.
- Rendered only changed frames in the terminal alternate screen so one-second
  refreshes do not accumulate duplicate snapshots.
- Rebalanced the three-pane row to approximately 45% routes, 20% tools, and
  35% results.

## Why

The dashboards repeated identifiers and transport details while truncating the
human-readable objective or result that matters during supervision.

## Notes

Regression: yes
Regression id: compact-recon-pane-signal
Regression symptom: Recon dashboards repeated IDs, wrappers, duplicate calls,
and whole refresh frames.
Regression guard: tests/loop/recon-pane.test.ts

## Verification

- `bun test tests/loop/recon-pane.test.ts tests/loop/tmux.test.ts`: 53 pass,
  0 fail.
- `bun run build`: passed.
- Harness preflight and stop gate: passed.
- Live dashboard history contains one current frame: 7 route rows, 6 tool
  rows, and 7 result rows.
- Live widths are routes 105, tools 50, results 78 in a 235-column window.
- Claude PID `70452`, Codex PID `70454`, Governess PID `5485`, Nanny PID `192`,
  and Au Pair PID `197` were preserved.
