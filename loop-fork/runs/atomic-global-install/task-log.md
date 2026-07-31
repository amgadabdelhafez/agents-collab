# Task atomic-global-install

Created: 2026-07-31T03:59:30Z
Mode: planned
Description: Replace mutable symlink global installs with fail-closed atomic regular-file copies

## What I changed

- Replaced remove-plus-symlink publication with same-directory exclusive
  staging and atomic rename.
- Applied the same regular-file publication primitive to all aliases.
- Added focused temp-directory regression coverage without touching the real
  install directory.

## Why

Rebuilding the source worktree must not mutate a globally installed executable,
and replacement must not remove the working target before its successor is
ready.

## Notes

- Focused tests: 15 pass, 0 fail.
- Full Ultracite, typecheck, build, full test suite, and diff check pass after
  mechanically normalizing seven pre-existing Loop 102 Harness JSON artifacts.
- The initial independent DISSENT found a source-path TOCTOU race. The corrected
  implementation binds validation and copying to one held file handle and is
  covered by a same-reviewer CONCUR on the corrected exact code and tests.
- Root `scripts/verify.sh` release gate passed with full check, typecheck,
  build, 1,329 tests, and an empty baseline allowlist.

Regression: yes
Regression id: mutable-global-install-symlink
Regression symptom: Rebuilding the source worktree mutates the globally installed executable, and reinstalling first removes the live target.
Regression guard: `bun run test:file -- tests/install.test.ts`
