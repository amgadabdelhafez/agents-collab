# Verification

- Governess has no `roles · initial ... · current ...`, `llm params`, or
  `judge consensus` text.
- Governess displays worker usage plus considered/routed/skipped/reason totals
  without exceeding its configured width.
- Worker pane contains request/tool/result content but no usage, token, cost,
  route, or job-count summary rows.
- Worker output has semantic ANSI color and remains within 58 columns.
- New paired sessions title the pane `worker.<session>`.
- Focused tests, full `bun test`, build, and lint complete with only documented
  baseline failures, if any.
- Live loop 47 keeps its main agent pane PIDs and geometry unchanged.

