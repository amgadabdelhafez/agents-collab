# Worker pane cleanup

## Goal

Make the lower-right pane an output-only worker activity stream and move its
aggregate routing, usage, token, and cost telemetry into the governess pane.

## Requirements

- Keep the existing tmux pane geometry and internal `utility-*` compatibility.
- Use `worker` for all user-facing lower-agent labels.
- Title the pane `worker.<tmux-session>`.
- Remove static initial/current role text from the governess summary.
- Remove the obsolete `llm params` and `judge consensus` footer labels while
  retaining temperature and output-token limits.
- Add two width-bounded governess rows for worker totals and routing decisions,
  including considered, routed, skipped, and skipped-reason counts.
- Render only timestamped request, tool, and response activity in the worker
  pane, with semantic color and no duplicated aggregate statistics.

