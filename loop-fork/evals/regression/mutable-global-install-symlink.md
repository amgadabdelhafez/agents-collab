# Regression Eval: mutable-global-install-symlink

Generated: 2026-07-31T04:24:34Z
Source task: `atomic-global-install`
Status: draft

## Failure Symptom

- Rebuilding the source worktree mutates the globally installed executable, and reinstalling first removes the live target.

## Guard Evidence

- `bun run test:file -- tests/install.test.ts`

## Verification Artifacts

- `full`: `runs/atomic-global-install/artifacts/full/verify.log` (pass)
- `release`: `runs/atomic-global-install/artifacts/release/verify.log` (pass)
- `unit`: `runs/atomic-global-install/artifacts/unit/verify.log` (pass)

## Source Task Notes

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

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.
