# Decisions

- Refresh manifest-derived bindings before each tick.
- Never erase a non-empty in-memory binding from an empty or malformed manifest.
- Deploy by replacing only the live governess pane.
- On macOS, deploy the Bun standalone executable by moving a freshly compiled
  inode into place; byte-copying the executable invalidates kernel launch trust.
