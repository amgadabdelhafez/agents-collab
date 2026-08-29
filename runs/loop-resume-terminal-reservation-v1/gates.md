# Gate record — loop-resume-terminal-reservation-v1 (Run 130, corrected successor)

Worktree: `.codex/worktrees/loop-terminal-reservation-v139-repair`
Branch: `codex/loop-terminal-reservation-v139-repair`
Parent SHA: `9347139344d055a0ca938f1750b679a83f67f31b` (`PASS`ed by
`/root/cold_impl_review`, then unfrozen by the live tmux certification failure
on exact legacy Run 61)
Contract SHA: `b0b113394c52bd27d1db7261e16e7c3a9e6a1203` (cold plan review `PASS`)
Base integration SHA: `62e8103d9181bad85012830f8170cca8e21fd0d6`

All seven named commands were run against this tree. Each entry records the
exact command, its exit status, and its own explicit named failure set. A
passing count alone is not accepted as evidence, and no command is marked "not
applicable".

## 1. `bun run test:file -- tests/loop/run-state.test.ts`
- exit status: `0`
- result: `50 pass, 0 fail`
- named failure set: **{} (explicitly empty)**

## 2. `bun run test:file -- tests/loop/launch-reservation.test.ts`
- exit status: `0`
- result: `41 pass, 0 fail`
- named failure set: **{} (explicitly empty)**

## 3. `bun run test:file -- tests/loop/tmux-socket.test.ts`
- exit status: `0`
- result: `51 pass, 0 fail`
- named failure set: **{} (explicitly empty)**

## 4. `bun run test:ci`
- exit status: `0`
- result: 84 test files executed, `1801 pass`, `0 fail`
- named failure set: **{} (explicitly empty)**
- 84 files is the whole suite. The previous run stopped at 82 because
  `test:ci` exits on the first failing file; with the failure closed, the two
  files that sort after it (`tests/test-certification.test.ts`,
  `tests/worktree-reaper.test.ts`) now run inside the gate itself rather than
  being recorded separately.

## 5. `bun run check`
- exit status: `0`
- result: `Checked 845 files in 205ms. No fixes applied.`
- named failure set: **{} (explicitly empty)**

## 6. `bun run build`
- exit status: `0`
- result: `bundle 3054 modules`, `compile loop`
- named failure set: **{} (explicitly empty)**
- the compiled `loop` binary was deleted after the gate. Nothing was installed.

## 7. `git diff --check`
- exit status: `0`
- output: empty
- named failure set: **{} (explicitly empty)**

## Gate verdict

Seven of seven commands exit `0` with an explicitly empty named failure set.
There is no tolerated failure and no baseline allowance.

## What closed the previously non-empty set

`tests/release-packaging.test.ts` › `root release workflow packages the
full-repository Loop layout` asserted `expect(pkg.version).toBe("1.0.35")` while
`loop-fork/package.json` reads `1.0.38`. Provenance, established read-only:
`bf2246f3 2026-08-08 chore: release loop v1.0.38` moved the version, the
assertion has been pinned since `78608327 2026-08-08 chore: release loop
v1.0.35`, and `git merge-base --is-ancestor` reports both as ancestors of the
base integration SHA. Under the supervisor's explicit one-line scope expansion
the assertion reads `"1.0.38"`. That change landed in the parent commit and is
untouched here.

## Delta against the parent gate run

`test:ci` rose from `1796 pass` to `1801 pass` across the same 84 files: five new
cases for the shared-socket runtime-absence defect, all in
`tests/loop/launch-reservation.test.ts` (one positive on exact Run 61, four
negative controls). No test was removed or weakened.
