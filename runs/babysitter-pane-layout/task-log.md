# Task babysitter-pane-layout

Completed: 2026-07-25T18:54:10Z

## Outcome

- Project uses two full-width summary lines instead of one half-width line.
- The oversized agent table is split into fitted runtime and activity tables.
- Model names, bridge excerpts, and the LLM table were padded to fit the live
  191-column pane without terminal-created rows.
- The decorative summary separator and terminal-frame trailing newline were
  removed to keep the complete one-judge board within 20 rows.

## Verification

- Focused board/summary tests: 15 passed.
- Complete babysitter test file: 45 passed with the unrelated legacy handoff
  compatibility flag enabled.
- Build and `git diff --check`: passed.
- Independent evaluator: PASS, no blocking findings.
- Live deployment preserved Claude PID `38930` and Codex PID `38932`; only the
  babysitter changed from PID `39070` to `39993`, and state advanced from tick
  287 to 288.

## Follow-up

A second configured LLM judge adds another footer row. A future pane-height-aware
budget should reclaim one summary line when multi-judge mode is displayed in a
20-row pane.
