# Gate record — loop-resume-terminal-reservation-v1 (Run 130 implementation)

Worktree: `.codex/worktrees/loop-terminal-reservation-v139-repair`
Branch: `codex/loop-terminal-reservation-v139-repair`
Parent (contract) SHA: `b0b113394c52bd27d1db7261e16e7c3a9e6a1203`
Base integration SHA: `62e8103d9181bad85012830f8170cca8e21fd0d6`

All seven named commands were run. Each entry records the exact command, its
exit status, and its own explicit named failure set. A passing count alone is
not accepted as evidence, and no command is marked "not applicable".

## 1. `bun run test:file -- tests/loop/run-state.test.ts`
- exit status: `0`
- result: `48 pass, 0 fail, 384 expect() calls`
- named failure set: **{} (explicitly empty)**

## 2. `bun run test:file -- tests/loop/launch-reservation.test.ts`
- exit status: `0`
- result: `30 pass, 0 fail, 179 expect() calls`
- named failure set: **{} (explicitly empty)**

## 3. `bun run test:file -- tests/loop/tmux-socket.test.ts`
- exit status: `0`
- result: `51 pass, 0 fail, 137 expect() calls`
- named failure set: **{} (explicitly empty)**

## 4. `bun run test:ci`
- exit status: `1`
- result: 82 test files executed, `1778 pass`, `1 fail`
- named failure set: **NOT empty.** Exactly one named test:
  - `tests/release-packaging.test.ts` ›
    `root release workflow packages the full-repository Loop layout`
  - decisive line: `expect(pkg.version).toBe("1.0.35");` →
    `Expected: "1.0.35"  Received: "1.0.38"`
- inheritance proof (this is not a regression introduced by the candidate):
  - `git show "62e8103d9181bad85012830f8170cca8e21fd0d6:loop-fork/package.json"`
    → `"version": "1.0.38"`
  - `git show "62e8103d9181bad85012830f8170cca8e21fd0d6:loop-fork/tests/release-packaging.test.ts"`
    line 16 → `expect(pkg.version).toBe("1.0.35");`
  - identical at `b0b11339`.
  - `git diff --name-only HEAD -- loop-fork/package.json .github/workflows/release.yml loop-fork/tests/release-packaging.test.ts`
    → 0 lines. The failing test reads only `package.json` and
    `.github/workflows/release.yml`; the candidate touches neither.
  - both implicated paths are **outside** the write allowlist in
    `specs/loop-resume-terminal-reservation-v1/verify.md`, so the writer cannot
    close this failure under the current authority.
- `test:ci` stops at the first failing file, so the two files sorting after it
  were run separately and are recorded here rather than assumed:
  - `tests/test-certification.test.ts` → `1 pass, 0 fail`
  - `tests/worktree-reaper.test.ts` → `8 pass, 0 fail`

## 5. `bun run check`
- exit status: `0`
- result: `Checked 845 files in 232ms. No fixes applied.`
- named failure set: **{} (explicitly empty)**

## 6. `bun run build`
- exit status: `0`
- result: `bundle 3054 modules`, `compile loop`
- named failure set: **{} (explicitly empty)**
- the compiled `loop` binary was removed after the gate; it is not committed and
  no installation was performed.

## 7. `git diff --check`
- exit status: `0`
- output: empty
- named failure set: **{} (explicitly empty)**

## Gate verdict

Six of the seven commands have an explicitly empty named failure set. `test:ci`
does not. Its failure set is exactly one named, provably inherited test whose
two implicated files are outside this candidate's write authority.
`verify.md` states "No tolerated failure or baseline allowance", so the writer
does **not** self-authorize this exception; it is recorded here and escalated.
