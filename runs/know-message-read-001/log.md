# KNOW-MESSAGE-READ-001 log

- 2026-08-30T06:03:00Z: Created isolated branch
  `codex/know-message-read-001` from accepted `COMM-ATTN-001` closure
  `14b36203f5f562519606d2dba98e0904d30faceb` and bound the final durable
  knowledge artifact reader before source changes.
- 2026-08-30T06:05:55Z: Added the v2 nominal-store knowledge reader on top of
  the accepted durable artifact projector and marked the in-memory v1 projector
  compatibility-only. Focused gate passed 7/0 with 24 assertions. One full
  `bun run test:ci`, `bun run check`, `bun run build`, and `git diff --check`
  passed with an empty named failure set. The compatible ignored dependency
  symlink was removed at gate exit.
