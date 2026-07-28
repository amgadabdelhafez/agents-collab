# Governess Pane Cleanup

## Required behavior

- Primary agents and utility helpers render in separate, purpose-specific
  tables; helper rows do not contain empty primary-agent columns or request IDs.
- Primary-agent headers describe the values actually shown, including total
  token and event subcolumns.
- The two bridge directions are visually grouped without repeating `bridge
  latest` on both rows.
- Worker routing, load, performance, message delivery, context coverage, and
  failures fit into four concise rows at a 187-column viewport.
- Routing reasons use human-readable labels, show only the highest-volume
  causes, and summarize the remaining categories.
- The Governess pane remains the single surface containing the Nanny's full
  model identity, but model telemetry is presented as one health line and one
  runtime line rather than a raw 16-column architecture table.
- Terminal refreshes use the alternate screen so repeated boards do not
  accumulate in pane history.
- Live Loop 57 is updated by restarting only the Governess pane; Claude,
  Codex, Nanny, Au Pair, and dashboard pane processes remain untouched.
