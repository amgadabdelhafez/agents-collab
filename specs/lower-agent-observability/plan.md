# Plan: Lower-Agent Observability

1. Add a pure utility observability reader that folds durable job, usage, tool,
   and delegation journals into totals plus a bounded transcript.
2. Refactor the lower-agent renderer to consume the snapshot and use the live
   pane's column/row budget for compact status and transcript output.
3. Remove the structured project-summary block from the rendered governess
   board and add a lower-agent table row from the same snapshot, reserving its
   operational rows ahead of the local-judge/footer budget.
4. Add focused malformed-input, metrics, transcript, and board tests.
5. Run focused and full verification, obtain independent evaluation, integrate
   locally, and refresh only display panes when safe.
