# Task log

- 2026-07-30: Started a planned Harness task in the isolated
  `codex/atomic-global-install` worktree before editing installer code.
- 2026-07-30: Replaced remove-plus-symlink publication with exclusive
  same-directory staging, Unix executable permission, and atomic rename.
- 2026-07-30: Routed Unix and Windows alias generation through the same atomic
  regular-file primitive.
- 2026-07-30: Focused installer tests pass 15/15; full Ultracite and typecheck,
  compile build, and `git diff --check` pass. The real global binary was not
  installed or modified.
- 2026-07-30: The initial independent review dissented on a source validation
  race. The correction holds one validated source file handle through copying,
  rechecks handle/path identity before publication, and never reopens the
  pathname for data.
- 2026-07-30: Added deterministic post-reservation failure cleanup, forced
  collision, source-swap, and simultaneous-writer regressions.
- 2026-07-30: Mechanically normalized the seven pre-existing Loop 102 Harness
  JSON artifacts that blocked the repository lint gate. Full `bun run check`,
  typecheck, build, full `bun run test:ci`, and diff check now pass.
- 2026-07-30: The same independent reviewer re-ran the corrected 15-test file
  and CONCURRED on source binding, exclusive staging, single-rename
  publication, collision ownership, and failure cleanup.
- 2026-07-30: The required root `scripts/verify.sh` release gate passed,
  including full lint, typecheck, build, 1,329 tests, and an empty baseline
  allowlist.
