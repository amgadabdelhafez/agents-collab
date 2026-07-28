# Recon Pane Signal Density

## Required behavior

- The `routes`, `tools`, and `results` panes show one concise row per useful
  event without request IDs or internal transport wrappers.
- Repeated equivalent tool events are collapsed into one row with a count.
- Pending bridge results appear once and name the recipient without repeating
  the same completed job below them.
- Result rows extract a short human-readable finding from direct-tool payloads
  instead of showing serialized JSON or Markdown wrappers.
- Refreshes replace the current dashboard frame without accumulating duplicate
  snapshots in pane history.
- Counts, failures, route destinations, objectives, recipients, and meaningful
  result text remain visible.
- With all three dashboards enabled, the bottom row gives routes about 45%,
  tools about 20%, and results about 35% of the width.
- Updating live Loop 57 must not restart Claude, Codex, Governess, Nanny, or Au
  Pair.
