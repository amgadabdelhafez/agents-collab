# Governess Column Alignment

## Required behavior

- Primary-agent and helper `TOKENS T/I/C/O` columns begin at the same visible
  character position.
- Primary-agent `TEXT/THINK/TOOL` and helper `CALLS/TOOLS` columns begin at the
  same visible character position.
- Helper-only fields before those columns remain meaningful: success/failure,
  active/queued load, context misses, and cost.
- The aligned rows fit a 187-column Governess viewport without losing primary
  agents or helpers.
- Live Loop 57 is updated by restarting only the Governess pane.
