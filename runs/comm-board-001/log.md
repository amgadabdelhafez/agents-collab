# COMM-BOARD-001 log

- 2026-08-30T07:18:00Z: Completion audit rejected the prior in-memory combined
  board as insufficient for the exact durable-thread requirement. Created
  isolated branch `codex/comm-board-001` from cumulative closure
  `3551e087802762505de7678df4f9b845ed3ea676` and bound the exact missing
  persistence contract before source changes.
- 2026-08-30T07:25:00Z: Exported strict canonical board-item parsing and added
  an append-only thread journal. Each bounded event is opened with no-follow,
  written through an owned descriptor, fsynced before success, and read back
  with exact schema validation. Stable request IDs replay exactly; collisions,
  duplicate durable IDs, and immutable identity changes refuse.
- 2026-08-30T07:29:00Z: Focused gate PASS 5/0 with 28 assertions covering
  restart reconstruction, on-disk newline/mode, replay/collision, lifecycle
  updates, immutable identity, malformed/truncated/duplicate/extra-field rows,
  missing journal, defensive snapshots, and forbidden-field absence.
- 2026-08-30T07:33:00Z: One full `bun run test:ci`, exact-config check, build,
  and `git diff --check` PASSed with empty named failure sets. Static findings
  were cleared before the full run. The byte-compatible temporary dependency
  symlink was removed after every gate.
