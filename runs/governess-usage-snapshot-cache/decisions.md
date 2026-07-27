# Decisions

- Reuse the existing cached/bundled pricing catalog resolution.
- Do not cache or fabricate quota percentages during an unavailable tracker tick.
- Do not mask missing credentials or exhausted authentication failures.
- Deploy by moving a freshly compiled Bun executable inode into place and
  respawning only the governess pane.
